import { test, expect, Page } from '@playwright/test';
import { attachBrowserLogging } from './_logging.js';
import { getRoomCodeFromUrl } from './_helpers.js';

// MAX_PLAYERS_PER_ROOM is 10 (server-side, in state.ts). Spin up 12 clients and
// confirm the room fills at 10 and the last 2 are rejected with the "full" reason.
const MAX_PLAYERS_PER_ROOM = 10;
const TOTAL_CLIENTS = 12;

test.describe('Room capacity', () => {
    test('11th and 12th players are rejected, and hand 1 starts with the correct 10', async ({ browser }) => {
        test.setTimeout(120000);

        const contexts = await Promise.all(
            [...Array(TOTAL_CLIENTS)].map(() => browser.newContext())
        );
        const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
        pages.forEach((page, i) => attachBrowserLogging(page, `player${i}`));
        await Promise.all(pages.map(page => page.goto('/')));

        const [hostPage, ...rest] = pages as [Page, ...Page[]];

        // Host creates the room (player 1 of 10).
        await hostPage.click('#createButton');
        const roomCode = await getRoomCodeFromUrl(hostPage);

        await hostPage.fill('#nameInput', 'Host');
        await hostPage.click('#submitNameButton');
        await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText('Host');

        // Players 2–10 enter and fill the room to capacity. Waiting for each to appear
        // in the host's lobby list guarantees the server has processed their enter
        // before the rejected clients try, so the room is genuinely full.
        const joiners = rest.slice(0, MAX_PLAYERS_PER_ROOM - 1); // 9 players
        for (const [i, page] of joiners.entries()) {
            await page.fill('#roomCodeInput', roomCode);
            await page.click('#enterRoomButton');
            await page.fill('#nameInput', `Player${i + 1}`);
            await page.click('#submitNameButton');
        }
        for (let i = 1; i < MAX_PLAYERS_PER_ROOM; i++) {
            await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText(`Player${i}`);
        }

        // The last 2 clients attempt to enter the now-full room and are rejected.
        const rejected = rest.slice(MAX_PLAYERS_PER_ROOM - 1); // clients 11 and 12
        expect(rejected.length).toBe(2);
        for (const page of rejected) {
            await page.fill('#roomCodeInput', roomCode);
            await page.click('#enterRoomButton');
            await expect(page.locator('#roomCodeError')).toHaveText('Room is full.');
            // They never enter the lobby — the home screen stays up.
            await expect(page.locator('#homeContainer')).toBeVisible();
            await expect(page.locator('#lobbyScreenWrapper')).toHaveClass(/hidden/);
        }

        // Host starts the game — only the 10 in-room players should be in hand 1.
        const inRoomPages = [hostPage, ...joiners]; // exactly MAX_PLAYERS_PER_ROOM
        expect(inRoomPages.length).toBe(MAX_PLAYERS_PER_ROOM);

        await expect(hostPage.locator('#startButton')).toBeEnabled({ timeout: 5000 });
        await hostPage.click('#startButton');

        for (const page of inRoomPages) {
            await expect(page.locator('#potContainer')).toBeVisible({ timeout: 10000 });
            await expect(page.locator('#homeContainer')).toBeHidden();
        }

        // The host's view should render exactly 10 hands (own + 9 others) with the
        // correct player names, confirming all 10 players made it into the hand.
        await expect(hostPage.locator('.hand')).toHaveCount(MAX_PLAYERS_PER_ROOM);

        const expectedNames = ['Host', ...joiners.map((_, i) => `Player${i + 1}`)];
        const labels = await hostPage.locator('.handLabel').allInnerTexts();
        expect(labels.length).toBe(MAX_PLAYERS_PER_ROOM);
        for (const name of expectedNames) {
            expect(labels.some(label => label.includes(name))).toBe(true);
        }

        // The rejected clients never joined, so they're still on the home screen.
        for (const page of rejected) {
            await expect(page.locator('#homeContainer')).toBeVisible();
        }

        await Promise.all(contexts.map(ctx => ctx.close()));
    });
});
