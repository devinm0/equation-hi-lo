import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';

const NUM_PLAYERS = 3;

async function pause(page: Page, ms = 2000) {
    if (!process.env.CI) await page.waitForTimeout(ms);
}

async function setupPlayers(browser: Browser): Promise<{ pages: Page[]; contexts: BrowserContext[] }> {
    const contexts = await Promise.all(
        [...Array(NUM_PLAYERS)].map(() => browser.newContext())
    );
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
    await Promise.all(pages.map(page => page.goto('/')));

    // Position windows side-by-side so none overlap (Chromium headed only)
    const windowW = 430;
    const windowH = 950;
    await Promise.all(pages.map(async (page, i) => {
        try {
            const client = await page.context().newCDPSession(page);
            const { windowId } = await (client as any).send('Browser.getWindowForTarget');
            await (client as any).send('Browser.setWindowBounds', {
                windowId,
                bounds: { left: i * windowW, top: 0, width: windowW, height: windowH },
            });
        } catch {
            // headless or non-Chromium — skip positioning
        }
    }));

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

        // Discard phase — only players who received a multiplication card have a highlighted card to discard
        await pause(pages[0]!);
        for (const page of pages) {
            const highlighted = page.locator('.card-highlighted').first();
            const needsDiscard = await highlighted.isVisible({ timeout: 3000 }).catch(() => false);
            if (needsDiscard) {
                await highlighted.click({ force: true });
                await expect(page.locator('.card-highlighted')).toHaveCount(0, { timeout: 3000 });
            }
        }

        // First round betting — each player calls in turn until the round ends
        await pause(pages[0]!);
        for (let turn = 0; turn < pages.length * 2; turn++) {
            let bettingPage: Page | undefined;
            for (const page of pages) {
                if (await page.locator('#bettingControls').isVisible({ timeout: 1000 }).catch(() => false)) {
                    bettingPage = page;
                    break;
                }
            }
            if (!bettingPage) break;
            await bettingPage.locator('#callRaiseButton').click();
            await pause(pages[0]!);
        }

        // Equation forming phase — all players arrange hands in parallel, then lock in
        await pause(pages[0]!);
        await Promise.all(pages.map(async (page) => {
            const lockButton = page.locator('#confirmEquationFormed');
            const isVisible = await lockButton.isVisible({ timeout: 5000 }).catch(() => false);
            if (!isVisible) return; // folded/out player received cannotFormEquation

            // Reorder cards into a valid equation: (√? num) (op (√? num))*
            // Valid iff numCards.length === binaryOpCards.length + 1
            const arranged = await page.evaluate(() => {
                const myHand = document.querySelector('.my-hand')!;
                const allCards = Array.from(myHand.querySelectorAll('.card')) as HTMLElement[];

                const numCards = allCards.filter(c => c.classList.contains('number-card'));
                const rootCards = allCards.filter(c => c.classList.contains('operator-card') && c.dataset.value === '√');
                const binaryOpCards = allCards.filter(c => c.classList.contains('operator-card') && c.dataset.value !== '√');

                // Stack balance rule: nums must equal binary_ops + 1
                if (numCards.length !== binaryOpCards.length + 1) return false;

                // Build: [√?] num (op [√?] num)*
                const ordered: HTMLElement[] = [];
                for (let i = 0; i < numCards.length; i++) {
                    if (i < rootCards.length) ordered.push(rootCards[i]!);
                    ordered.push(numCards[i]!);
                    if (i < binaryOpCards.length) ordered.push(binaryOpCards[i]!);
                }
                ordered.forEach(card => myHand.appendChild(card));
                return true;
            });

            if (!arranged) return; // unbalanced hand — player will be auto-folded when timer expires

            // 2s pause so all arranged hands are visible before locking in
            await pause(page);
            await lockButton.click();
            // Verify lock-in was accepted (button hides on success; stays visible if equation was rejected)
            await expect(lockButton).toBeHidden({ timeout: 3000 });
        }));

        await pause(pages[0]!);

        await Promise.all(contexts.map(ctx => ctx.close()));
    });
});
