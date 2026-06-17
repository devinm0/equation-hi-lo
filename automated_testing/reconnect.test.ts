import { test, expect, Page, devices } from '@playwright/test';
import { attachBrowserLogging } from './_logging.js';
import {
    discardWithReconnect,
    equationFormingWithReconnect,
    hiLoSelectionWithReconnect,
    acknowledgeResults,
    getRoomCodeFromUrl,
} from './_helpers.js';

// 3 players on distinct iPhone viewports (mirrors betting.test.ts).
const PLAYER_DEVICES = [
    devices['iPhone 14 Pro'],
    devices['iPhone 13'],
    devices['iPhone 14 Pro Max'],
];

// Drive the current betting round to completion: whoever holds the controls just calls
// (all-in if calling the full stack), until no one has controls within the window — i.e. the
// round closed and the game moved to the next phase.
async function finishBettingRound(pages: Page[]) {
    for (let guard = 0; guard < 15; guard++) {
        const bettingPage = await Promise.any(
            pages.map(async (p) => {
                await p.locator('#bettingControls').waitFor({ state: 'visible', timeout: 4000 });
                return p;
            }),
        ).catch(() => undefined);
        if (!bettingPage) return;

        const callBtn = bettingPage.locator('#callRaiseButton');
        if (await callBtn.isVisible()) await callBtn.click();
        else await bettingPage.locator('#allInButton').click();
        await pages[0]!.waitForTimeout(800);
    }
}

