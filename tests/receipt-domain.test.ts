import { describe, expect, it } from 'vitest'
import { parseFiscalQr, receiptOperations, receiptSchema, suggestReceiptCategory, type Receipt } from '../src/domain/receipts'
import { engine } from '../src/domain/engine'
import type { Category } from '../src/domain/models'

const qr = 't=20261120T1742&s=2847.50&fn=000110000105&i=12345678&fp=123456&n=1'
const item = { id: 'item-a', originalName: 'Курица', name: 'Курица', quantity: '0.826', unit: 'кг', amount: 27257, categoryId: 'meat', needsReview: false }
const receipt: Receipt = {
  id: 'receipt-a', source: 'manual', store: 'Магазин', date: '2026-11-20', total: 37256,
  memberId: 'member-a', note: '', mode: 'split', categoryId: null, mismatchAccepted: false,
  items: [item, { ...item, id: 'item-b', categoryId: 'home', amount: 9999, discount: 100 }],
}

describe('receipt QR', () => {
  it('reads fiscal data and integer kopecks without losing leading zeroes', () => {
    const info = { date: '2026-11-20', time: '17:42', total: 284750, fn: '000110000105', i: '12345678', fp: '123456', n: 1 }
    expect(parseFiscalQr(qr)).toEqual(info)
    expect(parseFiscalQr(qr.split('&').reverse().join('&'))).toEqual(info)
    expect(parseFiscalQr(qr.replace('n=1', 'n=2')).n).toBe(2)
  })

  it.each([
    qr.replace('20261120', '20260229'), qr.replace('T1742', 'T2400'),
    qr.replace('2847.50', '0.00'), qr.replace('2847.50', '9007199254740992.01'),
    qr.replace('2847.50', '2e3'), qr.replace('2847.50', '1.235'), qr.replace('&n=1', ''),
    qr + '&s=1.00', 'https://example.com/?' + qr, 'обычный QR',
  ])('rejects invalid QR %s', raw => expect(() => parseFiscalQr(raw)).toThrow())
})

