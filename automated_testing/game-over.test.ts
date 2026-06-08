import { test, expect, Page } from '@playwright/test';
import { attachBrowserLogging } from './_logging.js';

// When everyone but one player is eliminated, the lone survivor sees a win modal with
// their total winnings, and acknowledging it (or leaving the page) tears the room down
// server-side. This test then verifies the SAME browser window can immediately start a
// fresh game — the server creates a brand-new player for it and never suggests the dead
// room — and that the old room is genuinely gone.
//
// Reaching game-over via real play would mean grinding hands until a bust, which is slow
// and non-deterministic, so we use the debug-only window.__forceGameOver hook (the server
// honours debug-force-game-over solely under GAME_MODE=debug, which the E2E server runs).

test.describe('Game over → win modal → fresh game from the same window', () => {
    test('lone survivor wins, acknowledges, then starts a new game in the same window', async ({ browser }) => {
        test.setTimeout(120000);

        const hostCtx = await browser.newContext();
        const p2Ctx = await browser.newContext();
        const hostPage = await hostCtx.newPage();
        const p2Page = await p2Ctx.newPage();
        attachBrowserLogging(hostPage, 'host');
        attachBrowserLogging(p2Page, 'player2');
        await hostPage.goto('/');
        await p2Page.goto('/');

        // Host creates the room.
        await hostPage.click('#createButton');
        await expect(hostPage.locator('#roomCodeContainer')).toContainText(/[A-Z0-9]{4}/);
        const oldRoom = (await hostPage.locator('#roomCodeContainer').innerText()).split(' ')[1]!;
        expect(oldRoom).toMatch(/^[A-Z0-9]{4}$/);
        await hostPage.fill('#nameInput', 'Host');
        await hostPage.click('#submitNameButton');
        await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText('Host');

        // Player 2 joins.
        await p2Page.fill('#roomCodeInput', oldRoom);
        await p2Page.click('#enterRoomButton');
        await p2Page.fill('#nameInput', 'Player2');
        await p2Page.click('#submitNameButton');
        await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText('Player2');

        // Start the hand.
        await expect(hostPage.locator('#startButton')).toBeEnabled({ timeout: 5000 });
        await hostPage.click('#startButton');
        await expect(hostPage.locator('#potContainer')).toBeVisible({ timeout: 10000 });
        await expect(p2Page.locator('#potContainer')).toBeVisible({ timeout: 10000 });

        // Force game-over with the host as the lone survivor.
        await hostPage.evaluate(() => (window as any).__forceGameOver());

        // The host sees their own win modal with a non-empty chipstack and an Accept button.
        await expect(hostPage.locator('#winModal')).toBeVisible({ timeout: 10000 });
        await expect(hostPage.locator('#winTitle')).toContainText('You win');
        await expect(hostPage.locator('#confirmGameOver')).toBeVisible();
        expect(await hostPage.locator('#winChipStacksContainer .chip').count()).toBeGreaterThan(0);

        // Player 2 (the loser) sees the winner announced, not "You win".
        await expect(p2Page.locator('#winModal')).toBeVisible({ timeout: 10000 });
        await expect(p2Page.locator('#winTitle')).toContainText('Host wins');

        // Host acknowledges → server cleans up the room → page returns home.
        await hostPage.click('#confirmGameOver');
        await expect(hostPage.locator('#homeContainer')).toBeVisible({ timeout: 10000 });

        // No stale "rejoin the old room" suggestion: the create button is still offered and
        // the room-code prompt is the default one (suggest-room would replace both).
        await expect(hostPage.locator('#createButton')).toBeVisible();
        await expect(hostPage.locator('#roomCodeInfo')).not.toContainText(/rejoin/i);

        // The old room is genuinely gone (game + players deleted).
        await hostPage.fill('#roomCodeInput', oldRoom);
        await hostPage.click('#enterRoomButton');
        await expect(hostPage.locator('#roomCodeError')).toContainText('Room code does not exist.');

        // The same window can start a BRAND-NEW game — the server makes a new player for it.
        await hostPage.click('#createButton');
        await expect(hostPage.locator('#roomCodeContainer')).toContainText(/[A-Z0-9]{4}/);
        const newRoom = (await hostPage.locator('#roomCodeContainer').innerText()).split(' ')[1]!;
        expect(newRoom).toMatch(/^[A-Z0-9]{4}$/);
        expect(newRoom).not.toBe(oldRoom);
        await hostPage.fill('#nameInput', 'HostAgain');
        await hostPage.click('#submitNameButton');
        await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText('HostAgain');

        await Promise.all([hostCtx.close(), p2Ctx.close()]);
    });
});
