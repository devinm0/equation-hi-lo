import { test, expect, Browser, BrowserContext, Page, devices } from '@playwright/test';
import { attachBrowserLogging } from './_logging.js';
import { discardIfNeeded, doEquationForming, getRoomCodeFromUrl } from './_helpers.js';

// Sandbox tests for manual play — run with: npx playwright test --config sandbox.config.ts --headed

test.setTimeout(600000); // 10 minutes

// 10 distinct iPhone models (13+), one per player slot — covers all major viewport sizes
const IPHONE_DEVICES = [
    devices['iPhone 13 Mini'],       // 375×812  (smallest)
    devices['iPhone 13'],            // 390×844
    devices['iPhone 13 Pro'],        // 390×844
    devices['iPhone 13 Pro Max'],    // 428×926
    devices['iPhone 14'],            // 390×844
    devices['iPhone 14 Plus'],       // 428×926
    devices['iPhone 14 Pro'],        // 393×852
    devices['iPhone 14 Pro Max'],    // 430×932
    devices['iPhone 15 Pro'],        // 393×852
    devices['iPhone 15 Pro Max'],    // 430×932  (largest)
];

async function setupPlayers(browser: Browser, numPlayers: number): Promise<{ pages: Page[]; contexts: BrowserContext[] }> {
    const contexts = await Promise.all(
        [...Array(numPlayers)].map((_, i) =>
            browser.newContext(i < IPHONE_DEVICES.length ? IPHONE_DEVICES[i] : {})
        )
    );
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
    // Mirror each player's browser console (incl. the hi-lo-selected payload it logs before
    // send) to logs/e2e-client.log so a manual repro leaves a grep-able client-side trail.
    pages.forEach((page, i) => attachBrowserLogging(page, `player${i}`));
    await Promise.all(pages.map(page => page.goto('/')));

    // Tile the windows so they don't fully stack. We only set left/top (position) and NOT
    // width/height: forcing the OS window size desyncs Playwright's device-viewport emulation
    // (and macOS clamps windows to a ~500px min width / subtracts toolbar chrome), which made
    // the rendered viewport wrong. Leaving the size alone keeps the emulated viewport correct,
    // matching the regular E2E tests.
    const colW = 430;
    const colH = 500;
    const cols = Math.ceil(Math.sqrt(numPlayers));
    try {
        const cdp = await browser.newBrowserCDPSession();
        for (const [i, page] of pages.entries()) {
            const pageSession = await page.context().newCDPSession(page);
            const { targetInfo } = await (pageSession as any).send('Target.getTargetInfo');
            const { windowId } = await (cdp as any).send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
            await (cdp as any).send('Browser.setWindowBounds', {
                windowId,
                bounds: {
                    left: (i % cols) * colW,
                    top: Math.floor(i / cols) * colH,
                },
            });
            await pageSession.detach();
        }
        await cdp.detach();
    } catch (e) {
        console.warn('Window positioning failed:', e);
    }

    return { pages, contexts };
}

test('sandbox: 10-player lobby, pause before game starts', async ({ browser }) => {
    const numPlayers = 10;
    const { pages, contexts } = await setupPlayers(browser, numPlayers);
    const [hostPage, ...playerPages] = pages as [Page, ...Page[]];

    // Host creates room
    await hostPage.click('#createButton');
    const roomCode = await getRoomCodeFromUrl(hostPage);

    await hostPage.fill('#nameInput', 'Host');
    await hostPage.click('#submitNameButton');

    // Other players join
    for (const [i, page] of playerPages.entries()) {
        await page.fill('#roomCodeInput', roomCode!);
        await page.click('#enterRoomButton');
        await page.fill('#nameInput', `Player${i + 1}`);
        await page.click('#submitNameButton');
    }

    await expect(hostPage.locator('#startButton')).toBeEnabled({ timeout: 5000 });

    console.log(`\n🎮 Lobby ready — room code: ${roomCode}\n   All ${numPlayers} players joined. Start the game manually. Close windows when done.\n`);

    // Hold open until all windows are closed
    await Promise.all(pages.map(page => page.waitForEvent('close', { timeout: 600000 }).catch(() => {})));

    await Promise.all(contexts.map(ctx => ctx.close()));
});

