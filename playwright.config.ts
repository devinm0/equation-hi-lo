import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './automated_testing',
  testIgnore: '**/sandbox.test.ts',
  timeout: 120000,
  use: {
    baseURL: 'http://localhost:8080',
    browserName: 'chromium',
    isMobile: true,
    hasTouch: true,
    viewport: { width: 393, height: 852 }, // default; overridden per-context in tests
  },
  webServer: {
    command: 'GAME_MODE=debug npm start',
    port: 8080,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
