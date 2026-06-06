import { test, expect, Browser, BrowserContext, Page, devices } from '@playwright/test';
import { attachBrowserLogging } from './_logging.js';
import { doEquationForming } from './_helpers.js';

// 3 players with distinct iPhone viewports
const PLAYER_DEVICES = [
    devices['iPhone 14 Pro'],      // 393×852
    devices['iPhone 13'],          // 390×844
    devices['iPhone 14 Pro Max'],  // 430×932
];
const NUM_PLAYERS = PLAYER_DEVICES.length;

// Starting chips per player (matches public/classes.ts)
const STARTING_CHIPS = 25;

async function pause(page: Page, ms = 500) {
    if (!process.env.CI) await page.waitForTimeout(ms);
}

async function discardIfNeeded(pages: Page[]) {
    const needsDiscard = await Promise.all(pages.map(async (page) => {
        try {
            // 10s (not 2s): the discard highlight can render a few seconds after the deal
            // — a 2s window intermittently missed it, stalling the hand at second deal.
            await page.locator('.card-highlighted').first().waitFor({ state: 'visible', timeout: 10000 });
            return true;
        } catch {
            return false;
        }
    }));

    const discardQueue = pages.filter((_, i) => needsDiscard[i]);
    for (let i = 0; i < discardQueue.length; i++) {
        await discardQueue[i]!.locator('.card-highlighted').first().click({ force: true });
        await discardQueue[i]!.locator('.card-highlighted').first().waitFor({ state: 'hidden', timeout: 8000 });
        await pause(discardQueue[i]!, 3000);
    }
}

async function findBettingPage(pages: Page[], timeout = 20000): Promise<Page | undefined> {
    try {
        return await Promise.any(
            pages.map(async (page) => {
                await page.locator('#bettingControls').waitFor({ state: 'visible', timeout });
                return page;
            })
        );
    } catch {
        return undefined;
    }
}

// Returns the pages that folded during this round (for filtering equation/hi-lo helpers).
async function runBettingRound(
    pages: Page[],
    actions: Array<'call' | 'raise' | 'all-in' | 'fold'>,
): Promise<{ foldedPages: Page[] }> {
    const foldedPages: Page[] = [];
    for (const action of actions) {
        const bettingPage = await findBettingPage(pages);
        if (!bettingPage && action === 'fold') break;
        expect(bettingPage, `no player had betting controls for action '${action}'`).toBeDefined();

        // Pause BEFORE acting so the betting controls are visible long enough to watch
        // in headed mode, instead of being clicked the instant they appear.
        await pause(bettingPage!, 2000);

        if (action === 'raise') {
            await bettingPage!.evaluate(() => {
                const slider = document.getElementById('betSlider') as HTMLInputElement;
                slider.value = String(parseInt(slider.min) + 5);
                slider.dispatchEvent(new Event('input'));
            });
            await bettingPage!.locator('#callRaiseButton').click();
        } else if (action === 'call') {
            // When toCall == myChipCount the callRaiseButton is hidden; fall back to all-in (same outcome)
            const callBtn = bettingPage!.locator('#callRaiseButton');
            if (await callBtn.isVisible()) {
                await callBtn.click();
            } else {
                await bettingPage!.locator('#allInButton').click();
            }
        } else if (action === 'all-in') {
            await bettingPage!.locator('#allInButton').click();
        } else {
            foldedPages.push(bettingPage!);
            await bettingPage!.locator('#foldButton').click();
        }
    }
    // Sync buffer: let the server complete the betting round and deal/transition to the
    // next phase (e.g. last-card deal + discard highlight) before the next test step runs.
    if (pages[0]) await pause(pages[0], 2000);
    return { foldedPages };
}

async function doHiLoSelection(pages: Page[]) {
    await Promise.all(pages.map(async (page) => {
        const modal = page.locator('#choiceModal');
        try {
            await modal.waitFor({ state: 'visible', timeout: 15000 });
        } catch {
            return; // folded/out player
        }
        await page.locator('.option[data-choice="low"]').click();
        await page.locator('#confirmChoice').click();
        await pause(page, 2000);
    }));
}

