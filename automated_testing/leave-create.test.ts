import { test, expect, Browser, BrowserContext, Page, devices } from '@playwright/test';
import { attachBrowserLogging } from './_logging.js';
import { discardIfNeeded, doEquationForming, acknowledgeResults } from './_helpers.js';

// 4 distinct iPhone viewports: 3 players start in the old room, the 4th joins the new room.
const PLAYER_DEVICES = [
    devices['iPhone 14 Pro'],
    devices['iPhone 13'],
    devices['iPhone 14 Pro Max'],
    devices['iPhone 15 Pro'],
];

async function pause(page: Page, ms = 1500) {
    if (!process.env.CI) await page.waitForTimeout(ms);
}

// Click the lobby "copy invite link" button on a host's page and return the copied URL. We wait
// for the button to swap to its checkmark first: that only happens after clipboard.writeText
// resolves, so it doubles as a guard against reading a stale clipboard value. Requires the
// context to hold clipboard-read/-write permissions (granted below).
async function copyInviteUrl(hostPage: Page): Promise<string> {
    await expect(hostPage.locator('#shareLinkContainer')).toBeVisible();
    await hostPage.click('#copyLinkButton');
    await expect(hostPage.locator('#copiedIcon')).toBeVisible();
    const url = await hostPage.evaluate(() => navigator.clipboard.readText());
    expect(url, 'copied invite link should end in a 4-char room code').toMatch(/\/[A-Z0-9]{4}$/);
    return url;
}

// Once inside a room the home screen's scrolling card-grid background must be gone — both the
// grid element (display:none via .hidden) and the body class that animates it. Regression guard
// for players who arrive via a room link (that path skips the create/enter button handlers).
async function expectNoHomeBackground(page: Page) {
    await expect(page.locator('#grid-container')).toBeHidden();
    expect(await page.evaluate(() => document.body.classList.contains('show-home-bg'))).toBe(false);
}

// Drive the current betting round to completion: whoever holds the controls just calls (all-in
// if calling needs the full stack), until no one has controls within the window — i.e. the round
// closed and the game advanced to the next phase. (Mirrors reconnect.test.ts.)
async function finishBettingRound(pages: Page[]) {
    for (let guard = 0; guard < 20; guard++) {
        const bettingPage = await Promise.any(
            pages.map(async (p) => {
                await p.locator('#bettingControls').waitFor({ state: 'visible', timeout: 4000 });
                return p;
            }),
        ).catch(() => undefined);
        if (!bettingPage) return;

        const callBtn = bettingPage.locator('#callRaiseButton');
        if (await callBtn.isVisible()) await callBtn.click();
        else await bettingPage.locator('#allInButton').click();
        await pages[0]!.waitForTimeout(800);
    }
}

// Every non-folded player selects Low and confirms (folded/out players have no modal).
async function doHiLoSelection(pages: Page[]) {
    await Promise.all(pages.map(async (page) => {
        const modal = page.locator('#choiceModal');
        try {
            await modal.waitFor({ state: 'visible', timeout: 20000 });
        } catch {
            return; // folded/out player — modal not shown
        }
        await page.locator('.option[data-choice="low"]').click({ force: true });
        await page.locator('#confirmChoice').click({ force: true });
        await pause(page, 1000);
    }));
}

// Play a hand that is currently sitting in FIRST betting (first-deal discards already done).
async function finishHandFromFirstBetting(pages: Page[]): Promise<number> {
    await finishBettingRound(pages);                 // first betting
    await pause(pages[0]!, 2000);
    await discardIfNeeded(pages);                    // second deal
    await doEquationForming(pages);
    await finishBettingRound(pages);                 // second betting (skipped if all-in earlier)
    await pause(pages[0]!, 2000);
    await doHiLoSelection(pages);
    await pause(pages[0]!, 3000);
    return acknowledgeResults(pages);
}

// Play a fresh hand from the very start of FIRSTDEAL through the results screen.
async function playFreshHand(pages: Page[]): Promise<number> {
    await discardIfNeeded(pages);                    // first deal
    return finishHandFromFirstBetting(pages);
}

