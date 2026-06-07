import { test, expect, Page } from '@playwright/test';
import { attachBrowserLogging } from './_logging.js';

test.describe('Joining mid-game', () => {
    test('a 4th player cannot enter a game already in progress', async ({ browser }) => {
        test.setTimeout(120000);

        const contexts = await Promise.all([...Array(4)].map(() => browser.newContext()));
        const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
        pages.forEach((page, i) => attachBrowserLogging(page, `player${i}`));
        await Promise.all(pages.map(page => page.goto('/')));

        const [hostPage, p2, p3, latecomer] = pages as [Page, Page, Page, Page];

        // Host creates a room.
        await hostPage.click('#createButton');
        await expect(hostPage.locator('#roomCodeContainer')).toContainText(/[A-Z0-9]{4}/);
        const roomCodeText = await hostPage.locator('#roomCodeContainer').innerText();
        const roomCode = roomCodeText.split(' ')[1]!;
        expect(roomCode).toMatch(/^[A-Z0-9]{4}$/);

        await hostPage.fill('#nameInput', 'Host');
        await hostPage.click('#submitNameButton');
        await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText('Host');

        // Two more players join the lobby (3 total).
        for (const [i, page] of [p2, p3].entries()) {
            await page.fill('#roomCodeInput', roomCode);
            await page.click('#enterRoomButton');
            await page.fill('#nameInput', `Player${i + 1}`);
            await page.click('#submitNameButton');
        }
        await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText('Player1');
        await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText('Player2');

        // Host starts the game — hand 1 is now in progress.
        await expect(hostPage.locator('#startButton')).toBeEnabled({ timeout: 5000 });
        await hostPage.click('#startButton');
        for (const page of [hostPage, p2, p3]) {
            await expect(page.locator('#potContainer')).toBeVisible({ timeout: 10000 });
            await expect(page.locator('#homeContainer')).toBeHidden();
        }

        // A 4th player (brand-new, never in this room) tries to enter the in-progress
        // room and is rejected — not left on a blank screen.
        await latecomer.fill('#roomCodeInput', roomCode);
        await latecomer.click('#enterRoomButton');
        await expect(latecomer.locator('#roomCodeError')).toHaveText('Game already in progress.');
        await expect(latecomer.locator('#homeContainer')).toBeVisible();

        // The 4th never joined — existing players still see exactly 3 hands.
        await expect(hostPage.locator('.hand')).toHaveCount(3);

        await Promise.all(contexts.map(ctx => ctx.close()));
    });
});
