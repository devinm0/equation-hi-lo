import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';

// Launches a 3-player game and pauses at first betting so you can play manually.
// Run with: npx playwright test sandbox --headed

test.setTimeout(600000); // 10 minutes

const NUM_PLAYERS = 3;

async function setupPlayers(browser: Browser): Promise<{ pages: Page[]; contexts: BrowserContext[] }> {
    const contexts = await Promise.all(
        [...Array(NUM_PLAYERS)].map(() => browser.newContext())
    );
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
    await Promise.all(pages.map(page => page.goto('/')));

    const windowW = 430;
    const windowH = 475;
    await Promise.all(pages.map(async (page, i) => {
        try {
            const client = await page.context().newCDPSession(page);
            const { windowId } = await (client as any).send('Browser.getWindowForTarget');
            await (client as any).send('Browser.setWindowBounds', {
                windowId,
                bounds: { left: i * windowW, top: 0, width: windowW, height: windowH },
            });
        } catch {}
    }));

    return { pages, contexts };
}

test('sandbox: 3-player game, pause at first betting', async ({ browser }) => {
    const { pages, contexts } = await setupPlayers(browser);
    const [hostPage, ...playerPages] = pages as [Page, ...Page[]];

    // Host creates room
    await hostPage.click('#createButton');
    const roomCodeText = await hostPage.locator('#roomCodeContainer').innerText();
    const roomCode = roomCodeText.split(' ')[1];

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
