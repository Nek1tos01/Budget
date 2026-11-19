import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://localhost:4187', timezoneId: 'Asia/Novosibirsk', locale: 'ru-RU', trace: 'retain-on-failure' },
  projects: [
    { name: 'Chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'WebKit', use: { ...devices['iPhone 13'] } },
  ],
  webServer: { command: 'npm run preview -- --port 4187 --strictPort', url: 'http://localhost:4187', reuseExistingServer: false },
})
