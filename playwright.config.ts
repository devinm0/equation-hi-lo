import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './automated_testing',
  testIgnore: '**/sandbox.test.ts',
  globalSetup: './automated_testing/global-setup.ts',
  timeout: 120000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:8080',
    browserName: 'chromium',
    isMobile: true,
    hasTouch: true,
    viewport: { width: 393, height: 852 }, // default; overridden per-context in tests
    // Capture test actions + client console + network + DOM snapshots for every run.
    // View with: npx playwright show-trace test-results/.../trace.zip
    trace: 'on',
  },
  webServer: {
    // Tee server output to a file so every run leaves an inspectable server log.
    command: 'mkdir -p logs && GAME_MODE=debug npm start 2>&1 | tee logs/e2e-server.log',
    port: 8080,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
