import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './automated_testing',
  timeout: 120000,
  use: {
    baseURL: 'http://localhost:8080',
    ...devices['iPhone 15 Pro'],
  },
  webServer: {
    command: 'GAME_MODE=debug npm start',
    port: 8080,
    reuseExistingServer: !process.env.CI,
  },
});