// ---------------------------------------------------------------------------
// Reconnect after a tab is backgrounded / connectivity drops.
//
// Real mobile OSes silently tear down the WebSocket when a tab is backgrounded;
// Playwright can't OS-suspend a tab, but BrowserContext.setOffline(true) severs
// the connection at the network layer for just that one player's context — the
// same observable our client reacts to (the socket closes). We restore the
// network and fire a real `visibilitychange` (the "came back to foreground"
// signal our client listens for) and assert the player auto-rejoins: the server
// replies with a fresh `room-entered` (inProgress) and the game UI is intact —
// no manual reload, no "Rejoin" click — even though another player acted during
// the gap.
// ---------------------------------------------------------------------------
test.describe('Reconnect after background/foreground', () => {
    test('a backgrounded player auto-rejoins on foreground after another player bets', async ({ browser }) => {
        test.setTimeout(180000);

        // Per-page record of every `room-entered` frame received. page.on('websocket')
        // fires for EACH socket the page opens, including the reconnect one, so this
        // captures the rejoin reply on the replacement socket too.
        const roomEntered = new Map<Page, any[]>();

        const contexts = await Promise.all(PLAYER_DEVICES.map(d => browser.newContext(d)));
        const pages: Page[] = [];
        for (const [i, ctx] of contexts.entries()) {
            const page = await ctx.newPage();
            attachBrowserLogging(page, `player${i}`);
            const frames: any[] = [];
            roomEntered.set(page, frames);
            page.on('websocket', ws => {
                ws.on('framereceived', f => {
                    try {
                        const msg = JSON.parse(f.payload as string);
                        if (msg.type === 'room-entered') frames.push(msg);
                    } catch {}
                });
            });
            pages.push(page);
        }
        await Promise.all(pages.map(p => p.goto('/')));

        // --- Lobby + start (mirrors setupRoom in betting.test.ts) ---
        const [host, ...rest] = pages as [Page, ...Page[]];
        await host.click('#createButton');
        const roomCode = await getRoomCodeFromUrl(host);
        await host.fill('#nameInput', 'Host');
        await host.click('#submitNameButton');
        await expect(host.locator('#lobbyPlayerListContainer')).toContainText('Host');

        for (const [i, p] of rest.entries()) {
            await p.fill('#roomCodeInput', roomCode);
            await p.click('#enterRoomButton');
            await p.fill('#nameInput', `Player${i + 1}`);
            await p.click('#submitNameButton');
        }
        await expect(host.locator('#startButton')).toBeEnabled({ timeout: 5000 });
        await host.click('#startButton');
        for (const p of pages) await expect(p.locator('#potContainer')).toBeVisible({ timeout: 10000 });

        // --- First-deal discards: every player asked to discard is dropped first, fails to
        // discard offline, reconnects, and is re-asked by the server before discarding for real. ---
        await discardWithReconnect(pages, contexts);
        const actor = await Promise.any(pages.map(async (p) => {
            await p.locator('#bettingControls').waitFor({ state: 'visible', timeout: 20000 });
            return p;
        }));

        // The actor has the betting controls (it's their turn). We drop the player who acts
        // NEXT — turn order is the player-insertion order (host, then joiners) with wrap,
        // skipping folds, and no one has folded yet — so the next seat after the actor is
        // deterministically pages[(actorIdx + 1) % N]. That's the page array order because
        // players were inserted host-first, then in join order. When the actor raises, the
        // turn lands on this (offline) player and the game stalls there, waiting on them.
        const actorIdx = pages.indexOf(actor);
        const backgrounderIdx = (actorIdx + 1) % pages.length;
        const backgrounder = pages[backgrounderIdx]!;
        const backgrounderCtx = contexts[backgrounderIdx]!;

        console.log(`[reconnect-test] BETTOR = player${actorIdx}, DROPPING NEXT-TO-ACT = player${backgrounderIdx}`);
        // Paint a banner on the dropped window so it's identifiable in the headed run.
        await backgrounder.evaluate(() => {
            const b = document.createElement('div');
            b.id = '__dropBanner';
            b.textContent = '⚡ THIS PLAYER IS BEING DISCONNECTED (acts next)';
            b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:red;color:#fff;font:bold 16px sans-serif;text-align:center;padding:8px';
            document.body.appendChild(b);
        });

        // Sanity: before the drop the backgrounder is in the game, not on the home screen,
        // and does NOT yet have betting controls (it's still the actor's turn).
        await expect(backgrounder.locator('#potContainer')).toBeVisible();
        await expect(backgrounder.locator('#homeContainer')).toBeHidden();
        await expect(backgrounder.locator('#bettingControls')).toBeHidden();
        const enteredBefore = roomEntered.get(backgrounder)!.length;

        // --- t=0: DISCONNECT the next-to-act player, 5s before the bettor acts. setOffline
        // alone won't drop an already-open WebSocket in Chromium (it only blocks new
        // connections), so we also force-close the live socket via the client test seam — that
        // fires the `close` event our reconnect logic reacts to, while the dead network makes
        // the backoff retries fail until we come back. ---
        await backgrounderCtx.setOffline(true);
        await backgrounder.evaluate(() => (window as any).__simulateSocketDrop());

        // 5s of being disconnected before anything happens at the table.
        await backgrounder.waitForTimeout(5000);

        // --- t=5s: the bettor takes their turn (a raise). This advances the turn to the
        // offline next-to-act player; the game stalls there, waiting on them. ---
        await actor.evaluate(() => {
            const slider = document.getElementById('betSlider') as HTMLInputElement;
            slider.value = String(parseInt(slider.min) + 3);
            slider.dispatchEvent(new Event('input'));
        });
        await actor.locator('#callRaiseButton').click();
        // Turn consumed — the actor's controls go away, proving the bet registered.
        await expect(actor.locator('#bettingControls')).toBeHidden({ timeout: 10000 });

        // Remain away until 10s after the disconnect (5s elapsed above + 5s more).
        await backgrounder.waitForTimeout(5000);

        // --- t=10s: RECONNECT. Restore connectivity and fire the real visibility signal the
        // client listens for. connect() runs immediately (clearing any pending backoff timer),
        // so the comeback — not the timer — re-establishes the session. ---
        await backgrounderCtx.setOffline(false);
        expect(await backgrounder.evaluate(() => document.visibilityState)).toBe('visible');
        await backgrounder.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

        // --- Assert the rejoin: a NEW room-entered (inProgress) arrives on the reconnect
        // socket, with no reload and no manual Rejoin click. ---
        await expect.poll(
            () => roomEntered.get(backgrounder)!.length,
            { message: 'backgrounder should receive a fresh room-entered after reconnecting', timeout: 20000 },
        ).toBeGreaterThan(enteredBefore);

        const rejoinMsg = roomEntered.get(backgrounder)!.at(-1);
        expect(rejoinMsg.inProgress, 'rejoin should re-enter the in-progress game').toBe(true);
        expect(rejoinMsg.roomCode).toBe(roomCode);

        // And the player is back in the game UI, not bounced to home or left blank.
        await expect(backgrounder.locator('#potContainer')).toBeVisible({ timeout: 10000 });
        await expect(backgrounder.locator('#homeContainer')).toBeHidden();

        // The key assertion: it's now the rejoining player's turn, so the rejoin replay must
        // restore their betting controls — they can act instead of being stuck without them.
        await expect(
            backgrounder.locator('#bettingControls'),
            'rejoining player should regain betting controls since it is their turn',
        ).toBeVisible({ timeout: 10000 });

        // Reconnected successfully: flip the banner green so the headed run shows the recovery.
        await backgrounder.evaluate(() => {
            const b = document.getElementById('__dropBanner');
            if (b) {
                b.textContent = '✅ RECONNECTED — taking its turn';
                b.style.background = 'green';
            }
        });

        // --- And actually TAKE the turn after reconnecting: call. Controls going away proves
        // the rejoined socket can act on the live game, not just observe it. ---
        await backgrounder.locator('#callRaiseButton').click();
        await expect(
            backgrounder.locator('#bettingControls'),
            'after the rejoined player acts, their turn should be consumed',
        ).toBeHidden({ timeout: 10000 });

        // --- Finish the first betting round (remaining players just call) so the game advances
        // to the SECOND deal, where the same disconnect-on-discard contract must hold. ---
        await finishBettingRound(pages);
        await pages[0]!.waitForTimeout(2000); // let the second deal land + any discard highlight render
        await discardWithReconnect(pages, contexts);

        // --- EQUATION FORMING: drop one random player mid-forming, have them scramble their cards
        // offline, reconnect, and assert the cards resort to the server-stored order; then everyone
        // forms a real equation and locks in. ---
        await pages[0]!.waitForTimeout(2000); // let equation forming commence + hands render
        await equationFormingWithReconnect(pages, contexts);

        // --- SECOND betting round (remaining players just call), advancing to HI-LO selection. ---
        await finishBettingRound(pages);
        await pages[0]!.waitForTimeout(2000);

        // --- HI-LO SELECTION: drop one random player while the modal is up, have them try to select
        // offline, reconnect, and assert the modal reappears; then they select for real. ---
        await hiLoSelectionWithReconnect(pages, contexts);

        // --- The hand plays through to the end normally: every player reaches the results screen
        // (winner verified by acknowledgeResults), proving the reconnects didn't desync the hand. ---
        const acked = await acknowledgeResults(pages);
        expect(acked, 'all 3 players should reach the results screen after the reconnects').toBe(pages.length);

        // And the next hand begins — the game keeps running past the reconnect-laden hand.
        for (const p of pages) await expect(p.locator('#potContainer')).toBeVisible({ timeout: 10000 });

        await Promise.all(contexts.map(ctx => ctx.close()));
    });
});
