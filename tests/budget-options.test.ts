import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { authenticate, disconnect, readConnection, syncCloud } from '../src/cloud/client'
import { encodeCategory, encodeProfile, type CloudRecord, type Mutation } from '../src/cloud/protocol'
import { newSnapshot } from '../src/data/demo'
import { backupSnapshot, parseSnapshot, repository } from '../src/data/repository'
import { engine } from '../src/domain/engine'
import type { BudgetPeriod, Transaction } from '../src/domain/models'
import { defaultReceiptRoundingCategory, parseFiscalQr, receiptOperations, receiptSchema, type Receipt } from '../src/domain/receipts'

const base = newSnapshot(false)
const [food, household] = base.categories
const fiscal = parseFiscalQr('t=20261120T1742&s=500.01&fn=000110000105&i=12345678&fp=123456&n=1')
const item = { id: 'food-item', originalName: 'Молоко', name: 'Молоко', quantity: '1', amount: 30000, categoryId: food.id, needsReview: false }
const receipt: Receipt = {
  id: 'rounding-test', source: 'combined', store: 'Магазин', date: fiscal.date, total: 50001, fiscal,
  budgetAmount: 50100, roundingDelta: 99, roundingCategoryId: household.id, budgetScope: 'monthly_only',
  memberId: base.members[0].id, note: '', mode: 'split', categoryId: null, mismatchAccepted: false,
  items: [item, { ...item, id: 'home-item', categoryId: household.id, amount: 20001 }],
}
const week: BudgetPeriod = { kind: 'week', start: '2026-11-19', end: '2026-11-26' }
const month: BudgetPeriod = { kind: 'month', start: '2026-11-01', end: '2026-12-01' }

it('retains fiscal cents and projects a split receipt with exactly one budget-only adjustment', () => {
  const saved = receiptSchema.parse(receipt)
  expect(saved.fiscal?.total).toBe(50001)
  expect(saved.items.map(row => row.amount)).toEqual([30000, 20001])
  expect(defaultReceiptRoundingCategory(saved)).toBe(food.id)
  const rows = receiptOperations(saved)
  expect(rows).toMatchObject([
    { amount: 30000, categoryId: food.id, budgetScope: 'monthly_only' },
    { amount: 20001, categoryId: household.id, budgetScope: 'monthly_only' },
    { amount: 99, actualAmount: 0, categoryId: household.id, budgetScope: 'monthly_only', receiptRounding: true },
  ])
  expect(engine.summary(rows, week, 70000)).toMatchObject({ spent: 0, actualSpent: 50001, remaining: 70000 })
  expect(engine.summary(rows, month, 70000)).toMatchObject({ spent: 50100, actualSpent: 50001, remaining: 19900 })
  expect(engine.breakdown(rows, week, 'categoryId')).toEqual([])
  expect(engine.breakdown(rows, month, 'categoryId')).toEqual([
    { id: food.id, amount: 30000 }, { id: household.id, amount: 20100 },
  ])
  expect(engine.breakdown(rows, week, 'categoryId', 'actual')).toEqual([
    { id: food.id, amount: 30000 }, { id: household.id, amount: 20001 },
  ])
  expect(engine.breakdown(rows, month, 'memberId', 'actual')).toEqual([{ id: saved.memberId, amount: 50001 }])
})

it('preserves actual payment for a singly accounted receipt and rejects unsupported or forged rounding', () => {
  const single = { ...receipt, mode: 'single', categoryId: food.id, roundingCategoryId: undefined }
  expect(receiptOperations(receiptSchema.parse(single))).toMatchObject([{ amount: 50100, actualAmount: 50001 }])
  for (const invalid of [
    { ...receipt, budgetAmount: 50200, roundingDelta: 199 },
    { ...receipt, roundingDelta: undefined },
    { ...receipt, roundingCategoryId: undefined },
    { ...receipt, budgetAmount: undefined },
    { ...single, fiscal: { ...fiscal, n: 2 } },
    { ...single, source: 'manual', fiscal: undefined },
    { ...single, roundingCategoryId: food.id },
  ]) expect(receiptSchema.safeParse(invalid).success).toBe(false)
})

it('rounds the original total independently of a confirmed missing line allocation', () => {
  const adjusted = receiptSchema.parse({ ...receipt, items: [item], mismatchAccepted: true, adjustmentCategoryId: household.id })
  expect(receiptOperations(adjusted).map(row => [row.amount, row.actualAmount ?? row.amount])).toEqual([
    [30000, 30000], [20001, 20001], [99, 0],
  ])
})

