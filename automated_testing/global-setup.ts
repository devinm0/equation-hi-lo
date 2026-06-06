// Runs once before the E2E suite. Truncates the client log so each suite run
// starts with a clean, inspectable logs/e2e-client.log (browser + test actions).
import { mkdirSync, writeFileSync } from 'fs';

export default function globalSetup() {
    mkdirSync('logs', { recursive: true });
    writeFileSync('logs/e2e-client.log', `=== e2e client+test log: ${new Date().toISOString()} ===\n`);
}