test.describe('Create New Game while still seated in another room', () => {
    test('leaving via "New Game" folds you out of the old room; old + new games play on independently', async ({ browser }) => {
        test.setTimeout(300000);

        // Per-page capture of every player-folded id, so we can prove the leaver was folded out of
        // the OLD room. page.on('websocket') only fires for sockets opened AFTER it's attached, so
        // we wire it before goto() to catch each page's first (and only) socket.
        const foldedIds = new Map<Page, string[]>();
        // Per-page capture of every `kicked` id too: leaving for a new game marks you OUT (not
        // just folded), broadcast to the old room as a `kicked` (note: that message keys the id
        // under `userId`, unlike `player-folded` which uses `id`).
        const kickedIds = new Map<Page, string[]>();

        const contexts: BrowserContext[] = [];
        const pages: Page[] = [];
        for (let i = 0; i < 3; i++) {
            const ctx = await browser.newContext({ ...PLAYER_DEVICES[i]!, permissions: ['clipboard-read', 'clipboard-write'] });
            const page = await ctx.newPage();
            attachBrowserLogging(page, `player${i}`);
            const folds: string[] = [];
            foldedIds.set(page, folds);
            const kicks: string[] = [];
            kickedIds.set(page, kicks);
            page.on('websocket', ws => ws.on('framereceived', f => {
                try {
                    const m = JSON.parse(f.payload as string);
                    if (m.type === 'player-folded') folds.push(m.id);
                    if (m.type === 'kicked') kicks.push(m.userId);
                } catch {}
            }));
            contexts.push(ctx);
            pages.push(page);
        }
        await Promise.all(pages.map(p => p.goto('/')));

        const [host, p1, p2] = pages as [Page, Page, Page];

        // --- Lobby + start (host creates, p1/p2 join) ---
        await host.click('#createButton');
        await expect(host.locator('#roomCodeContainer')).toContainText(/[A-Z0-9]{4}/);
        const oldRoomCode = (await host.locator('#roomCodeContainer').innerText()).split(' ')[1]!;
        // Grab the shareable invite link from the host's copy button and confirm it carries the
        // room code. p1/p2 will join by navigating to it rather than typing the code.
        const oldRoomUrl = await copyInviteUrl(host);
        expect(oldRoomUrl).toContain(`/${oldRoomCode}`);
        await expectNoHomeBackground(host);
        await host.fill('#nameInput', 'Host');
        await host.click('#submitNameButton');
        await expect(host.locator('#lobbyPlayerListContainer')).toContainText('Host');

        for (const [i, p] of [p1, p2].entries()) {
            await p.goto(oldRoomUrl);            // join via the shared invite link, not the code field
            await p.fill('#nameInput', `Player${i + 1}`);
            await p.click('#submitNameButton');
            await expectNoHomeBackground(p);     // URL-join must still tear down the home grid background
        }
        await expect(host.locator('#startButton')).toBeEnabled({ timeout: 5000 });
        await host.click('#startButton');
        for (const p of pages) await expect(p.locator('#potContainer')).toBeVisible({ timeout: 10000 });

        // p2's persistent id — used to match the player-folded the old room broadcasts when p2 leaves.
        const p2Id = await p2.evaluate(() => localStorage.getItem('userId'));
        expect(p2Id).toBeTruthy();

        // --- First-deal discards for all 3, then confirm we've reached FIRST betting. ---
        await discardIfNeeded(pages);
        await Promise.any(pages.map(p => p.locator('#bettingControls').waitFor({ state: 'visible', timeout: 20000 })));

        // --- p2 abandons the old room by REFRESHING and choosing "New Game" instead of "Rejoin". ---
        await p2.reload();
        // The refresh triggers the server's rejoin suggestion (proves the socket is open and the
        // server still has p2's old-room record). Our change keeps the "New Game" button visible here.
        await expect(p2.locator('#roomCodeInfo')).toHaveText('Rejoin game in progress:', { timeout: 15000 });
        await expect(p2.locator('#createButton')).toBeVisible();
        await p2.click('#createButton');
        await p2.fill('#nameInput', 'NewHost');
        await p2.click('#submitNameButton');

        // p2 is now host of a brand-new room with a different code.
        await expect(p2.locator('#roomCodeContainer')).toContainText(/Room [A-Z0-9]{4}/, { timeout: 10000 });
        const newRoomCode = (await p2.locator('#roomCodeContainer').innerText()).split(' ')[1]!;
        expect(newRoomCode, 'the new room must be a different room from the old one').not.toBe(oldRoomCode);
        // The second host copies its own invite link; D will join the new room by navigating to it.
        const newRoomUrl = await copyInviteUrl(p2);
        expect(newRoomUrl).toContain(`/${newRoomCode}`);
        expect(newRoomUrl).not.toBe(oldRoomUrl);
        await expectNoHomeBackground(p2);

        // --- Proof p2 was folded OUT of the old room: the old room broadcast a player-folded for
        //     p2's id (seen on the host's socket). ---
        await expect
            .poll(() => foldedIds.get(host)!.includes(p2Id!), {
                message: 'old room should broadcast player-folded for the leaver',
                timeout: 15000,
            })
            .toBe(true);

        // --- And proof the leaver is OUT, not merely folded: the old room broadcasts a `kicked`
        //     for p2's id so the remaining players render them eliminated (the fix that makes
        //     leaving for a new game mark you out instead of just folding). ---
        await expect
            .poll(() => kickedIds.get(host)!.includes(p2Id!), {
                message: 'old room should broadcast kicked (out) for the leaver',
                timeout: 15000,
            })
            .toBe(true);

        // --- NEW GAME: a brand-new player joins p2's room AS SOON AS it's created (the old game is
        //     still mid-hand, paused on a betting turn — both rooms are now alive at once). ---
        const dCtx = await browser.newContext({ ...PLAYER_DEVICES[3]!, permissions: ['clipboard-read', 'clipboard-write'] });
        const dPage = await dCtx.newPage();
        attachBrowserLogging(dPage, 'playerD');
        await dPage.goto(newRoomUrl);            // join the new room via its shared invite link
        await dPage.fill('#nameInput', 'D');
        await dPage.click('#submitNameButton');
        await expectNoHomeBackground(dPage);     // URL-join must still tear down the home grid background

        // The new host sees D land in the lobby (proves the new room's host/membership is sane),
        // then starts the new game.
        await expect(p2.locator('#lobbyPlayerListContainer')).toContainText('D', { timeout: 10000 });
        await expect(p2.locator('#startButton')).toBeEnabled({ timeout: 10000 });
        await p2.click('#startButton');
        const newGame = [p2, dPage];
        for (const p of newGame) await expect(p.locator('#potContainer')).toBeVisible({ timeout: 10000 });

        // --- OLD GAME proceeds normally with the two REMAINING players through a full hand, even
        //     though the new game is now running in parallel. ---
        const oldRemaining = [host, p1];
        const ackedOld1 = await finishHandFromFirstBetting(oldRemaining);
        expect(ackedOld1, 'both remaining old-room players should reach the results screen').toBe(2);
        // And the old room loops into its next hand — it kept running past the departure.
        for (const p of oldRemaining) await expect(p.locator('#potContainer')).toBeVisible({ timeout: 15000 });

        // --- NEW GAME plays a full hand of its own. ---
        const ackedNew = await playFreshHand(newGame);
        expect(ackedNew, 'both new-room players should reach the results screen').toBe(2);

        // --- INDEPENDENCE: with the new game having played a full hand, the OLD game is still fully
        //     alive and unaffected — it can play ANOTHER complete hand on its own. ---
        const ackedOld2 = await playFreshHand(oldRemaining);
        expect(ackedOld2, 'the old room should still complete a hand after the new game ran').toBe(2);

        // The two rooms never converged: the old room kept its original code, distinct from the new one.
        await expect(host.locator('#roomCodeContainer')).toContainText(`Room ${oldRoomCode}`);
        expect(oldRoomCode).not.toBe(newRoomCode);

        await Promise.all([...contexts, dCtx].map(ctx => ctx.close()));
    });
});
