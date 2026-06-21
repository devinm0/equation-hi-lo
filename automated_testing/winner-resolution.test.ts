import { test, expect, Page } from '@playwright/test';
import { attachBrowserLogging } from './_logging.js';
import {
    discardIfNeeded,
    doEquationForming,
    acknowledgeResults,
    getRoomCodeFromUrl,
} from './_helpers.js';

// Live coverage for the HIGH / SPLIT / SWING-SWEEP winner branches.
//
// Every other spec drives doHiLoSelection -> "low" for all players, so the shared
// winner verifier (assertResultsPageWinners in _helpers.ts) only ever exercises the
// pure-low path end-to-end. That helper ALREADY encodes the full rule set — swing
// sweep, pure hi/lo split, card-value tiebreaks (see computeExpectedWinners) — but
// nothing reaches it with a high or swing bet, so those branches were verified only
// in unit tests, never against the live results screen.
//
// This spec makes the three players bet DIFFERENT sides — one swing, one high, one
// low — and finishes the hand through acknowledgeResults (which calls
// assertResultsPageWinners on every page). That single hand drives, live:
//   - the high-winner branch (the pure-high better),
//   - the split-pot branch (high + low winners shown together when nobody sweeps),
//   - the swing evaluation path (the swing better wins the whole pot iff they sweep
//     BOTH sides, otherwise each side falls to the best PURE better).
// The actual sweep-vs-split outcome depends on the random deal, but assertResultsPageWinners
// recomputes the expectation from the rendered results, so whichever way it lands is verified.

const NUM_PLAYERS = 3;

// Per-player hi/lo choice for this spec. Index 0 swings; the swing path also requires
// confirming the second equation (the forming-phase arrangement is already finite, so it
// just needs a confirm), mirroring the real swing flow in swing.test.ts.
type Choice = 'low' | 'high' | 'swing';
const CHOICES: Choice[] = ['swing', 'high', 'low'];

async function pause(page: Page, ms = 800) {
    if (!process.env.CI) await page.waitForTimeout(ms);
}

// Robustly call down a betting round so NO ONE folds — every player must reach hi/lo
// selection for the mixed-bet scenario to mean anything. Clicks call/check for whichever
// page currently holds the controls until the round ends. (Borrowed from swing.test.ts.)
async function callDownBettingRound(pages: Page[]) {
    for (let i = 0; i < NUM_PLAYERS + 2; i++) {
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

// Each non-folded player makes their assigned hi/lo choice. A swing requires selecting
// BOTH sides, confirming, then confirming the second equation; a single side is one click.
async function doMixedHiLoSelection(pages: Page[], choices: Choice[]) {
    await Promise.all(pages.map(async (page, i) => {
        const modal = page.locator('#choiceModal');
        try {
            await modal.waitFor({ state: 'visible', timeout: 20000 });
        } catch {
            return; // folded/out player — no modal
        }

        const choice = choices[i] ?? 'low';
        if (choice === 'swing') {
            await page.locator('.option[data-choice="low"]').click({ force: true });
            await page.locator('.option[data-choice="high"]').click({ force: true });
            await expect(page.locator('.option[data-choice="low"]')).toHaveClass(/selected/);
            await expect(page.locator('.option[data-choice="high"]')).toHaveClass(/selected/);
            await page.locator('#confirmChoice').click({ force: true });
            await expect(modal).toBeHidden({ timeout: 8000 });
            // Swing: lock in the second equation (already a finite forming arrangement).
            const confirmOther = page.locator('#confirmOtherEquationFormed');
            await confirmOther.waitFor({ state: 'visible', timeout: 8000 });
            await confirmOther.click({ force: true });
        } else {
            await page.locator(`.option[data-choice="${choice}"]`).click({ force: true });
            await page.locator('#confirmChoice').click({ force: true });
            await expect(modal).toBeHidden({ timeout: 8000 });
        }
        await pause(page, 1500);
    }));
}

test.describe('Winner resolution (high / split / swing-sweep)', () => {
    test('a mixed swing/high/low hand resolves to the correct winner(s) on the results page', async ({ browser }) => {
        test.setTimeout(120000);

        const contexts = await Promise.all([...Array(NUM_PLAYERS)].map(() => browser.newContext()));
        const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
        pages.forEach((page, i) => attachBrowserLogging(page, `player${i}`));
        await Promise.all(pages.map(page => page.goto('/')));

        const [hostPage, ...rest] = pages as [Page, ...Page[]];

        // Lobby: host creates, others join.
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
        for (let i = 1; i < NUM_PLAYERS; i++) {
            await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText(`Player${i}`);
        }

        await expect(hostPage.locator('#startButton')).toBeEnabled({ timeout: 5000 });
        await hostPage.click('#startButton');
        for (const page of pages) {
            await expect(page.locator('#potContainer')).toBeVisible({ timeout: 10000 });
        }

        // Play the hand to hi/lo selection — everyone stays in (no folds).
        await discardIfNeeded(pages);
        await callDownBettingRound(pages);
        await discardIfNeeded(pages);
        await doEquationForming(pages);
        await pause(hostPage, 1500);
        await callDownBettingRound(pages);

        for (const page of pages) {
            await expect(page.locator('#choiceModal')).toBeVisible({ timeout: 20000 });
        }

        // The crux: bet DIFFERENT sides so the high / split / swing branches are reached.
        await doMixedHiLoSelection(pages, CHOICES);

        // Results render for everyone, and acknowledgeResults verifies — on every page —
        // that the highlighted winner(s) match who SHOULD have won given the rendered
        // results, exercising the swing-sweep + pure-hi/lo split logic live.
        for (const page of pages) {
            await expect(page.locator('#confirmResults')).toBeVisible({ timeout: 15000 });
        }
        const acked = await acknowledgeResults(pages);
        expect(acked, 'all three players should see and verify the results screen').toBe(NUM_PLAYERS);

        await Promise.all(contexts.map(ctx => ctx.close()));
    });
});
