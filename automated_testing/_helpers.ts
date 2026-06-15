// Shared E2E helpers used by every spec, so fixes apply to ALL tests at once
// (no per-file drift).
import { expect, Page, BrowserContext } from '@playwright/test';

// ---------------------------------------------------------------------------
// Winner verification — reads what's ACTUALLY RENDERED on the results page
// ---------------------------------------------------------------------------
// Rather than trusting the server's round-result payload, this reads the results
// screen DOM each hand — the winner highlight (#trophy-<id> / .winner-div) and each
// player's shown equation result (=<n> in a .difference-card) and bet side (the
// visible #low-symbol-/#high-symbol- chips) — and independently checks that the
// player shown as the winner is actually who SHOULD have won. Rules mirrored:
// closest to 1 (low) / 20 (high); a swing better wins only by sweeping BOTH sides,
// otherwise each side goes to the best PURE low/high better; ties break to the lower
// (low) / higher (high) single card value. Suit isn't shown, so on a card-value tie we
// accept any still-tied player.

interface ResultRow {
    id: string;
    shownWinner: boolean;   // a trophy / winner highlight is visible for this player
    choseLow: boolean;
    choseHigh: boolean;
    lowResult: number | null;
    highResult: number | null;
    lowCard: number | null;  // lowest number card shown (low-side tiebreak)
    highCard: number | null; // highest number card shown (high-side tiebreak)
}

// Scrape the rendered results for every player on this page.
async function readResultsFromPage(page: Page): Promise<ResultRow[]> {
    return await page.evaluate(() => {
        const rows: any[] = [];
        const hands = Array.from(document.querySelectorAll('[id^="hand-"]')) as HTMLElement[];
        for (const handDiv of hands) {
            const id = handDiv.id.slice('hand-'.length);

            const trophy = document.getElementById('trophy-' + id);
            const shownWinner = handDiv.classList.contains('winner-div') ||
                (!!trophy && !trophy.classList.contains('hidden'));

            const loSym = document.getElementById('low-symbol-' + id);
            const hiSym = document.getElementById('high-symbol-' + id);
            const choseLow = !!loSym && !loSym.classList.contains('hidden');
            const choseHigh = !!hiSym && !hiSym.classList.contains('hidden');

            // Low difference-card is a direct child of the hand div; the high one lives in
            // the "other equation" sub-div (the only direct-child div containing a result).
            const lowDiffCard = handDiv.querySelector(':scope > .difference-card');
            const otherDiv = Array.from(handDiv.querySelectorAll(':scope > div'))
                .find(d => d.querySelector('.difference-card')) || null;
            const highDiffCard = otherDiv ? otherDiv.querySelector('.difference-card') : null;

            const parse = (card: Element | null): number | null => {
                const rp = card ? card.querySelector('.result-paragraph') : null;
                if (!rp || !rp.textContent) return null;
                const v = parseFloat(rp.textContent.replace('=', '').trim());
                return Number.isFinite(v) ? v : null;
            };
            const numVals = (root: Element): number[] =>
                Array.from(root.querySelectorAll(':scope > .card.number-card'))
                    .map(c => parseInt((c as HTMLElement).dataset.value || ''))
                    .filter(n => !Number.isNaN(n));

            const lowNums = numVals(handDiv);
            const highNums = otherDiv ? numVals(otherDiv) : [];

            rows.push({
                id,
                shownWinner,
                choseLow,
                choseHigh,
                lowResult: choseLow ? parse(lowDiffCard) : null,
                highResult: choseHigh ? parse(highDiffCard) : null,
                lowCard: lowNums.length ? Math.min(...lowNums) : null,
                highCard: highNums.length ? Math.max(...highNums) : null,
            });
        }
        return rows;
    });
}

// Closest to `target`, breaking ties by single card value (min for low, max for high).
// Returns the still-tied ids (length 1 when unique; >1 only when an unseen suit decides).
function bestIds(cands: { id: string; result: number; card: number }[], target: number, cardDir: 'min' | 'max'): string[] {
    if (cands.length === 0) return [];
    const diff = (c: { result: number }) => Math.abs(c.result - target);
    const minDiff = Math.min(...cands.map(diff));
    let tied = cands.filter(c => diff(c) === minDiff);
    if (tied.length > 1) {
        const cardVals = tied.map(c => c.card);
        const pick = cardDir === 'min' ? Math.min(...cardVals) : Math.max(...cardVals);
        tied = tied.filter(c => c.card === pick);
    }
    return tied.map(c => c.id);
}