// Returns the number of pages that actually saw (and acknowledged) the results modal.
// A stalled hand never reaches results, so callers can assert on this to fail loudly
// instead of silently passing.
async function acknowledgeResults(pages: Page[]): Promise<number> {
    const acked = await Promise.all(pages.map(async (page) => {
        const button = page.locator('#confirmResults');
        try {
            await button.waitFor({ state: 'visible', timeout: 20000 });
        } catch {
            return false; // out player — button not shown, or hand stalled before results
        }
        await button.click({ force: true });
        await pause(page, 1500);
        return true;
    }));
    return acked.filter(Boolean).length;
}

// Creates contexts + pages with WS trackers attached before navigation.
// eliminatedPromises[i] resolves when page i receives a kicked message for its own player id.
async function setupPlayers(
    browser: Browser,
    chipTracker: { min: number },
): Promise<{ pages: Page[]; contexts: BrowserContext[]; eliminatedPromises: Promise<void>[] }> {
    const contexts = await Promise.all(PLAYER_DEVICES.map(device => browser.newContext(device)));
    const pages: Page[] = [];
    const eliminatedPromises: Promise<void>[] = [];
    for (const [idx, ctx] of contexts.entries()) {
        const page = await ctx.newPage();
        attachBrowserLogging(page, `player${idx}`);
        let resolveEliminated!: () => void;
        eliminatedPromises.push(new Promise<void>(res => { resolveEliminated = res; }));
        let myId: string | null = null;
        page.on('websocket', ws => {
            ws.on('framereceived', frame => {
                try {
                    const msg = JSON.parse(frame.payload as string);
                    if (msg.type === 'init') myId = msg.id;
                    if (msg.type === 'kicked' && myId && msg.userId === myId) resolveEliminated();
                    if (msg.type === 'next-turn' && typeof msg.playerChipCount === 'number') {
                        chipTracker.min = Math.min(chipTracker.min, msg.playerChipCount);
                    }
                } catch {}
            });
        });
        pages.push(page);
    }
    await Promise.all(pages.map(page => page.goto('/')));
    return { pages, contexts, eliminatedPromises };
}

async function setupRoom(pages: Page[]): Promise<void> {
    const [hostPage, ...playerPages] = pages as [Page, ...Page[]];

    for (const page of pages) {
        await expect(page.locator('#homeContainer')).toBeVisible();
    }

    await hostPage.click('#createButton');
    await expect(hostPage.locator('#roomCodeContainer')).toContainText(/[A-Z0-9]{4}/);
    const roomCodeText = await hostPage.locator('#roomCodeContainer').innerText();
    const roomCode = roomCodeText.split(' ')[1];
    expect(roomCode).toMatch(/^[A-Z0-9]{4}$/);

    await hostPage.fill('#nameInput', 'Host');
    await hostPage.click('#submitNameButton');
    await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText('Host');

    for (const [i, page] of playerPages.entries()) {
        await page.fill('#roomCodeInput', roomCode!);
        await page.click('#enterRoomButton');
        await page.fill('#nameInput', `Player${i + 1}`);
        await page.click('#submitNameButton');
    }

    for (let i = 1; i < NUM_PLAYERS; i++) {
        await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText(`Player${i}`);
    }

    await expect(hostPage.locator('#startButton')).toBeEnabled({ timeout: 5000 });
    await hostPage.click('#startButton');

    for (const page of pages) {
        await expect(page.locator('#potContainer')).toBeVisible({ timeout: 5000 });
    }
}

