import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/media-e2e',
  outputDir: './test-results-receipt-media',
  use: { baseURL: 'http://localhost:4189', trace: 'retain-on-failure' },
  projects: [
    { name: 'Chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'WebKit', use: { ...devices['iPhone 13'] } },
  ],
  webServer: { command: 'npm run dev -- --port 4189 --strictPort', url: 'http://localhost:4189', reuseExistingServer: false },
})
