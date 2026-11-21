import { defineConfig, devices } from '@playwright/test'

const url = 'http://127.0.0.1:' + (process.env.BUDGET_CLOUD_TEST_PORT ?? '4191')

export default defineConfig({
  outputDir: './test-results-cloud',
  testDir: './tests/cloud-e2e',
  workers: 1,
  timeout: 125_000,
  use: { baseURL: url, locale: 'ru-RU', timezoneId: 'Asia/Novosibirsk' },
  projects: [
    { name: 'Chromium', use: { browserName: 'chromium', ...devices['iPhone 13'] } },
    { name: 'WebKit', use: { ...devices['iPhone 13'] } },
  ],
  webServer: { command: 'node scripts/cloud-test-server.mjs', url: url + '/', timeout: 75_000 },
})
