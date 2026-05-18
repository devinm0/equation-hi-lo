import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';

const NUM_PLAYERS = 5;

async function pause(page: Page, ms = 1000) {
    if (!process.env.CI) await page.waitForTimeout(ms);
}

async function discardIfNeeded(pages: Page[]) {
    await pause(pages[0]!);
    for (const page of pages) {
        const highlighted = page.locator('.card-highlighted').first();
        const needsDiscard = await highlighted.isVisible({ timeout: 3000 }).catch(() => false);
        if (needsDiscard) {
            await highlighted.click({ force: true });
            await expect(page.locator('.card-highlighted')).toHaveCount(0, { timeout: 3000 });
        }
    }
}

async function setupPlayers(browser: Browser): Promise<{ pages: Page[]; contexts: BrowserContext[] }> {
    const contexts = await Promise.all(
        [...Array(NUM_PLAYERS)].map(() => browser.newContext())
    );
    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
    await Promise.all(pages.map(page => page.goto('/')));

    // Inject rAF-based FPS counter overlay (headed only)
    if (!process.env.CI) {
        await Promise.all(pages.map(page => page.evaluate(() => {
            const el = document.createElement('div');
            el.style.cssText = 'position:fixed;top:4px;right:4px;z-index:99999;background:rgba(0,0,0,0.7);color:#0f0;font:bold 11px monospace;padding:2px 5px;border-radius:3px;pointer-events:none';
            document.documentElement.appendChild(el);
            let frames = 0, last = performance.now();
            const tick = (now: number) => {
                frames++;
                if (now - last >= 500) {
                    el.textContent = `${Math.round(frames * 1000 / (now - last))} fps`;
                    frames = 0; last = now;
                }
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        })));
    }

    // Position windows in a 3-column grid so none overlap (Chromium headed only)
    const windowW = 430;
    const windowH = 475;
    const cols = 3;
    await Promise.all(pages.map(async (page, i) => {
        try {
            const client = await page.context().newCDPSession(page);
            const { windowId } = await (client as any).send('Browser.getWindowForTarget');
            await (client as any).send('Browser.setWindowBounds', {
                windowId,
                bounds: {
                    left: (i % cols) * windowW,
                    top: Math.floor(i / cols) * windowH,
                    width: windowW,
                    height: windowH,
                },
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
        for (let i = 1; i < NUM_PLAYERS; i++) {
            await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText(`Player${i}`);
        }

        // Start button becomes enabled once all players have joined
        await expect(hostPage.locator('#startButton')).toBeEnabled({ timeout: 5000 });
        await hostPage.click('#startButton');

        // All players transition to the game — pot is visible, home screen is gone
        for (const page of pages) {
            await expect(page.locator('#potContainer')).toBeVisible({ timeout: 5000 });
            await expect(page.locator('#homeContainer')).toBeHidden();
        }

        // Discard phase (first deal) — players who got a multiplication card discard one card
        await discardIfNeeded(pages);

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

        // Discard phase (second deal) — players who got a multiplication card on second deal discard
        await discardIfNeeded(pages);

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

                // Avoid placing 0 as the ÷ denominator (numCards[divIdx+1]) to prevent NaN/Infinity
                const divIdx = binaryOpCards.findIndex(c => c.dataset.value === '÷');
                if (divIdx !== -1 && numCards[divIdx + 1]?.dataset.value === '0') {
                    const swapIdx = numCards.findIndex((c, i) => i !== divIdx + 1 && c.dataset.value !== '0');
                    if (swapIdx !== -1)
                        [numCards[swapIdx], numCards[divIdx + 1]] = [numCards[divIdx + 1]!, numCards[swapIdx]!];
                }

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

            await pause(page);
            await lockButton.click();
            // Verify lock-in was accepted (button hides on success; stays visible if equation was rejected)
            await expect(lockButton).toBeHidden({ timeout: 3000 });
        }));

        // Second round betting — player 1 raises by 5, players 2-4 call, player 5 folds
        await pause(pages[0]!);
        const secondRoundActions: Array<'raise' | 'call' | 'fold'> = ['raise', 'call', 'call', 'call', 'fold'];
        for (const action of secondRoundActions) {
            let bettingPage: Page | undefined;
            for (const page of pages) {
                if (await page.locator('#bettingControls').isVisible({ timeout: 3000 }).catch(() => false)) {
                    bettingPage = page;
                    break;
                }
            }
            // fold is optional: player 5 may have been auto-folded during equation forming
            if (!bettingPage && action === 'fold') break;
            expect(bettingPage, `no player had betting controls for action '${action}'`).toBeDefined();

            if (action === 'raise') {
                await bettingPage.evaluate(() => {
                    const slider = document.getElementById('betSlider') as HTMLInputElement;
                    slider.value = String(parseInt(slider.min) + 5);
                    slider.dispatchEvent(new Event('input'));
                });
                await bettingPage.locator('#callRaiseButton').click();
            } else if (action === 'call') {
                await bettingPage.locator('#callRaiseButton').click();
            } else {
                await bettingPage.locator('#foldButton').click();
            }
            await pause(pages[0]!);
        }

        // Hi/lo selection — each non-folded player selects low
        await pause(pages[0]!);
        await Promise.all(pages.map(async (page) => {
            const modal = page.locator('#choiceModal');
            const isVisible = await modal.isVisible({ timeout: 5000 }).catch(() => false);
            if (!isVisible) return; // folded player — modal not shown

            await page.locator('.option[data-choice="low"]').click();
            await page.locator('#confirmChoice').click();
            await pause(page);
        }));

        // Round results — 5s to read the results, then all players hit Next Hand
        await pause(pages[0]!, 5000);
        await Promise.all(pages.map(async (page) => {
            const button = page.locator('#confirmResults');
            const isVisible = await button.isVisible({ timeout: 5000 }).catch(() => false);
            if (!isVisible) return; // out player — no button shown
            await button.click();
            await pause(page);
        }));

        await pause(pages[0]!, 5000);

        await Promise.all(contexts.map(ctx => ctx.close()));
    });
});
