import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { newSnapshot } from '../src/data/demo'
import { backupSnapshot, repository } from '../src/data/repository'
import { engine } from '../src/domain/engine'
import type { Receipt } from '../src/domain/receipts'

it('keeps receipt details and the matching financial projection through edit, export, restore and deletion', async () => {
  const base = newSnapshot(true)
  await repository.replace(base)
  const id = base.categories[0].id
  const fiscal = { fn: '000110000105', i: '20', fp: '51', n: 1 as const, date: '2026-11-20', time: '17:42', total: 1503 }
  const receipt: Receipt = {
    id: 'r1', source: 'combined', store: 'Магазин', date: fiscal.date, total: fiscal.total, fiscal, memberId: base.members[0].id,
    note: '', mode: 'split', categoryId: null, mismatchAccepted: false,
    items: [{ id: 'a', name: 'Яблоки', originalName: 'Яблоки', quantity: '0.451', unit: 'кг', amount: 1503, categoryId: id, needsReview: false }],
  }
  const rule = { id: 'rule', match: 'exact' as const, pattern: 'Яблоки', categoryId: id }
  await repository.putReceipt(receipt, 'local')
  await repository.putReceiptRule(rule, 'local')
  await expect(repository.putReceiptRule({ ...rule, id: 'other-rule', pattern: ' яблоки ' }, 'local')).rejects.toThrow('уже есть')
  await expect(repository.putReceipt({ ...receipt, id: 'duplicate' }, 'local')).rejects.toThrow('уже добавлен')
  const first = (await repository.read())!
  expect(first.receipts).toEqual([receipt])
  expect(first.transactions.filter(row => row.receiptId === receipt.id)).toMatchObject([{ amount: 1503, categoryId: id }])
  await expect(repository.putReceipt({ ...receipt, fiscal: { ...fiscal, time: '18:05' } }, 'local', receipt)).rejects.toThrow('нельзя изменить')

  const nextCategory = base.categories[1].id
  const updated = { ...receipt, items: [{ ...receipt.items[0], categoryId: nextCategory }] }
  await repository.putReceipt(updated, 'local', receipt)
  await expect(repository.putReceipt(receipt, 'local', receipt)).rejects.toThrow('изменился')
  const json = backupSnapshot((await repository.read())!)
  expect(json.transactions).toHaveLength(base.transactions.length)
  await repository.replace(JSON.parse(JSON.stringify(json)))
  const restored = (await repository.read())!
  expect(restored.receiptRules).toEqual([rule])
  expect(restored.transactions.filter(row => row.receiptId === receipt.id)).toMatchObject([{ amount: 1503, categoryId: nextCategory }])
  await repository.deleteReceipt(receipt.id, 'local', updated)
  expect((await repository.read())?.transactions).toHaveLength(base.transactions.length)
})

it('isolates unfinished drafts by workspace across reads', async () => {
  await repository.saveReceiptDraft('local', { store: 'Локальный' })
  await repository.saveReceiptDraft('cloud:a:member', { store: 'Общий' })
  expect(await repository.loadReceiptDraft('cloud:b:member')).toBeUndefined()
  expect(await repository.loadReceiptDraft('local')).toEqual({ store: 'Локальный' })
  await repository.deleteReceiptDraft('local')
  expect(await repository.loadReceiptDraft('cloud:a:member')).toEqual({ store: 'Общий' })
})

it('forecasts a future expense and a restored receipt from the projected transaction list', async () => {
  const base = newSnapshot(false)
  const categoryId = base.categories[0].id
  const memberId = base.members[0].id
  const receipt: Receipt = {
    id: 'forecast-receipt', source: 'manual', store: 'Магазин', date: '2026-01-07', total: 1_503,
    memberId, note: '', mode: 'split', categoryId: null, mismatchAccepted: false,
    items: [
      { id: 'weekly', name: 'Яблоки', originalName: 'Яблоки', quantity: '1', amount: 503, categoryId, needsReview: false },
      { id: 'monthly', name: 'Запас', originalName: 'Запас', quantity: '1', amount: 1_000, categoryId, needsReview: false, budgetScope: 'monthly_only' },
    ],
  }
  await repository.replace({
    ...base, version: 3, receipts: [receipt],
    transactions: [{ id: 'planned', type: 'expense', date: '2026-01-09', amount: 3_000, note: '', memberId, categoryId }],
  })
  const backup = backupSnapshot((await repository.read())!)
  expect(backup.transactions.map(row => row.id)).toEqual(['planned'])
  await repository.replace(JSON.parse(JSON.stringify(backup)))
  const restored = (await repository.read())!
  expect(restored.receipts?.[0]?.items.map(item => item.budgetScope)).toEqual([undefined, 'monthly_only'])
  const week = engine.period('week', Date.parse('2026-01-05T12:00:00Z'), 'UTC', 1)
  expect(engine.forecast(restored.transactions, week, '2026-01-05', 3_000)).toMatchObject({
    spentToDate: 0, futureSpent: 3_503, projectedSpent: 3_503, remaining: -503,
    confidence: 'insufficient', risk: 'over_limit',
  })
})
