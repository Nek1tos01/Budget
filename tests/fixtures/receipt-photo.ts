import type { Page } from '@playwright/test'

export async function syntheticReceiptPhoto(page: Page, date = '20.11.2026'): Promise<Buffer> {
  const encoded = await page.evaluate(date => {
    const canvas = document.createElement('canvas')
    canvas.width = 1060
    canvas.height = 980
    const context = canvas.getContext('2d')!
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#111'
    context.font = 'bold 46px Arial, sans-serif'
    context.fillText('МАГАЗИН РЯБИНА', 86, 100)
    context.font = '38px Arial, sans-serif'
    const rows = [
      'КАССОВЫЙ ЧЕК',
      date + ' 17:42',
      'Молоко пастеризованное',
      '1 шт x 89.90 = 89.90',
      'Хлеб ржаной',
      '2 шт x 50.00 = 100.00',
      'ИТОГ 189.90',
      'БЕЗНАЛИЧНЫМИ 189.90',
    ]
    for (const [index, row] of rows.entries()) context.fillText(row, 86, 194 + index * 87)
    return canvas.toDataURL('image/jpeg', .9).split(',')[1]
  }, date)
  return Buffer.from(encoded, 'base64')
}
