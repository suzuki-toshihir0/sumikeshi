import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  webServer: {
    command: 'npx vite --port 5173',
    port: 5173,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://localhost:5173/sumikeshi/',
  },
  projects: [
    {
      name: 'desktop',
      testMatch: /basic\.spec\.ts/,
    },
    {
      name: 'mobile',
      use: {
        ...devices['iPhone 14'],
        // CDPセッション（タッチドラッグテスト）にはChromiumが必要
        browserName: 'chromium',
      },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
});
