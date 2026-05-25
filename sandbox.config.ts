import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './automated_testing',
  testMatch: '**/sandbox.test.ts',
  timeout: 600000,
  use: {
    baseURL: 'http://localhost:8080',
    ...devices['iPhone 15 Pro'],
  },
  webServer: {
    command: 'GAME_MODE=debug npm start',
    port: 8080,
    reuseExistingServer: true,
  },
});