test('sandbox: 3-player game, pause at first betting', async ({ browser }) => {
    const { pages, contexts } = await setupPlayers(browser, 3);
    const [hostPage, ...playerPages] = pages as [Page, ...Page[]];

    // Host creates room
    await hostPage.click('#createButton');
    const roomCode = await getRoomCodeFromUrl(hostPage);

    await hostPage.fill('#nameInput', 'Host');
    await hostPage.click('#submitNameButton');

    // Other players join
    for (const [i, page] of playerPages.entries()) {
        await page.fill('#roomCodeInput', roomCode!);
        await page.click('#enterRoomButton');
        await page.fill('#nameInput', `Player${i + 1}`);
        await page.click('#submitNameButton');
    }

    await expect(hostPage.locator('#startButton')).toBeEnabled({ timeout: 5000 });
    await hostPage.click('#startButton');

    for (const page of pages) {
        await expect(page.locator('#potContainer')).toBeVisible({ timeout: 5000 });
    }

    // Handle any discards from first deal
    await Promise.all(pages.map(async (page) => {
        const highlighted = page.locator('.card-highlighted').first();
        try {
            await highlighted.waitFor({ state: 'visible', timeout: 5000 });
            await highlighted.click({ force: true });
        } catch {}
    }));

    // Wait for first betting to start on any player's page
    await Promise.any(pages.map(page =>
        page.locator('#bettingControls').waitFor({ state: 'visible', timeout: 15000 })
    ));

    console.log(`\n🎮 Game running — room code: ${roomCode}\n   Play manually in the browser windows. Close them when done.\n`);

    // Hold open until all windows are closed
    await Promise.all(pages.map(page => page.waitForEvent('close', { timeout: 600000 }).catch(() => {})));

    await Promise.all(contexts.map(ctx => ctx.close()));
});

// Auto-plays a full 3-player hand (discards, both betting rounds, equation forming) and pauses
// the moment every player has the hi/lo choice modal — so hi/lo selection (incl. swing) can be
// driven by hand. Run with: npx playwright test --config sandbox.config.ts --headed -g "hi/lo"
test('sandbox: 3-player hand, pause at hi/lo selection', async ({ browser }) => {
    const { pages, contexts } = await setupPlayers(browser, 3);
    const [hostPage, ...playerPages] = pages as [Page, ...Page[]];

    // Host creates room
    await hostPage.click('#createButton');
    const roomCode = await getRoomCodeFromUrl(hostPage);

    await hostPage.fill('#nameInput', 'Host');
    await hostPage.click('#submitNameButton');

    // Other players join
    for (const [i, page] of playerPages.entries()) {
        await page.fill('#roomCodeInput', roomCode!);
        await page.click('#enterRoomButton');
        await page.fill('#nameInput', `Player${i + 1}`);
        await page.click('#submitNameButton');
    }

    await expect(hostPage.locator('#startButton')).toBeEnabled({ timeout: 5000 });
    await hostPage.click('#startButton');
    for (const page of pages) {
        await expect(page.locator('#potContainer')).toBeVisible({ timeout: 10000 });
    }

    // Auto-play the hand up to (but not including) hi/lo selection.
    await discardIfNeeded(pages);          // first-deal multiply discards
    await callDownBettingRound(pages);     // first betting
    await discardIfNeeded(pages);          // second-deal multiply discards
    await doEquationForming(pages);        // everyone forms + locks in a valid equation
    await pages[0]!.waitForTimeout(1500);
    await callDownBettingRound(pages);     // second betting

    // Pause once every player has the hi/lo modal — manual selection from here.
    for (const page of pages) {
        await expect(page.locator('#choiceModal')).toBeVisible({ timeout: 25000 });
    }

    console.log(`\n🎮 Paused at HI/LO selection — room code: ${roomCode}\n   Make hi/lo (and swing) picks manually in each window. Close them when done.\n`);

    // Hold open until all windows are closed
    await Promise.all(pages.map(page => page.waitForEvent('close', { timeout: 600000 }).catch(() => {})));

    await Promise.all(contexts.map(ctx => ctx.close()));
});

// Click "call" on whichever player currently has betting controls, until a full round passes
// with no controls appearing. Mirrors the helper used by the regular E2E specs.
async function callDownBettingRound(pages: Page[]) {
    const NUM = pages.length;
    for (let i = 0; i < NUM + 2; i++) {
        let acted = false;
        for (const page of pages) {
            if (await page.locator('#callRaiseButton').isVisible().catch(() => false)) {
                await page.locator('#callRaiseButton').click({ force: true });
                acted = true;
                await page.waitForTimeout(600);
                break;
            }
        }
        if (!acted) {
            await pages[0]!.waitForTimeout(1200);
            const stillBetting = await Promise.all(pages.map(p =>
                p.locator('#callRaiseButton').isVisible().catch(() => false)));
            if (!stillBetting.some(Boolean)) break;
        }
    }
}