function computeExpectedWinners(rows: ResultRow[]): { expectedLo: string[]; expectedHi: string[]; sweepId: string | null } {
    const low = rows.filter(r => r.choseLow && typeof r.lowResult === 'number')
        .map(r => ({ id: r.id, result: r.lowResult as number, card: r.lowCard ?? Infinity }));
    const high = rows.filter(r => r.choseHigh && typeof r.highResult === 'number')
        .map(r => ({ id: r.id, result: r.highResult as number, card: r.highCard ?? -Infinity }));

    const swing = new Set(rows.filter(r => r.choseLow && r.choseHigh).map(r => r.id));
    const pureLow = low.filter(c => !swing.has(c.id));
    const pureHigh = high.filter(c => !swing.has(c.id));

    const loIncl = bestIds(low, 1, 'min');
    const hiIncl = bestIds(high, 20, 'max');
    const loSwing = bestIds(low.filter(c => swing.has(c.id)), 1, 'min');
    const hiSwing = bestIds(high.filter(c => swing.has(c.id)), 20, 'max');

    let sweepId: string | null = null;
    for (const id of swing) {
        if (loIncl.includes(id) && hiIncl.includes(id) && loSwing.includes(id) && hiSwing.includes(id)) {
            sweepId = id;
            break;
        }
    }

    return {
        expectedLo: sweepId ? [sweepId] : bestIds(pureLow, 1, 'min'),
        expectedHi: sweepId ? [sweepId] : bestIds(pureHigh, 20, 'max'),
        sweepId,
    };
}

// Verify the winner(s) shown on the current results screen are the players who should
// have won, based on the results actually rendered on the page.
export async function assertResultsPageWinners(page: Page) {
    const rows = await readResultsFromPage(page);
    if (rows.length === 0) return; // not a results screen on this page

    const { expectedLo, expectedHi, sweepId } = computeExpectedWinners(rows);
    const shown = rows.filter(r => r.shownWinner).map(r => r.id);

    if (sweepId) {
        expect(shown.slice().sort(), `only the swing sweeper (${sweepId}) should be shown as winner`).toEqual([sweepId]);
        return;
    }

    const expectLoWin = expectedLo.length > 0;
    const expectHiWin = expectedHi.length > 0;
    expect(shown.length, 'number of winners highlighted on the results page')
        .toBe((expectLoWin ? 1 : 0) + (expectHiWin ? 1 : 0));

    if (expectLoWin) {
        const loShown = rows.filter(r => r.shownWinner && r.choseLow && !r.choseHigh).map(r => r.id);
        expect(loShown.length, 'exactly one low winner shown').toBe(1);
        expect(expectedLo, `shown low winner ${loShown[0]} must be the player whose shown result is closest to 1`).toContain(loShown[0]);
    }
    if (expectHiWin) {
        const hiShown = rows.filter(r => r.shownWinner && r.choseHigh && !r.choseLow).map(r => r.id);
        expect(hiShown.length, 'exactly one high winner shown').toBe(1);
        expect(expectedHi, `shown high winner ${hiShown[0]} must be the player whose shown result is closest to 20`).toContain(hiShown[0]);
    }
}

// Shared results acknowledgement used by every spec: on each results screen it first
// verifies the rendered winner is correct (every hand), then dismisses it. Returns the
// number of pages that actually saw the results modal.
export async function acknowledgeResults(pages: Page[]): Promise<number> {
    const acked = await Promise.all(pages.map(async (page) => {
        const button = page.locator('#confirmResults');
        try {
            await button.waitFor({ state: 'visible', timeout: 20000 });
        } catch {
            return false; // out/folded player — no results button, or hand stalled
        }
        await assertResultsPageWinners(page);
        await button.click({ force: true });
        await pause(page, 1500);
        return true;
    }));
    return acked.filter(Boolean).length;
}