it('retains scope, category default and both receipt amounts through IndexedDB and JSON', async () => {
  await repository.replace(base)
  const rental = { ...food, defaultBudgetScope: 'monthly_only' as const }
  await repository.putCategory(rental)
  await repository.updateProfile(profile => ({ ...profile, settings: { ...profile.settings, roundReceiptTotals: true } }))
  const row: Transaction = { id: 'rent', type: 'expense', date: receipt.date, amount: 60000, budgetScope: 'monthly_only',
    categoryId: rental.id, memberId: receipt.memberId, note: '' }
  await repository.putTransaction(row)
  await repository.putReceipt(receipt)
  await repository.updateProfile(profile => ({ ...profile, settings: { ...profile.settings, roundReceiptTotals: false } }))
  const local = (await repository.read())!
  const backup = parseSnapshot(JSON.parse(JSON.stringify(backupSnapshot(local))))
  expect(backup.profile.settings.roundReceiptTotals).toBe(false)
  expect(backup.categories.find(category => category.id === rental.id)?.defaultBudgetScope).toBe('monthly_only')
  expect(backup.transactions).toEqual([row])
  expect(backup.receipts?.[0]).toMatchObject({ total: 50001, budgetAmount: 50100, roundingDelta: 99, budgetScope: 'monthly_only' })
  await repository.replace(backup)
  await repository.putTransaction({ ...row, budgetScope: 'weekly_and_monthly' }, row)
  const restored = (await repository.read())!
  expect(restored.transactions.find(operation => operation.id === row.id)?.budgetScope).toBe('weekly_and_monthly')
  expect(restored.transactions.filter(operation => operation.receiptId === receipt.id).reduce((total, operation) => total + operation.amount, 0)).toBe(50100)
  const saved = restored.receipts?.[0]
  await repository.putReceipt({ ...receipt, roundingCategoryId: food.id }, 'local', saved)
  expect((await repository.read())?.transactions.find(operation => operation.receiptRounding)).toMatchObject({ categoryId: food.id, amount: 99, actualAmount: 0 })
})

it('keeps old expenses in weekly totals even after a category default is imported', () => {
  const legacy: Transaction = { id: 'old-rent', type: 'expense', date: receipt.date, amount: 4000,
    categoryId: food.id, memberId: receipt.memberId, note: '' }
  const restored = parseSnapshot({ ...base, categories: base.categories.map(category => category.id === food.id
    ? { ...category, defaultBudgetScope: 'monthly_only' } : category), transactions: [legacy] })
  expect(restored.transactions).toEqual([legacy])
  expect(engine.summary(restored.transactions, week, 70000)).toMatchObject({ spent: 4000, remaining: 66000 })
  const income = { ...legacy, type: 'income', categoryId: null, source: 'Возврат', budgetScope: 'monthly_only' }
  expect(() => parseSnapshot({ ...base, transactions: [income] })).toThrow()
})

it('queues the shared rounding preference and one rounded monthly receipt while offline', async () => {
  const session = { householdId: 'budget-options-test', memberId: base.members[0].id, role: 'owner' as const }
  const initial: CloudRecord[] = [
    { kind: 'profile', key: 'household', version: 1, value: encodeProfile(base.profile) },
    ...base.categories.map(category => ({ kind: 'category' as const, key: category.id, version: 1, value: encodeCategory(category) })),
    ...base.members.map(member => ({ kind: 'member' as const, key: member.id, version: 1, value: member })),
  ]
  const sent: Mutation[] = []
  const network = { onLine: true }
  vi.stubGlobal('navigator', network)
  vi.stubGlobal('fetch', vi.fn(async (url: string, request: RequestInit) => {
    if (url.endsWith('/households')) return Response.json({ session, recoveryCode: 'test-only' })
    if (url.endsWith('/logout')) return Response.json({ ok: true })
    if (url.includes('/sync?')) return Response.json({ cursor: initial.length, more: false,
      records: url.endsWith('=0') ? initial : [] })
    const mutation = JSON.parse(String(request.body)) as Mutation
    sent.push(mutation)
    return Response.json({ record: { kind: mutation.kind, value: mutation.value, key: mutation.key,
      version: mutation.expectedVersion + 1 } })
  }))
  try {
    await authenticate('households', {}, 'dark')
    await vi.waitFor(async () => expect((await readConnection())?.cursor).toBe(initial.length))
    network.onLine = false
    await repository.updateProfile(profile => ({ ...profile, settings: { ...profile.settings, roundReceiptTotals: true } }))
    await repository.putReceipt(receipt)
    expect((await readConnection())?.queue.map(mutation => mutation.kind)).toEqual(['profile', 'receipt'])
    expect(sent).toHaveLength(0)
    expect((await repository.read())?.transactions.filter(row => row.receiptRounding)).toHaveLength(1)
    network.onLine = true
    await syncCloud(true)
    await vi.waitFor(async () => expect((await readConnection())?.queue).toEqual([]))
    expect(sent).toMatchObject([
      { kind: 'profile', value: { settings: { roundReceiptTotals: true } } },
      { kind: 'receipt', value: { total: 50001, budgetAmount: 50100, budgetScope: 'monthly_only' } },
    ])
    expect((await repository.read())?.receipts).toHaveLength(1)
    await disconnect(session)
  } finally {
    vi.unstubAllGlobals()
  }
})