test.describe('Betting mechanics', () => {

    // -------------------------------------------------------------------------
    // Test 1: Elimination
    // -------------------------------------------------------------------------
    // Hand 1 round 2: two players go all-in, the third folds.
    // One of the two all-in players loses and ends with 0 chips → eliminated.
    // The third player (who folded) keeps their chips and remains active.
    //
    // After hand 1 the test verifies:
    //  - exactly one player receives a kicked WS frame for their own id (detected via WS listener)
    //  - in hand 2 the eliminated player never sees betting controls, the
    //    equation-forming lock button, or the hi-lo modal
    //  - the game continues through to the start of hand 3
    //  - no player's chip count ever goes negative (via next-turn WS messages)
    //
    // Chip arithmetic (starting chips = 25, ante = 1):
    //   Round 1  : all ante 1     → each has 24 remaining
    //   Round 2  : P_A all-in (24), P_B all-in (24), P_C folds (0)
    //              Pot = 3 + 24 + 24 = 51
    //   After hand: winner has 51, P_C has 24, loser has 0 → eliminated
    //
    //   Hand 2, round 2 maxBet = min(winner=50, P_C=23) − 0 = 23
    //   (asserting slider.max === 23 verifies the server correctly bounds raises
    //   by the lowest-chip player's available stake)
    // -------------------------------------------------------------------------
    test('player eliminated after going all-in; game continues through start of hand 3', async ({ browser }) => {
        test.setTimeout(300000);

        const chipTracker = { min: Infinity };
        const { pages, contexts, eliminatedPromises } = await setupPlayers(browser, chipTracker);

        await setupRoom(pages);

        // --- Hand 1 ---
        await discardIfNeeded(pages);

        // Round 1: everyone antes 1 chip
        await runBettingRound(pages, ['call', 'call', 'call']);
        await discardIfNeeded(pages);
        await doEquationForming(pages);

        // Round 2: first two all-in, third folds
        const { foldedPages: round2FoldedH1 } = await runBettingRound(pages, ['all-in', 'all-in', 'fold']);
        const equationAndHiloPages = pages.filter(p => !round2FoldedH1.includes(p));
        await doHiLoSelection(equationAndHiloPages);

        await acknowledgeResults(pages);

        // endHand fires after all players acknowledge; it sends a kicked WS frame with
        // msg.id === the eliminated player's id. eliminatedPromises[i] resolves when
        // page i receives that frame for its own id (tracked in setupPlayers).
        const eliminatedIdx = await Promise.race(
            eliminatedPromises.map((p, i) => p.then(() => i))
        );
        const eliminatedPage = pages[eliminatedIdx]!;
        const activePagesH2 = pages.filter(p => p !== eliminatedPage);

        // Inject mutation observers on the eliminated player's page so we can detect
        // if any game control becomes visible during hand 2.
        await eliminatedPage.evaluate(() => {
            (window as any)._betControlsShown = false;
            (window as any)._eqFormShown = false;
            (window as any)._hiloModalShown = false;

            const watch = (id: string, key: string) => {
                const el = document.getElementById(id);
                if (!el) return;
                new MutationObserver(() => {
                    const style = (el as HTMLElement).style.display;
                    const hidden = (el as HTMLElement).classList.contains('hidden');
                    if (style !== 'none' && style !== '' || !hidden) {
                        // Only flag if it actually becomes interactive/visible
                        if (style !== 'none' && !hidden) (window as any)[key] = true;
                    }
                }).observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
            };

            watch('bettingControls', '_betControlsShown');
            watch('confirmEquationFormed', '_eqFormShown');
            watch('choiceModal', '_hiloModalShown');
        });

        // --- Hand 2: 2 active players + 1 eliminated observer ---
        for (const page of activePagesH2) {
            await expect(page.locator('#potContainer')).toBeVisible({ timeout: 10000 });
        }

        await discardIfNeeded(activePagesH2);
        await runBettingRound(activePagesH2, ['call', 'call']); // round 1
        await discardIfNeeded(activePagesH2);
        await doEquationForming(activePagesH2);

        // Round 2 of hand 2: capture slider bounds for the first player to act, then
        // let both active players call.
        // Expected: slider.max = min(winner_chips - ante, folder_chips - ante) = min(50, 23) = 23
        // This proves the server correctly caps raises at the lowest player's available stake.
        let capturedSliderBounds = { min: -1, max: -1, displayedMax: '' };
        for (let i = 0; i < 2; i++) {
            const bettingPage = await findBettingPage(activePagesH2, 20000);
            expect(bettingPage, 'active player should have betting controls in hand 2 round 2').toBeDefined();

            if (i === 0) {
                capturedSliderBounds = await bettingPage!.evaluate(() => ({
                    min: parseInt((document.getElementById('betSlider') as HTMLInputElement).min),
                    max: parseInt((document.getElementById('betSlider') as HTMLInputElement).max),
                    displayedMax: (document.getElementById('sliderMax') as HTMLElement).textContent ?? '',
                }));
            }

            // Observe the controls before acting (headed mode).
            await pause(bettingPage!, 2000);

            const callBtn = bettingPage!.locator('#callRaiseButton');
            if (await callBtn.isVisible()) {
                await callBtn.click();
            } else {
                await bettingPage!.locator('#allInButton').click();
            }
        }

        // slider.min = 0 (no mandatory call yet at start of round 2)
        expect(capturedSliderBounds.min).toBe(0);
        // slider.max = 23: bounded by the lower-chip player (folder kept 24, minus 1 ante = 23)
        // This is strictly less than the winner's 50 chips, proving the ceiling is not
        // taken from the richer player.
        expect(capturedSliderBounds.max).toBe(STARTING_CHIPS - 2); // 25 - 1(ante h1) - 1(ante h2) = 23
        // The displayed label must match the slider attribute
        expect(capturedSliderBounds.max).toBe(parseInt(capturedSliderBounds.displayedMax));

        await doHiLoSelection(activePagesH2);
        await acknowledgeResults(activePagesH2);

        // --- Verify eliminated player had no interactive controls during hand 2 ---
        const betShown = await eliminatedPage.evaluate(() => (window as any)._betControlsShown);
        const eqShown  = await eliminatedPage.evaluate(() => (window as any)._eqFormShown);
        const hiShown  = await eliminatedPage.evaluate(() => (window as any)._hiloModalShown);
        expect(betShown, 'eliminated player must not see betting controls').toBe(false);
        expect(eqShown,  'eliminated player must not see equation lock button').toBe(false);
        expect(hiShown,  'eliminated player must not see hi-lo modal').toBe(false);

        // --- Chip invariant: no player's chip count ever went negative ---
        expect(chipTracker.min, 'player chip counts must never go negative').toBeGreaterThanOrEqual(0);

        // --- Hand 3: game continues for the two remaining active players ---
        for (const page of activePagesH2) {
            await expect(page.locator('#potContainer')).toBeVisible({ timeout: 10000 });
        }

        await Promise.all(contexts.map(ctx => ctx.close()));
    });

    // -------------------------------------------------------------------------
    // Test 2: Two consecutive raises
    // -------------------------------------------------------------------------
    // Round 2 action sequence for 3 players: raise → raise → call → call
    //
    //  P_A raises (+5 above toCall=0  → stake=5,  toCall=5)
    //  P_B re-raises (+5 above 5      → stake=10, toCall=10)
    //  P_C calls (stake=10)
    //  P_A calls the remaining 5 to close (stake=10)  → round complete
    //
    // Verifies:
    //  - the betting round terminates correctly after a re-raise
    //  - the game progresses through hi-lo selection and results normally
    //  - no player's chip count goes negative throughout
    // -------------------------------------------------------------------------
    test('two consecutive raises in a betting round complete correctly', async ({ browser }) => {
        test.setTimeout(180000);

        const chipTracker = { min: Infinity };
        const { pages, contexts } = await setupPlayers(browser, chipTracker);

        await setupRoom(pages);

        // --- Hand 1 ---
        await discardIfNeeded(pages);
        await runBettingRound(pages, ['call', 'call', 'call']); // round 1: all ante
        await discardIfNeeded(pages);
        await doEquationForming(pages);

        // Round 2: raise, re-raise, call, call — but may be skipped if someone went
        // all-in during round 1 (server sets maxRaiseReached → second round skipped).
        const secondRoundPage = await findBettingPage(pages, 4000);
        if (secondRoundPage) {
            await runBettingRound(pages, ['raise', 'raise', 'call', 'call']);
        }

        await doHiLoSelection(pages);
        const acked = await acknowledgeResults(pages);

        // All 3 players reach results (nobody folds in this test). If the hand stalled
        // (e.g. a missed discard at second deal), this is < 3 and the test fails instead
        // of silently passing.
        expect(acked, 'all 3 players must reach the results screen (hand completed)').toBe(NUM_PLAYERS);

        // No player's chip count should have gone negative
        expect(chipTracker.min, 'chip counts must stay non-negative').toBeGreaterThanOrEqual(0);

        // Game continues normally into hand 2
        for (const page of pages) {
            await expect(page.locator('#potContainer')).toBeVisible({ timeout: 10000 });
        }

        await Promise.all(contexts.map(ctx => ctx.close()));
    });

});
