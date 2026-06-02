const { defineConfig, devices } = require('@playwright/test');

/**
 * DB 整合測試設定 — 真實打到 Supabase，不 mock
 * 執行方式：npx playwright test --config playwright.db.config.js
 */
module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.db.spec.js',
  timeout: 30000,
  retries: 1, // 網路問題重試一次
  reporter: 'list',

  globalSetup: './tests/setup/db-setup.js',
  globalTeardown: './tests/setup/db-teardown.js',

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },

  webServer: {
    command: 'node server.js',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 15000,
  },

  projects: [
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