async function pause(page: Page, ms: number) {
    if (!process.env.CI) await page.waitForTimeout(ms);
}

// Discard the highlighted (multiply) card for any player who must, then return.
//
// A multiply-card discard highlight renders within a second or two of the deal, and the
// callers always run this right after a deal that has been given a sync buffer to land, so
// a short detection window is both reliable and fast. Non-discarding players wait out the
// window once (in parallel), not 10s.
export async function discardIfNeeded(pages: Page[]) {
    const needsDiscard = await Promise.all(pages.map(async (page) => {
        try {
            await page.locator('.card-highlighted').first().waitFor({ state: 'visible', timeout: 3000 });
            return true;
        } catch {
            return false;
        }
    }));

    const discardQueue = pages.filter((_, i) => needsDiscard[i]);
    for (const page of discardQueue) {
        await page.locator('.card-highlighted').first().click({ force: true });
        await page.locator('.card-highlighted').first().waitFor({ state: 'hidden', timeout: 8000 });
        await pause(page, 1500);
    }
}

// Like discardIfNeeded, but for EACH player who must discard it also exercises the
// disconnect-resilience contract. For every such player (works in BOTH the first- and
// second-deal discard phases) it:
//   1. drops them BEFORE they discard (force-closes the live socket; setOffline keeps the
//      backoff retries failing),
//   2. has them attempt the discard while offline — the click fires but socket.send() throws,
//      so it never reaches the server (and the local highlight isn't even cleared),
//   3. reconnects them, and asserts the SERVER re-pushes the still-pending discard requirement:
//      a fresh `deal` for the player's own hand carrying multiplicationCardDealt. Had the
//      offline discard registered, needToDiscard would be false and no such deal would replay.
//   4. only THEN discards for real, which (socket now open) actually reaches the server.
// The game can't leave the deal phase until this real discard lands, so a dropped discarder
// blocks progress exactly as in production.
export async function discardWithReconnect(pages: Page[], contexts: BrowserContext[]) {
    const needsDiscard = await Promise.all(pages.map(async (page) => {
        try {
            await page.locator('.card-highlighted').first().waitFor({ state: 'visible', timeout: 3000 });
            return true;
        } catch {
            return false;
        }
    }));

    for (let i = 0; i < pages.length; i++) {
        if (!needsDiscard[i]) continue;
        const page = pages[i]!;
        const ctx = contexts[i]!;

        // This player's persistent id — used to match the `deal` the server replays to THEM.
        const myId = await page.evaluate(() => localStorage.getItem('userId'));

        // Record replayed discard-requirement deals for this player's OWN hand. page.on
        // ('websocket') also fires for the reconnect socket, so this catches the post-reconnect
        // replay. The original deal arrived on the page's first socket, before this listener was
        // attached, so the count legitimately starts at 0 and any increment is the replay.
        const ownDiscardDeals: any[] = [];
        const onWs = (ws: any) => ws.on('framereceived', (f: any) => {
            try {
                const m = JSON.parse(f.payload as string);
                if (m.type === 'deal' && m.id === myId && m.multiplicationCardDealt === true) {
                    ownDiscardDeals.push(m);
                }
            } catch {}
        });
        page.on('websocket', onWs);

        await setDanceBanner(page, '⚡ DISCARD PLAYER DISCONNECTED — trying to discard offline', 'red');

        // 1. Drop before discarding.
        await ctx.setOffline(true);
        await page.evaluate(() => (window as any).__simulateSocketDrop());

        // 2. Attempt the discard while offline (never reaches the server).
        await page.locator('.card-highlighted').first().click({ force: true }).catch(() => {});
        await pause(page, 1500);

        // 3. Reconnect.
        await ctx.setOffline(false);
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

        // 4. Proof the offline discard never registered: the server replays the requirement.
        await expect
            .poll(() => ownDiscardDeals.length, {
                message: 'server should re-push the discard requirement on reconnect (the offline discard never registered)',
                timeout: 20000,
            })
            .toBeGreaterThan(0);
        // And the cards highlight again, so the player must discard a second time.
        await expect(page.locator('.card-highlighted').first()).toBeVisible({ timeout: 10000 });

        await setDanceBanner(page, '✅ RECONNECTED — discarding for real', 'green');

        // 5. Discard for real — socket is open now, so this one reaches the server.
        await page.locator('.card-highlighted').first().click({ force: true });
        await page.locator('.card-highlighted').first().waitFor({ state: 'hidden', timeout: 8000 });
        await pause(page, 1500);

        await page.evaluate(() => document.getElementById('__danceBanner')?.remove());
        page.off('websocket', onWs);
    }
}

