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
    // Tee server stdout to a log file so the hi-lo-selected handler logs (choices/order)
    // can be grepped after a manual repro. reuseExistingServer:false forces this fresh
    // command (with the tee) to run instead of reusing a server lingering on 8080.
    command: 'mkdir -p logs && GAME_MODE=debug npm start 2>&1 | tee logs/sandbox-server.log',
    port: 8080,
    reuseExistingServer: false,
  },
});
