// Browser-side logging companion to the Playwright trace.
//
// The Playwright trace already captures test actions + client console + network. This
// additionally mirrors the browser console and uncaught page errors to a plain text file
// (logs/e2e-client.log) so they can be grepped directly after a run without opening the
// trace viewer. Server-side output is captured separately to logs/e2e-server.log (see
// playwright.config.ts) — Playwright cannot see the server process.

import { appendFileSync } from 'fs';
import type { Page } from '@playwright/test';

export const CLIENT_LOG = 'logs/e2e-client.log';

function ts() {
    return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

export function attachBrowserLogging(page: Page, label: string) {
    // Uncaught exceptions in the page — the most important signal for client bugs.
    page.on('pageerror', err => {
        appendFileSync(CLIENT_LOG, `${ts()} [${label}] PAGEERROR: ${err.message}\n${err.stack ?? ''}\n`);
    });

    page.on('console', async msg => {
        let text: string;
        try {
            // Resolve real values so logged objects (e.g. result objects) are readable
            // instead of "JSHandle@object".
            const args = await Promise.all(msg.args().map(a => a.jsonValue()));
            text = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
        } catch {
            text = msg.text();
        }
        appendFileSync(CLIENT_LOG, `${ts()} [${label}] ${msg.type()}: ${text}\n`);
    });
}
