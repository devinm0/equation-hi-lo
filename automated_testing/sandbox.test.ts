import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';

// Sandbox tests for manual play — run with: npx playwright test --config sandbox.config.ts --headed

test.setTimeout(600000); // 10 minutes

async function setupPlayers(browser: Browser, numPlayers: number): Promise<{ pages: Page[]; contexts: BrowserContext[] }> {
    const contexts = await Promise.all(
        [...Array(numPlayers)].map(() => browser.newContext())
    );
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
    await Promise.all(pages.map(page => page.goto('/')));

    const windowW = 430;
    const windowH = 475;
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
                    left: (i % cols) * windowW,
                    top: Math.floor(i / cols) * windowH,
                    width: windowW,
                    height: windowH,
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
    await expect(hostPage.locator('#roomCodeContainer')).toContainText(/[A-Z0-9]{4}/);
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
    await expect(hostPage.locator('#roomCodeContainer')).toContainText(/[A-Z0-9]{4}/);
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
