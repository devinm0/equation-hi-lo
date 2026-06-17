import { test, expect, Page } from '@playwright/test';
import { attachBrowserLogging } from './_logging.js';
import { discardIfNeeded, doEquationForming } from './_helpers.js';

// Regression test for the swing-betting hang/no-selection bug. The client sends the swing
// second-equation card order as strings (card.dataset.id); the server's swing validator used
// to reject any non-`number` element, so every swing submit was silently dropped — the player
// kept choices:["low","high"] but with null equation results, was never cleared from the
// selecting set, and showed up in results as "(no selection)" with empty equations. The fix
// coerces the indices with Number() (matching the hand-order handler).

const NUM_PLAYERS = 3;

async function pause(page: Page, ms = 800) {
    if (!process.env.CI) await page.waitForTimeout(ms);
}

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

test.describe('Swing betting', () => {
    test('a swing better is accepted and shown with both equations, not "no selection"', async ({ browser }) => {
        test.setTimeout(120000);

        const contexts = await Promise.all([...Array(NUM_PLAYERS)].map(() => browser.newContext()));
        const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
        pages.forEach((page, i) => attachBrowserLogging(page, `player${i}`));
        await Promise.all(pages.map(page => page.goto('/')));

        const [hostPage, ...rest] = pages as [Page, ...Page[]];

        await hostPage.click('#createButton');
        await expect(hostPage.locator('#roomCodeContainer')).toContainText(/[A-Z0-9]{4}/);
        const roomCode = (await hostPage.locator('#roomCodeContainer').innerText()).split(' ')[1]!;
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

        await discardIfNeeded(pages);
        await callDownBettingRound(pages);
        await discardIfNeeded(pages);
        await doEquationForming(pages);
        await pause(hostPage, 1500);
        await callDownBettingRound(pages);

        for (const page of pages) {
            await expect(page.locator('#choiceModal')).toBeVisible({ timeout: 20000 });
        }

        const [swingPage, ...others] = pages as [Page, ...Page[]];
        const swingId = await swingPage.evaluate(() => localStorage.getItem('userId'));
        expect(swingId, 'swing player should have a persistent id').toBeTruthy();

        // Swing better: select BOTH low and high, confirm, then lock in the second equation
        // (the hand is already a valid arrangement from the forming phase, so it's finite).
        await swingPage.locator('.option[data-choice="low"]').click({ force: true });
        await swingPage.locator('.option[data-choice="high"]').click({ force: true });
        await expect(swingPage.locator('.option[data-choice="low"]')).toHaveClass(/selected/);
        await expect(swingPage.locator('.option[data-choice="high"]')).toHaveClass(/selected/);
        await swingPage.locator('#confirmChoice').click({ force: true });
        await expect(swingPage.locator('#choiceModal')).toBeHidden({ timeout: 5000 });
        await expect(swingPage.locator('#confirmOtherEquationFormed')).toBeVisible({ timeout: 8000 });
        await swingPage.locator('#confirmOtherEquationFormed').click({ force: true });

        // The other two pick a single side normally.
        for (const page of others) {
            await page.locator('.option[data-choice="high"]').click({ force: true });
            await page.locator('#confirmChoice').click({ force: true });
            await expect(page.locator('#choiceModal')).toBeHidden({ timeout: 5000 });
        }

        // The hand resolves and results render for everyone.
        for (const page of pages) {
            await expect(page.locator('#confirmResults')).toBeVisible({ timeout: 12000 });
        }

        // On the swing player's own results: they are NOT labelled "(no selection)", both their
        // low and high bet symbols are shown, and both equations rendered a numeric result.
        await expect(swingPage.getByText('no selection')).toHaveCount(0);

        const swing = await swingPage.evaluate((id) => {
            const handDiv = document.getElementById('hand-' + id)!;
            const loSym = document.getElementById('low-symbol-' + id);
            const hiSym = document.getElementById('high-symbol-' + id);
            const results = Array.from(handDiv.querySelectorAll('.difference-card .result-paragraph'))
                .map(p => (p.textContent || '').trim())
                .filter(Boolean);
            return {
                choseLow: !!loSym && !loSym.classList.contains('hidden'),
                choseHigh: !!hiSym && !hiSym.classList.contains('hidden'),
                results,
            };
        }, swingId);

        expect(swing.choseLow, 'swing player shows a low bet').toBe(true);
        expect(swing.choseHigh, 'swing player shows a high bet').toBe(true);
        expect(swing.results.length, 'swing player shows two equation results (low + high)').toBe(2);
        for (const r of swing.results) {
            expect(r, 'each swing equation result is a real number').toMatch(/=\s*-?\d/);
        }

        await Promise.all(contexts.map(ctx => ctx.close()));
    });
});
