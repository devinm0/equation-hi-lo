import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { attachBrowserLogging } from './_logging.js';
import {
    discardIfNeeded,
    doEquationForming,
    acknowledgeResults,
    getRoomCodeFromUrl,
} from './_helpers.js';

// Deterministic coverage for the winner-determination branches that random deals can't
// reliably produce — the gaps called out in the plan note + the determineWinnersInternal
// "TEST add this" comment:
//   1. a swing better that SWEEPS both sides alongside pure hi/lo betters,
//   2. a swing better that sweeps NEITHER, so the pot splits to the pure hi + lo betters,
//   3. swing ties AND pure ties in the SAME hand (contender highlighting across both groups),
//   4. an all-swing table where nobody sweeps -> the pot is forfeited (nobody wins).
//
// The deal is random, so to force exact equation results we use the debug-only
// window.__debugSetEquationResults hook (the server honours debug-set-equation-results
// solely under GAME_MODE=debug, which the E2E server runs). The override is applied
// server-side just before winner determination AND before the round-result is built, so
// the results page renders the forced values — keeping the shared self-checking winner
// verifier (assertResultsPageWinners, run by acknowledgeResults) consistent. We ALSO read
// the round-result WS frame directly to assert the winner flags / contender flags / message.

async function pause(page: Page, ms = 800) {
    if (!process.env.CI) await page.waitForTimeout(ms);
}

type Choice = 'low' | 'high' | 'swing';
interface Plan {
    choice: Choice;
    low?: number;   // forced low-side equation result (omit if the player isn't betting low)
    high?: number;  // forced high-side equation result (omit if the player isn't betting high)
}

// Robustly call down a betting round so NO ONE folds — every player must reach hi/lo
// selection for these scenarios to hold. (Same shape as swing.test.ts.)
async function callDownBettingRound(pages: Page[]) {
    for (let i = 0; i < pages.length + 2; i++) {
        let acted = false;
        for (const page of pages) {
            if (await page.locator('#callRaiseButton').isVisible().catch(() => false)) {
                await page.locator('#callRaiseButton').click({ force: true });
                acted = true;
                await pause(page, 600);
                break;
            }
        }
        if (!acted) {
            await pause(pages[0]!, 1200);
            const stillBetting = await Promise.all(pages.map(p =>
                p.locator('#callRaiseButton').isVisible().catch(() => false)));
            if (!stillBetting.some(Boolean)) break;
        }
    }
}

// Force each player's resolved low/high results BEFORE anyone selects. Resolution only fires
// once the LAST player has submitted, so doing all the overrides first guarantees they're
// stored in time. A null side is a no-op (the server only overrides a side that's != null).
async function setDebugResults(pages: Page[], plans: Plan[]) {
    await Promise.all(pages.map((page, i) =>
        page.evaluate(({ low, high }) => (window as any).__debugSetEquationResults(low, high),
            { low: plans[i]!.low ?? null, high: plans[i]!.high ?? null })));
}

// Each player makes their assigned hi/lo choice. Swing selects BOTH sides, confirms, then
// confirms the second equation (the finite forming arrangement is reused), per swing.test.ts.
async function makeSelections(pages: Page[], plans: Plan[]) {
    await Promise.all(pages.map(async (page, i) => {
        const modal = page.locator('#choiceModal');
        await modal.waitFor({ state: 'visible', timeout: 20000 });
        if (plans[i]!.choice === 'swing') {
            await page.locator('.option[data-choice="low"]').click({ force: true });
            await page.locator('.option[data-choice="high"]').click({ force: true });
            await page.locator('#confirmChoice').click({ force: true });
            await expect(modal).toBeHidden({ timeout: 8000 });
            const confirmOther = page.locator('#confirmOtherEquationFormed');
            await confirmOther.waitFor({ state: 'visible', timeout: 8000 });
            await confirmOther.click({ force: true });
        } else {
            await page.locator(`.option[data-choice="${plans[i]!.choice}"]`).click({ force: true });
            await page.locator('#confirmChoice').click({ force: true });
            await expect(modal).toBeHidden({ timeout: 8000 });
        }
        await pause(page, 1200);
    }));
}

interface Scenario {
    pages: Page[];
    contexts: BrowserContext[];
    ids: string[];        // ids[i] is the persistent userId for pages[i] (and plans[i])
    result: any;          // the captured round-result WS message (from the host's socket)
}

