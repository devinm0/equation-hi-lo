import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';

const NUM_PLAYERS = 5;

async function pause(page: Page, ms = 1000) {
    if (!process.env.CI) await page.waitForTimeout(ms);
}

async function discardIfNeeded(pages: Page[]) {
    // Run in parallel — sequential would burn 5s × N players when no one needs to discard
    await Promise.all(pages.map(async (page) => {
        const highlighted = page.locator('.card-highlighted').first();
        try {
            await highlighted.waitFor({ state: 'visible', timeout: 5000 });
            await highlighted.click({ force: true });
            await highlighted.waitFor({ state: 'hidden', timeout: 5000 });
        } catch {
            // no discard needed for this player
        }
    }));
}

async function findBettingPage(pages: Page[], timeout = 15000): Promise<Page | undefined> {
    try {
        return await Promise.any(
            pages.map(async (page) => {
                await page.locator('#bettingControls').waitFor({ state: 'visible', timeout });
                return page;
            })
        );
    } catch {
        return undefined;
    }
}

async function runBettingRound(pages: Page[], actions: Array<'call' | 'raise' | 'fold'>) {
    for (const action of actions) {
        const bettingPage = await findBettingPage(pages);
        if (!bettingPage && action === 'fold') break;
        expect(bettingPage, `no player had betting controls for action '${action}'`).toBeDefined();

        if (action === 'raise') {
            await bettingPage!.evaluate(() => {
                const slider = document.getElementById('betSlider') as HTMLInputElement;
                slider.value = String(parseInt(slider.min) + 5);
                slider.dispatchEvent(new Event('input'));
            });
            await bettingPage!.locator('#callRaiseButton').click();
        } else if (action === 'call') {
            await bettingPage!.locator('#callRaiseButton').click();
        } else {
            await bettingPage!.locator('#foldButton').click();
        }
    }
}

async function doEquationForming(pages: Page[]) {
    await Promise.all(pages.map(async (page) => {
        const lockButton = page.locator('#confirmEquationFormed');
        try {
            await lockButton.waitFor({ state: 'visible', timeout: 30000 });
        } catch {
            return; // folded/out player received cannotFormEquation
        }

        const arranged = await page.evaluate(() => {
            const myHand = document.querySelector('.my-hand')!;
            const allCards = Array.from(myHand.querySelectorAll('.card')) as HTMLElement[];

            const numCards = allCards.filter(c => c.classList.contains('number-card'));
            const rootCards = allCards.filter(c => c.classList.contains('operator-card') && c.dataset.value === '√');
            const binaryOpCards = allCards.filter(c => c.classList.contains('operator-card') && c.dataset.value !== '√');

            if (numCards.length !== binaryOpCards.length + 1) return false;

            const divIdx = binaryOpCards.findIndex(c => c.dataset.value === '÷');
            if (divIdx !== -1 && numCards[divIdx + 1]?.dataset.value === '0') {
                const swapIdx = numCards.findIndex((c, i) => i !== divIdx + 1 && c.dataset.value !== '0');
                if (swapIdx !== -1)
                    [numCards[swapIdx], numCards[divIdx + 1]] = [numCards[divIdx + 1]!, numCards[swapIdx]!];
            }

            const ordered: HTMLElement[] = [];
            for (let i = 0; i < numCards.length; i++) {
                if (i < rootCards.length) ordered.push(rootCards[i]!);
                ordered.push(numCards[i]!);
                if (i < binaryOpCards.length) ordered.push(binaryOpCards[i]!);
            }
            ordered.forEach(card => myHand.appendChild(card));
            return true;
        });

        if (!arranged) return;

        await pause(page);
        await lockButton.click();
        await expect(lockButton).toBeHidden({ timeout: 3000 });
    }));
}

async function doHiLoSelection(pages: Page[]) {
    await Promise.all(pages.map(async (page) => {
        const modal = page.locator('#choiceModal');
        try {
            await modal.waitFor({ state: 'visible', timeout: 10000 });
        } catch {
            return; // folded player — modal not shown
        }

        await page.locator('.option[data-choice="low"]').click();
        await page.locator('#confirmChoice').click();
        await pause(page);
    }));
}

async function acknowledgeResults(pages: Page[]) {
    await Promise.all(pages.map(async (page) => {
        const button = page.locator('#confirmResults');
        try {
            await button.waitFor({ state: 'visible', timeout: 15000 });
        } catch {
            return; // out player — no button shown
        }
        await button.click();
        await pause(page);
    }));
}

async function playHand(pages: Page[]) {
    // Verify we're in a hand
    for (const page of pages) {
        await expect(page.locator('#potContainer')).toBeVisible({ timeout: 10000 });
    }

    await discardIfNeeded(pages);

    // First round betting — all call
    await runBettingRound(pages, Array(pages.length).fill('call'));

    await discardIfNeeded(pages);

    await doEquationForming(pages);

    // Second round betting — player 1 raises, players 2-4 call, player 5 folds
    await pause(pages[0]!);
    await runBettingRound(pages, ['raise', 'call', 'call', 'call', 'fold']);

    await pause(pages[0]!);
    await doHiLoSelection(pages);

    await pause(pages[0]!, 3000);
    await acknowledgeResults(pages);
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
    test('two full hands: lobby → hand 1 → hand 2', async ({ browser }) => {
        test.setTimeout(300000); // 5 minutes for two full hands in debug mode
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

        const roomCodeText = await hostPage.locator('#roomCodeContainer').innerText();
        const roomCode = roomCodeText.split(' ')[1];
        expect(roomCode).toMatch(/^[A-Z0-9]{4}$/);

        await hostPage.fill('#nameInput', 'Host');
        await hostPage.click('#submitNameButton');
        await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText('Host');

        for (const [i, page] of playerPages.entries()) {
            await page.fill('#roomCodeInput', roomCode);
            await page.click('#enterRoomButton');
            await page.fill('#nameInput', `Player${i + 1}`);
            await page.click('#submitNameButton');
        }

        for (let i = 1; i < NUM_PLAYERS; i++) {
            await expect(hostPage.locator('#lobbyPlayerListContainer')).toContainText(`Player${i}`);
        }

        await expect(hostPage.locator('#startButton')).toBeEnabled({ timeout: 5000 });
        await hostPage.click('#startButton');

        for (const page of pages) {
            await expect(page.locator('#potContainer')).toBeVisible({ timeout: 5000 });
            await expect(page.locator('#homeContainer')).toBeHidden();
        }

        // --- Hand 1 ---
        await playHand(pages);

        // --- Hand 2: verify the game looped back and play it through ---
        for (const page of pages) {
            await expect(page.locator('#potContainer')).toBeVisible({ timeout: 10000 });
            await expect(page.locator('#homeContainer')).toBeHidden();
        }

        await playHand(pages);

        // After hand 2 results are acknowledged, game should still be running (not on home screen)
        for (const page of pages) {
            await expect(page.locator('#homeContainer')).toBeHidden({ timeout: 5000 });
        }

        await Promise.all(contexts.map(ctx => ctx.close()));
    });
});
