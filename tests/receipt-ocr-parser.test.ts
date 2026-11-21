import { describe, expect, it } from 'vitest'
import { parseReceiptText } from '../src/receipts/ocr-parser'

describe('receipt OCR text parsing', () => {
  it('reads a shop, date and exact totals while excluding payment, taxes and fiscal lines', () => {
    const parsed = parseReceiptText(`
      МАГАЗИН РЯБИНА
      ИНН 5401000000
      КАССОВЫЙ ЧЕК
      20.11.2026 17:42
      Молоко пастеризованное 89,90
      В Т.Ч. НДС 10% 8,17
      ИТОГ 1 189,90
      БЕЗНАЛИЧНЫМИ 1 189,90
      ФН 000110000105
    `)

    expect(parsed).toMatchObject({ store: 'МАГАЗИН РЯБИНА', date: '2026-11-20', total: 118990 })
    expect(parsed.items).toMatchObject([{ name: 'Молоко пастеризованное', amount: 8990 }])
  })

  it('joins wrapped item names and extracts weight, quantity and unit price', () => {
    const parsed = parseReceiptText(`
      ПРИХОД
      Сыр сливочный
      без добавок
      0,584 кг × 129,90 = 75,86
      Булочка
      89,90 x 2 шт 179,80
      К ОПЛАТЕ 255,66
    `)

    expect(parsed.items).toMatchObject([
      { name: 'Сыр сливочный без добавок', quantity: '0.584', unit: 'кг', amount: 7586, unitPrice: 12990, needsReview: false },
      { name: 'Булочка', quantity: '2', unit: 'шт', amount: 17980, unitPrice: 8990, needsReview: false },
    ])
    expect(parsed.total).toBe(25566)
  })

  it('keeps a printed discount alongside the actual line amount', () => {
    const parsed = parseReceiptText(`
      Чек продажи
      Печенье 80.00
      Скидка -8.00
      С учетом скидки 72.00
      ВСЕГО 72.00
    `)

    expect(parsed.items).toMatchObject([{ name: 'Печенье', discount: 800, amount: 7200 }])
    expect(parsed.total).toBe(7200)
  })

  it('preserves the original text and flags uncertain amounts without inventing an item or total', () => {
    const parsed = parseReceiptText(`
      КАССОВЫЙ ЧЕК
      31.02.2026
      Рис длиннозернистый
      3 x 51,20 = 155,60
      Салфетки 1?3,9З
      Промежуточный итог 155,60
      НДС 10% 14,15
      ОПЛАТА КАРТОЙ 155,60
    `)

    expect(parsed.date).toBeUndefined()
    expect(parsed.total).toBeUndefined()
    expect(parsed.items).toMatchObject([
      { originalName: 'Рис длиннозернистый', name: 'Рис длиннозернистый', amount: 15560, needsReview: true },
    ])
  })

  it('reads a final total when its label and amount are on separate lines', () => {
    expect(parseReceiptText('Сок яблочный 147.90\nИTОГ\n=147.90\nНАЛИЧНЫМИ 147.90')).toMatchObject({
      total: 14790,
      items: [{ name: 'Сок яблочный', amount: 14790 }],
    })
  })

  it('extracts fiscal item rows with trailing VAT before a late transaction marker', () => {
    const parsed = parseReceiptText(`
      000 «МАГАЗИН РЯБИНА»
      Хлеб ржаной 1*51,99=51,99 НДС 10%
      Крупа гречневая 2*74,99-149,98 HAC 10%
      ИТОГ 201,97
      ПРИХОД 20,11,26 17:59
    `)
    expect(parsed).toMatchObject({ store: '000 «МАГАЗИН РЯБИНА»', date: '2026-11-20', total: 20197 })
    expect(parsed.items).toMatchObject([
      { name: 'Хлеб ржаной', quantity: '1', amount: 5199, needsReview: false },
      { name: 'Крупа гречневая', quantity: '2', amount: 14998, needsReview: true },
    ])
  })

  it('excludes a card terminal copy and visibly malformed merged amounts', () => {
    const parsed = parseReceiptText(`
      000 «РЯБИНА»
      КАССОВЫЙ. ЧЕК
      Хлеб ржаной 1*51,99=51,99 НДС 10%
      Чай чёрный 1*100,00100.00 НДС 22%
      Молоко 0.226799, 99180.80 НДС 10%
      ПАО СБЕРБАНК  оплата
      Сумма (РУБ) 151,99
      Комиссия за операцию 0,00
      ИТОГ 151,99
      ПРИХОД 20.11.26 17:59
    `)
    expect(parsed).toMatchObject({ store: '000 «РЯБИНА»', total: 15199, items: [{ name: 'Хлеб ржаной', amount: 5199 }] })
  })

  it('identifies explicit printed returns and corrections for safe import', () => {
    expect(parseReceiptText('КАССОВЫЙ ЧЕК\nМолоко 89.90\nИТОГ 89.90\nВОЗВРАТ ПРИХОДА 20.11.2026 17:59').transactionType).toBe('return')
    expect(parseReceiptText('КАССОВЫЙ ЧЕК КОРРЕКЦИИ\nПРИХОД\nИТОГ 89.90').transactionType).toBe('other')
    expect(parseReceiptText('КАССОВЫЙ ЧЕК\nКнига «Возврат прихода» 89.90\nИТОГ 89.90').transactionType).toBeUndefined()
  })

  it('preserves dimensions in a product name and reads the trailing printed quantity', () => {
    const parsed = parseReceiptText('Пакет 40×64 см 2*10,00=20,00 НДС 22%\nИТОГ 20,00')
    expect(parsed.items).toMatchObject([{ name: 'Пакет 40×64 см', quantity: '2', unitPrice: 1000, amount: 2000 }])
  })
})
