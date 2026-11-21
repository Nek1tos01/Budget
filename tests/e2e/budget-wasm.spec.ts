import { expect, test } from '@playwright/test'

test('показывает прогноз текущей недели и месяца в бюджете и аналитике', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-05T12:00:00+07:00'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть демо-бюджет' }).click()
  await expect(page.getByRole('heading', { name: 'Бюджет', exact: true })).toBeVisible({ timeout: 20_000 })
  const week = page.getByRole('region', { name: 'Прогноз на неделю' })
  await expect(week.getByLabel('16 255 ₽', { exact: true })).toBeVisible()
  await expect(week.getByLabel('3 745 ₽', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Месяц', exact: true }).click()
  const month = page.getByRole('region', { name: 'Прогноз на месяц' })
  await expect(month.getByLabel('61 915 ₽', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Предыдущий период' }).click()
  await expect(month).toHaveCount(0)

  await page.getByRole('navigation').getByRole('button', { name: 'Аналитика', exact: true }).click()
  await expect(week.getByLabel('16 255 ₽', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Месяц', exact: true }).click()
  await expect(month.getByLabel('61 915 ₽', { exact: true })).toBeVisible()
})

test('позволяет повторить загрузку ядра после временной ошибки', async ({ page }) => {
  await page.route('**/assets/budget-core-*.wasm', route => route.fulfill({ status: 503, body: '' }), { times: 1 })
  await page.goto('/')
  const error = page.getByRole('alert').filter({ hasText: 'Не удалось загрузить финансовое ядро' })
  await expect(error).toBeVisible()
  await error.getByRole('button', { name: 'Попробовать снова' }).click()
  await page.getByRole('button', { name: 'Открыть демо-бюджет' }).click()
  await expect(page.getByRole('region', { name: 'Остаток бюджета' }).getByLabel('7 550 ₽', { exact: true })).toBeVisible()
})

test('отдаёт настоящее WASM и рассчитывает бюджет после офлайн-перезагрузки', async ({ page, context }) => {
  const moduleResponse = page.waitForResponse(response => /\/assets\/budget-core-[^/]+\.wasm$/.test(new URL(response.url()).pathname))
  await page.goto('/')
  const response = await moduleResponse
  expect(response.ok()).toBe(true)
  expect(response.headers()['content-type']).toContain('application/wasm')
  expect([...(await response.body()).subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d])

  await page.getByRole('button', { name: 'Открыть демо-бюджет' }).click()
  await expect(page.getByRole('heading', { name: 'Бюджет', exact: true })).toBeVisible({ timeout: 20_000 })
  const balance = page.getByRole('region', { name: 'Остаток бюджета' }).getByLabel('7 550 ₽', { exact: true })
  await expect(balance).toBeVisible()
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  expect(await page.evaluate(async url => (await caches.match(url))?.ok, response.url())).toBe(true)

  await context.setOffline(true)
  await page.reload()
  await expect(balance).toBeVisible()
})