describe('receipt accounting', () => {
  it('projects a receipt once and uses the existing engine across week and month boundaries', () => {
    const rows = receiptOperations(receiptSchema.parse(receipt))
    expect(rows.map(row => [row.categoryId, row.amount, row.receiptId])).toEqual([
      ['meat', 27257, receipt.id], ['home', 9999, receipt.id],
    ])
    const date = Date.parse('2026-11-20T18:00Z')
    for (const period of [engine.period('week', date, 'Asia/Novosibirsk', 4), engine.period('month', date, 'Asia/Novosibirsk', 4)]) {
      expect(engine.summary(rows, period, 30000)).toMatchObject({ spent: receipt.total, remaining: -7256 })
    }
  })

  it('requires explicit handling of unmatched amounts', () => {
    const incomplete = { ...receipt, items: [item] }
    expect(receiptSchema.safeParse(incomplete).success).toBe(false)
    expect(receiptSchema.safeParse({ ...incomplete, mismatchAccepted: true }).success).toBe(false)
    const adjusted = receiptSchema.parse({ ...incomplete, mismatchAccepted: true, adjustmentCategoryId: 'home' })
    expect(receiptOperations(adjusted).map(row => row.amount)).toEqual([27257, 9999])
    expect(receiptSchema.safeParse({ ...receipt, total: 20000, mismatchAccepted: true, adjustmentCategoryId: 'home' }).success).toBe(false)
  })

  it('accounts for items in the same category on different budget schedules', () => {
    const scoped = receiptSchema.parse({
      ...receipt, source: 'photo', total: 37501, budgetAmount: 37600, roundingDelta: 99,
      roundingCategoryId: 'meat', mismatchAccepted: true, adjustmentCategoryId: 'meat', budgetScope: 'monthly_only',
      items: [item, { ...item, id: 'item-b', amount: 9999, budgetScope: 'weekly_and_monthly' }],
    })
    const rows = receiptOperations(scoped)
    expect(rows).toMatchObject([
      { categoryId: 'meat', budgetScope: 'monthly_only', amount: 27502 },
      { categoryId: 'meat', budgetScope: 'weekly_and_monthly', amount: 9999 },
      { categoryId: 'meat', budgetScope: 'monthly_only', amount: 99, actualAmount: 0, receiptRounding: true },
    ])
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length)
    expect(receiptOperations({ ...scoped, items: [...scoped.items].reverse() }).map(row => row.id).sort()).toEqual(rows.map(row => row.id).sort())

    const now = Date.parse('2026-11-20T18:00Z')
    expect(engine.summary(rows, engine.period('week', now, 'Asia/Novosibirsk', 4), 0)).toMatchObject({ spent: 9999, actualSpent: 37501 })
    expect(engine.summary(rows, engine.period('month', now, 'Asia/Novosibirsk', 4), 0)).toMatchObject({ spent: 37600, actualSpent: 37501 })
  })

  it('allows one operation only when the receipt items agree on an accounting scope', () => {
    const single = { ...receipt, mode: 'single', categoryId: 'home' }
    const mixed = { ...single, items: [{ ...item, budgetScope: 'monthly_only' }, receipt.items[1]] }
    expect(receiptSchema.safeParse(mixed).success).toBe(false)
    const uniform = receiptSchema.parse({ ...single, items: single.items.map(row => ({ ...row, budgetScope: 'monthly_only' })) })
    expect(receiptOperations(uniform)).toMatchObject([{ amount: 37256, budgetScope: 'monthly_only' }])
  })

  it('inherits the receipt scope for adjustments in categories without merchandise', () => {
    const adjusted = receiptSchema.parse({
      ...receipt, source: 'photo', total: 27501, budgetAmount: 27600, roundingDelta: 99,
      roundingCategoryId: 'home', mismatchAccepted: true, adjustmentCategoryId: 'home', budgetScope: 'monthly_only',
      items: [{ ...item, budgetScope: 'weekly_and_monthly' }],
    })
    expect(receiptOperations(adjusted)).toMatchObject([
      { categoryId: 'meat', budgetScope: 'weekly_and_monthly', amount: 27257 },
      { categoryId: 'home', budgetScope: 'monthly_only', amount: 244 },
      { categoryId: 'home', budgetScope: 'monthly_only', amount: 99, actualAmount: 0, receiptRounding: true },
    ])
  })


  it('groups exactly twenty items without counting discounts twice', () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      ...item, id: 'line-' + index, categoryId: index < 5 ? 'home' : 'meat', amount: 1921, discount: 117,
    }))
    const saved = receiptSchema.parse({ ...receipt, total: 38420, items })
    expect(receiptOperations(saved).map(row => row.amount)).toEqual([9605, 28815])
    const single = receiptSchema.parse({ ...saved, mode: 'single', categoryId: 'home' })
    expect(receiptOperations(single)).toMatchObject([{ categoryId: 'home', amount: 38420 }])
  })

  it('credits refunds as income and rejects cash expense documents', () => {
    const fiscal = parseFiscalQr(qr.replace('n=1', 'n=2'))
    const refund = { ...receipt, source: 'qr', fiscal, total: fiscal.total, items: [], mode: 'single', categoryId: null } as const
    expect(receiptOperations(receiptSchema.parse(refund))).toMatchObject([{ type: 'income', amount: 284750, categoryId: null }])
    expect(receiptSchema.safeParse({ ...refund, fiscal: { ...fiscal, n: 3 } }).success).toBe(false)
    expect(receiptSchema.safeParse({ ...refund, total: 100 }).success).toBe(false)
    expect(receiptSchema.safeParse({
      ...refund, total: fiscal.total,
      items: [{ ...item, amount: fiscal.total, budgetScope: 'monthly_only' }],
    }).success).toBe(false)
  })
})

it('suggests only current active household categories and favors confirmed product rules', () => {
  const arbitrary: Category = { id: 'morning', name: 'Завтраки', emoji: '👩‍🍳', color: '#777777', archived: false, limits: { week: 0, month: 0 } }
  const dairy = { ...arbitrary, id: 'milk', name: 'Молочка' }
  const rule = { id: 'r1', match: 'exact' as const, pattern: 'Молоко 2,5%', categoryId: arbitrary.id }
  expect(suggestReceiptCategory('  МОЛОКО 2.5% ', [arbitrary, dairy], [rule])).toEqual({ categoryId: arbitrary.id, confidence: 'high' })
  expect(suggestReceiptCategory('Молоко 2,5%', [dairy], [rule])?.categoryId).toBe(dairy.id)
  expect(suggestReceiptCategory('Мыло жидкое аромат молока', [dairy], [])).toBeNull()
  expect(suggestReceiptCategory('[М] Молоко 2,5%', [{ ...dairy, name: 'Продукты' }], [])).toEqual({ categoryId: dairy.id, confidence: 'low' })
  expect(suggestReceiptCategory('Мыло жидкое аромат молока', [{ ...dairy, name: 'Продукты' }], [])).toBeNull()
  expect(suggestReceiptCategory('Молоко 2,5%', [{ ...arbitrary, archived: true }], [rule])).toBeNull()
  expect(suggestReceiptCategory('Неизвестный товар', [arbitrary], [])).toBeNull()
})
