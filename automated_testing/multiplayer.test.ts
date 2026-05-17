import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';

const NUM_PLAYERS = 3;

async function setupPlayers(browser: Browser): Promise<{ pages: Page[]; contexts: BrowserContext[] }> {
    const contexts = await Promise.all(
        [...Array(NUM_PLAYERS)].map(() => browser.newContext())
    );
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
    await Promise.all(pages.map(page => page.goto('/')));
    return { pages, contexts };
}

test.describe('Multiplayer game flow', () => {
    test('lobby: host creates room, players join, game starts', async ({ browser }) => {
        const { pages, contexts } = await setupPlayers(browser);
        const [hostPage, ...playerPages] = pages as [Page, ...Page[]];

        // All players see the home screen
        for (const page of pages) {
            await expect(page.locator('#homeContainer')).toBeVisible();
        }

        // Host creates a room
        await hostPage.click('#createButton');
        await expect(hostPage.locator('#uiContainer')).not.toHaveClass(/hidden/);
        await expect(hostPage.locator('#roomCodeContainer')).toBeVisible();

        // Room code is a 4-character string
        const roomCodeText = await hostPage.locator('#roomCodeContainer').innerText();
        const roomCode = roomCodeText.split(' ')[1];
        expect(roomCode).toMatch(/^[A-Z0-9]{4}$/);

        // Host enters their name
        await hostPage.fill('#nameInput', 'Host');
        await hostPage.click('#submitNameButton');
        await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText('Host');

        // Other players join with the room code
        for (const [i, page] of playerPages.entries()) {
            await page.fill('#roomCodeInput', roomCode);
            await page.click('#enterRoomButton');
            await page.fill('#nameInput', `Player${i + 1}`);
            await page.click('#submitNameButton');
        }

        // Host sees all players in lobby
        await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText('Player1');
        await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText('Player2');

        // Start button becomes enabled once all players have joined
        await expect(hostPage.locator('#startButton')).toBeEnabled({ timeout: 5000 });
        await hostPage.click('#startButton');

        // All players transition to the game — pot is visible, home screen is gone
        for (const page of pages) {
            await expect(page.locator('#potContainer')).toBeVisible({ timeout: 5000 });
            await expect(page.locator('#homeContainer')).toBeHidden();
        }

        await Promise.all(contexts.map(ctx => ctx.close()));
    });
});