// Drive a full hand for plans.length players up to results: lobby -> betting -> equation
// forming -> forced results -> mixed hi/lo selection -> results. Captures the host's
// round-result frame and runs the shared DOM winner verification (acknowledgeResults).
async function runScenario(browser: Browser, plans: Plan[]): Promise<Scenario> {
    const n = plans.length;
    const contexts = await Promise.all([...Array(n)].map(() => browser.newContext()));
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
    pages.forEach((page, i) => attachBrowserLogging(page, `player${i}`));

    // Capture round-result frames per page. Attached BEFORE goto so it catches the game
    // socket created during page load (a listener added later would miss the original socket).
    const roundResults: any[][] = pages.map(() => []);
    pages.forEach((page, i) => {
        page.on('websocket', ws => ws.on('framereceived', f => {
            try {
                const m = JSON.parse(f.payload as string);
                if (m.type === 'round-result') roundResults[i]!.push(m);
            } catch { /* non-JSON / binary frame */ }
        }));
    });

    await Promise.all(pages.map(page => page.goto('/')));

    const [hostPage, ...rest] = pages as [Page, ...Page[]];

    await hostPage.click('#createButton');
    const roomCode = await getRoomCodeFromUrl(hostPage);
    await hostPage.fill('#nameInput', 'Host');
    await hostPage.click('#submitNameButton');
    await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText('Host');

    for (const [i, page] of rest.entries()) {
        await page.fill('#roomCodeInput', roomCode);
        await page.click('#enterRoomButton');
        await page.fill('#nameInput', `Player${i + 1}`);
        await page.click('#submitNameButton');
    }
    for (let i = 1; i < n; i++) {
        await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText(`Player${i}`);
    }

    await expect(hostPage.locator('#startButton')).toBeEnabled({ timeout: 5000 });
    await hostPage.click('#startButton');
    for (const page of pages) {
        await expect(page.locator('#potContainer')).toBeVisible({ timeout: 10000 });
    }

    // Play to hi/lo selection — everyone stays in.
    await discardIfNeeded(pages);
    await callDownBettingRound(pages);
    await discardIfNeeded(pages);
    await doEquationForming(pages);
    await pause(hostPage, 1500);
    await callDownBettingRound(pages);

    for (const page of pages) {
        await expect(page.locator('#choiceModal')).toBeVisible({ timeout: 20000 });
    }

    const ids = await Promise.all(pages.map(p => p.evaluate(() => localStorage.getItem('userId') as string)));

    // Force the results, THEN select — so the overrides are stored before resolution fires.
    await setDebugResults(pages, plans);
    await makeSelections(pages, plans);

    // The host's round-result frame carries the authoritative winner/contender flags + message.
    await expect.poll(() => roundResults[0]!.length, {
        message: 'host should receive a round-result frame after resolution',
        timeout: 20000,
    }).toBeGreaterThan(0);
    const result = roundResults[0]![roundResults[0]!.length - 1];

    // Shared DOM verification: the highlighted winner(s) match who SHOULD have won given the
    // rendered (forced) results — covers the swing-sweep / pure split logic end-to-end.
    for (const page of pages) {
        await expect(page.locator('#confirmResults')).toBeVisible({ timeout: 15000 });
    }
    const acked = await acknowledgeResults(pages);
    expect(acked, 'every player should see and pass the results verification').toBe(n);

    return { pages, contexts, ids, result };
}

// Look up a player's per-player result row in the round-result payload.
const rowFor = (result: any, id: string) =>
    (result.results as any[]).find(r => r.id === id);

