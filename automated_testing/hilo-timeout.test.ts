import { test, expect, Page } from '@playwright/test';
import { attachBrowserLogging } from './_logging.js';
import { discardIfNeeded, doEquationForming, getRoomCodeFromUrl } from './_helpers.js';

// Regression test for the end-of-hand hang: if a player never submits a hi/lo choice
// (closed tab, walked away, lost the modal on a refresh, or — the original incident — an
// empty choices:[] send), the hand used to wait on them forever and the results screen
// never rendered. With the HILOSELECTION timeout (HI_LO_DURATION, 20s in debug), the
// server auto-folds non-selectors and resolves the hand, so results always render.

const NUM_PLAYERS = 3;

async function pause(page: Page, ms = 800) {
    if (!process.env.CI) await page.waitForTimeout(ms);
}

// Click "call" on whichever player currently has betting controls, until a full round has
// gone by with no controls appearing (capped so a bug can't loop forever).
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
            // brief wait for the next turn to propagate before deciding the round is done
            await pause(pages[0]!, 1200);
            const stillBetting = await Promise.all(pages.map(p =>
                p.locator('#callRaiseButton').isVisible().catch(() => false)));
            if (!stillBetting.some(Boolean)) break;
        }
    }
}

test.describe('Hi/Lo selection timeout', () => {
    test('a player who never selects is auto-folded on timeout and the hand still resolves', async ({ browser }) => {
        test.setTimeout(120000);

        const contexts = await Promise.all([...Array(NUM_PLAYERS)].map(() => browser.newContext()));
        const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
        pages.forEach((page, i) => attachBrowserLogging(page, `player${i}`));
        await Promise.all(pages.map(page => page.goto('/')));

        const [hostPage, ...rest] = pages as [Page, ...Page[]];

        // Lobby setup.
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

        // Play the hand up to hi/lo selection.
        await discardIfNeeded(pages);
        await callDownBettingRound(pages);       // first betting
        await discardIfNeeded(pages);
        await doEquationForming(pages);           // everyone locks in
        await pause(hostPage, 1500);
        await callDownBettingRound(pages);       // second betting (if not skipped)

        // Hi/Lo: every player should get the choice modal with the countdown bar floated above it.
        for (const page of pages) {
            await expect(page.locator('#choiceModal')).toBeVisible({ timeout: 20000 });
            await expect(page.locator('#progressBarWrapper')).toHaveClass(/timer-overlay/);
            await expect(page.locator('#progressBarWrapper')).toBeVisible();
        }

        // Two players select Low + confirm; the THIRD never selects (modal left open).
        const [selectorA, selectorB, abstainer] = pages as [Page, Page, Page];
        for (const page of [selectorA, selectorB]) {
            await page.locator('.option[data-choice="low"]').click();
            await page.locator('#confirmChoice').click();
            await expect(page.locator('#choiceModal')).toBeHidden({ timeout: 5000 });
        }

        // The hand must still resolve — the two selectors reach the results screen even though
        // the abstainer never chose. Before the fix this hung forever. Allow generously for the
        // 20s debug HILOSELECTION timeout + result render.
        await expect(selectorA.locator('#confirmResults')).toBeVisible({ timeout: 40000 });
        await expect(selectorB.locator('#confirmResults')).toBeVisible({ timeout: 40000 });

        // The abstainer was auto-folded: their choice modal got dismissed by the resolution.
        await expect(abstainer.locator('#choiceModal')).toBeHidden({ timeout: 5000 });

        // On a selector's results view, the abstainer's tag explains the auto-fold rather than
        // being stuck on "(selecting...)".
        await expect(selectorA.getByText('no selection')).toBeVisible({ timeout: 5000 });

        await Promise.all(contexts.map(ctx => ctx.close()));
    });
});
