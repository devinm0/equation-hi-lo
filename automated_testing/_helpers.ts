// Shared E2E helpers used by every spec, so fixes apply to ALL tests at once
// (no per-file drift).
import { expect, Page } from '@playwright/test';

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