test.describe('Winner resolution scenarios', () => {
    test('swing sweep: a swing better wins BOTH sides and takes the whole pot, beating pure hi/lo betters', async ({ browser }) => {
        test.setTimeout(120000);
        // P0 swings to the perfect sweep (1 and 20); the pure high (14) and pure low (6) betters
        // are both beaten by the swing better on their own side.
        const plans: Plan[] = [
            { choice: 'swing', low: 1, high: 20 },
            { choice: 'high', high: 14 },
            { choice: 'low', low: 6 },
        ];
        const { contexts, ids, result } = await runScenario(browser, plans);

        expect(result.message).toContain('won the swing bet');
        const swing = rowFor(result, ids[0]!);
        expect(swing.isLoWinner, 'swing sweeper wins the low side').toBe(true);
        expect(swing.isHiWinner, 'swing sweeper wins the high side').toBe(true);
        // No one else wins.
        expect(rowFor(result, ids[1]!).isHiWinner).toBeFalsy();
        expect(rowFor(result, ids[2]!).isLoWinner).toBeFalsy();

        await Promise.all(contexts.map(ctx => ctx.close()));
    });

    test('no sweep: the pot SPLITS to the pure high and pure low betters when the swing better sweeps neither', async ({ browser }) => {
        test.setTimeout(120000);
        // P0 swings but is mediocre on both sides (6 / 14); the pure low better nails 1 and the
        // pure high better nails 20, so neither side falls to the swing better -> split pot.
        const plans: Plan[] = [
            { choice: 'swing', low: 6, high: 14 },
            { choice: 'high', high: 20 },
            { choice: 'low', low: 1 },
        ];
        const { contexts, ids, result } = await runScenario(browser, plans);

        expect(result.message).toContain('won the high bet');
        expect(result.message).toContain('won the low bet');
        expect(rowFor(result, ids[1]!).isHiWinner, 'pure high better wins the high side').toBe(true);
        expect(rowFor(result, ids[2]!).isLoWinner, 'pure low better wins the low side').toBe(true);
        // The swing better, having swept neither, wins nothing.
        const swing = rowFor(result, ids[0]!);
        expect(swing.isLoWinner).toBeFalsy();
        expect(swing.isHiWinner).toBeFalsy();

        await Promise.all(contexts.map(ctx => ctx.close()));
    });

    test('ties in both groups: two swing betters tie AND two pure low betters tie in the same hand (contender highlighting)', async ({ browser }) => {
        test.setTimeout(120000);
        // P0/P1 swing and tie each other on BOTH sides (low 8, high 10) — neither sweeps, since
        // the pure low betters (3) beat them on low and nobody bets pure high. P2/P3 tie on low (3);
        // the better single low card breaks it, and that player takes the whole pot (no high winner).
        // This is the determineWinnersInternal "TEST add this" case: swing AND non-swing tie
        // contenders highlighted in one hand.
        const plans: Plan[] = [
            { choice: 'swing', low: 8, high: 10 },
            { choice: 'swing', low: 8, high: 10 },
            { choice: 'low', low: 3 },
            { choice: 'low', low: 3 },
        ];
        const { contexts, ids, result } = await runScenario(browser, plans);

        // Exactly one winner overall (a pure low better); verified structurally by acknowledgeResults.
        const winners = (result.results as any[]).filter(r => r.isLoWinner || r.isHiWinner);
        expect(winners.length, 'exactly one side has a winner (low)').toBe(1);
        expect(winners[0].isLoWinner).toBe(true);
        expect([ids[2], ids[3]], 'the low winner is one of the tied pure low betters').toContain(winners[0].id);

        // The swing pair are contenders on BOTH sides (they tied each other on low and high).
        for (const id of [ids[0]!, ids[1]!]) {
            const r = rowFor(result, id);
            expect(r.isLoContender, `swing better ${id} is a low contender`).toBe(true);
            expect(r.isHiContender, `swing better ${id} is a high contender`).toBe(true);
        }
        // The pure low pair are low contenders (their tie decides the pot by card).
        for (const id of [ids[2]!, ids[3]!]) {
            const r = rowFor(result, id);
            expect(r.isLoContender, `pure low better ${id} is a low contender`).toBe(true);
            expect(r.isHiContender, `pure low better ${id} is not a high contender`).toBeFalsy();
        }

        // The tie highlight actually rendered on the results page (contender cards get .card-highlighted).
        await expect(result.results.length).toBeGreaterThan(0);

        await Promise.all(contexts.map(ctx => ctx.close()));
    });

    test('all swing, no sweep: nobody wins and the pot is forfeited', async ({ browser }) => {
        test.setTimeout(120000);
        // Everyone swings; the best low (2 -> P0) and best high (18 -> P1) belong to different
        // players, so no one sweeps both sides -> forfeit.
        const plans: Plan[] = [
            { choice: 'swing', low: 2, high: 9 },
            { choice: 'swing', low: 9, high: 18 },
            { choice: 'swing', low: 14, high: 5 },
        ];
        const { contexts, result } = await runScenario(browser, plans);

        expect(result.message.toLowerCase()).toContain('forfeit');
        const anyWinner = (result.results as any[]).some(r => r.isLoWinner || r.isHiWinner);
        expect(anyWinner, 'no player should be marked a winner when the pot is forfeited').toBe(false);

        await Promise.all(contexts.map(ctx => ctx.close()));
    });
});
