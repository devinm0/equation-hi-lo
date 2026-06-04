import { test, expect, Browser, BrowserContext, Page, devices } from '@playwright/test';

const NUM_PLAYERS = 10;

// One distinct iPhone model per player — covers all major viewport sizes (13+)
const IPHONE_DEVICES = [
    devices['iPhone 13 Mini'],       // 375×812
    devices['iPhone 13'],            // 390×844
    devices['iPhone 13 Pro'],        // 390×844
    devices['iPhone 13 Pro Max'],    // 428×926
    devices['iPhone 14'],            // 390×844
    devices['iPhone 14 Plus'],       // 428×926
    devices['iPhone 14 Pro'],        // 393×852
    devices['iPhone 14 Pro Max'],    // 430×932
    devices['iPhone 15 Pro'],        // 393×852
    devices['iPhone 15 Pro Max'],    // 430×932
];

async function pause(page: Page, ms = 1000) {
    if (!process.env.CI) await page.waitForTimeout(ms);
}

async function discardIfNeeded(pages: Page[]) {
    // Identify who needs to discard in parallel (avoids N sequential timeouts)
    const needsDiscard = await Promise.all(pages.map(async (page) => {
        try {
            await page.locator('.card-highlighted').first().waitFor({ state: 'visible', timeout: 10000 });
            return true;
        } catch {
            return false;
        }
    }));

    const discardQueue = pages.filter((_, i) => needsDiscard[i]);

    // Execute discards one at a time so we can assert between each:
    // betting controls must not appear while any player still has a pending discard.
    for (let i = 0; i < discardQueue.length; i++) {
        await discardQueue[i]!.locator('.card-highlighted').first().click({ force: true });
        await discardQueue[i]!.locator('.card-highlighted').first().waitFor({ state: 'hidden', timeout: 10000 });

        if (i < discardQueue.length - 1) {
            for (const page of pages) {
                expect(
                    await page.locator('#bettingControls').isVisible(),
                    'Betting controls appeared before all discards completed'
                ).toBe(false);
            }
        }
    }
}

async function findBettingPage(pages: Page[], timeout = 30000): Promise<Page | undefined> {
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

        // Pause BEFORE acting so the betting controls are visible to watch in headed mode,
        // instead of being clicked the instant they appear.
        await pause(bettingPage!, 1000);

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
    // Sync buffer: let the server complete the round and deal/transition to the next phase
    // (e.g. last-card deal + discard highlight) before the next test step runs.
    if (pages[0]) await pause(pages[0], 2000);
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
        await expect(lockButton).toBeHidden({ timeout: 8000 });
    }));
}

async function doHiLoSelection(pages: Page[]) {
    await Promise.all(pages.map(async (page) => {
        const modal = page.locator('#choiceModal');
        try {
            await modal.waitFor({ state: 'visible', timeout: 20000 });
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
            await button.waitFor({ state: 'visible', timeout: 30000 });
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

    // Second round betting — player 1 raises, players 2-9 call, player 10 folds.
    // May be skipped if maxRaiseReached was set during first-round betting (all-in).
    await pause(pages[0]!);
    const secondRoundPage = await findBettingPage(pages, 4000);
    if (secondRoundPage) {
        await runBettingRound(pages, ['raise', 'call', 'call', 'call', 'call', 'call', 'call', 'call', 'call', 'fold']);
    }

    await pause(pages[0]!);
    await doHiLoSelection(pages);

    await pause(pages[0]!, 3000);
    await acknowledgeResults(pages);
}

async function setupPlayers(browser: Browser): Promise<{ pages: Page[]; contexts: BrowserContext[] }> {
    const contexts = await Promise.all(
        [...Array(NUM_PLAYERS)].map((_, i) =>
            browser.newContext(i < IPHONE_DEVICES.length ? IPHONE_DEVICES[i]! : {})
        )
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

    // Position windows in a grid so none overlap (Chromium headed only)
    const colW = 450;
    const colH = 520;
    const cols = Math.ceil(Math.sqrt(NUM_PLAYERS));
    try {
        const cdp = await browser.newBrowserCDPSession();
        for (const [i, page] of pages.entries()) {
            const device = i < IPHONE_DEVICES.length ? IPHONE_DEVICES[i] : undefined;
            const w = device?.viewport?.width ?? 390;
            const h = device?.viewport?.height ?? 844;
            const pageSession = await page.context().newCDPSession(page);
            const { targetInfo } = await (pageSession as any).send('Target.getTargetInfo');
            const { windowId } = await (cdp as any).send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
            await (cdp as any).send('Browser.setWindowBounds', {
                windowId,
                bounds: {
                    left: (i % cols) * colW,
                    top: Math.floor(i / cols) * colH,
                    width: w,
                    height: h,
                },
            });
            await pageSession.detach();
        }
        await cdp.detach();
    } catch (e) {
        console.warn('Window positioning failed (headless or non-Chromium):', e);
    }

    return { pages, contexts };
}

test.describe('Multiplayer game flow', () => {
    test('two full hands: lobby → hand 1 → hand 2', async ({ browser }) => {
        test.setTimeout(600000); // 10 minutes for two full hands with 10 players
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

        // --- Hand 2: verify the game looped back ---
        for (const page of pages) {
            await expect(page.locator('#potContainer')).toBeVisible({ timeout: 10000 });
            await expect(page.locator('#homeContainer')).toBeHidden();
        }

        await pages[0]!.waitForTimeout(2000);

        await Promise.all(contexts.map(ctx => ctx.close()));
    });
});
