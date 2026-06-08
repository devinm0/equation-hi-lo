import { test, expect } from '@playwright/test';
import { attachBrowserLogging } from './_logging.js';

// The How-to-Play modal's tiebreaker examples (.eg-tie rows) used to left-pack on a wide
// (laptop) viewport, leaving a big empty gap on the right so the section looked off-centre.
// This test opens the rules modal at a laptop size and asserts each tiebreaker row is
// horizontally centred within its container (left gap ≈ right gap).

test.describe('Rules modal on a laptop-size screen', () => {
    test('tiebreaker rows are centred, not left-packed', async ({ browser }) => {
        test.setTimeout(60000);

        // A typical laptop viewport — NOT the mobile default the rest of the suite uses.
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            isMobile: false,
            hasTouch: false,
        });
        const page = await context.newPage();
        attachBrowserLogging(page, 'laptop');
        await page.goto('/');

        // Open the How-to-Play modal from the home screen.
        await page.click('#helpButton');
        await expect(page.locator('#rulesModal')).toBeVisible();

        const tieRows = page.locator('#rulesModal .eg-tie');
        const count = await tieRows.count();
        expect(count).toBeGreaterThan(0);

        // For each row, measure the left gap (row left edge → first child) and right gap
        // (last child → row right edge). Centred content makes these equal; left-packed
        // content makes the left gap ~0 and the right gap large.
        const gaps = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('#rulesModal .eg-tie')) as HTMLElement[];
            return rows.map(row => {
                const rowBox = row.getBoundingClientRect();
                const children = Array.from(row.children) as HTMLElement[];
                const first = children[0]!.getBoundingClientRect();
                const last = children[children.length - 1]!.getBoundingClientRect();
                return {
                    left: first.left - rowBox.left,
                    right: rowBox.right - last.right,
                };
            });
        });

        for (const [i, g] of gaps.entries()) {
            // Centred: gaps are symmetric. The small (~3-4px) allowance is the trailing
            // .eg-card's 3px right margin (getBoundingClientRect is a border box, so it
            // excludes margins) plus sub-pixel rounding — NOT a centring error. A
            // left-packed row would instead read left≈0 / right≈400px, so this still fails
            // loudly if the centring regresses.
            expect(Math.abs(g.left - g.right), `eg-tie row ${i} should be centred (left=${g.left}, right=${g.right})`).toBeLessThan(10);
            // Sanity: there IS meaningful empty space on a wide modal (so this isn't trivially
            // passing on a row that already fills the whole width).
            expect(g.left, `eg-tie row ${i} should have real left padding when centred`).toBeGreaterThan(20);
        }

        await context.close();
    });
});