async function setDanceBanner(page: Page, text: string, bg: string) {
    await page.evaluate(({ text, bg }) => {
        let b = document.getElementById('__danceBanner');
        if (!b) {
            b = document.createElement('div');
            b.id = '__danceBanner';
            b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;color:#fff;font:bold 15px sans-serif;text-align:center;padding:8px';
            document.body.appendChild(b);
        }
        b.textContent = text;
        b.style.background = bg;
    }, { text, bg });
}

// Arrange each non-folded player's cards into a VALID, FINITE equation and lock it in.
//
// Crucially this searches number orderings with the real client evaluator (window.applyOps)
// and only locks in an arrangement whose result is finite — so a player is never left with a
// 0/0 -> NaN or x/0 -> Infinity equation. Such an equation can't be locked in (the client
// guard blocks it) and would instead be auto-folded when the 20s equation timer expires,
// causing spurious folds. If no finite arrangement exists (e.g. an all-zeros hand), the
// player legitimately can't form an equation and is left to fold.
export async function doEquationForming(pages: Page[]) {
    await Promise.all(pages.map(async (page) => {
        const lockButton = page.locator('#confirmEquationFormed');
        try {
            await lockButton.waitFor({ state: 'visible', timeout: 30000 });
        } catch {
            return; // folded/out player — no lock button
        }

        const arranged = await page.evaluate(() => {
            const myHand = document.querySelector('.my-hand')!;
            const allCards = Array.from(myHand.querySelectorAll('.card')) as HTMLElement[];

            const numCards = allCards.filter(c => c.classList.contains('number-card'));
            const rootCards = allCards.filter(c => c.classList.contains('operator-card') && c.dataset.value === '√');
            const binaryOpCards = allCards.filter(c => c.classList.contains('operator-card') && c.dataset.value !== '√');

            if (numCards.length !== binaryOpCards.length + 1) {
                console.log('[eq] cannot form equation: numCards', numCards.length, 'binaryOps', binaryOpCards.length);
                return false;
            }

            // Interleave a number ordering into a valid equation: [√?, num, op, √?, num, op, ..., num]
            const build = (nums: HTMLElement[]) => {
                const ordered: HTMLElement[] = [];
                for (let i = 0; i < nums.length; i++) {
                    if (i < rootCards.length) ordered.push(rootCards[i]!);
                    ordered.push(nums[i]!);
                    if (i < binaryOpCards.length) ordered.push(binaryOpCards[i]!);
                }
                return ordered;
            };

            const permute = (arr: HTMLElement[]): HTMLElement[][] => {
                if (arr.length <= 1) return [arr];
                const out: HTMLElement[][] = [];
                for (let i = 0; i < arr.length; i++) {
                    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
                    for (const p of permute(rest)) out.push([arr[i]!, ...p]);
                }
                return out;
            };

            // Try number orderings until the REAL client evaluator returns a finite result.
            let chosen: HTMLElement[] | null = null;
            for (const perm of permute(numCards)) {
                const ordered = build(perm);
                let result: number;
                try { result = (window as any).applyOps(ordered); } catch { continue; }
                if (Number.isFinite(result)) { chosen = ordered; break; }
            }

            if (!chosen) {
                console.log('[eq] no finite arrangement exists for this hand (likely all zeros)');
                return false;
            }

            chosen.forEach(card => myHand.appendChild(card));
            return true;
        });

        if (!arranged) return; // no finite arrangement (e.g. all zeros) — player will fold on timeout
        await pause(page, 1500);
        await lockButton.click();
        await expect(lockButton).toBeHidden({ timeout: 8000 });
    }));
}
