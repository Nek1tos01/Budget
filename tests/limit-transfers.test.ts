import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { newSnapshot } from '../src/data/demo'
import { backupSnapshot, repository } from '../src/data/repository'
import { assertLimitTransferChange, currentLimitPeriod, effectiveCategoryLimit, type LimitTransfer } from '../src/domain/limit-transfers'
import type { Transaction } from '../src/domain/models'

const snapshot = newSnapshot(false)
const [source, destination] = snapshot.categories
const categories = [{ ...source, limits: { week: 1000, month: 3000 } }, { ...destination, limits: { week: 200, month: 900 } }]
const settings = { ...snapshot.profile.settings, timezone: 'Asia/Novosibirsk', weekStart: 4 }
const now = Date.parse('2026-11-18T17:00:00Z')
const period = { kind: 'week', start: '2026-11-19', end: '2026-11-26' } as const
const transfer: LimitTransfer = { ...period, id: 'move', fromCategoryId: source.id, toCategoryId: destination.id, amount: 400, cancelled: false, createdAt: now }
const spent: Transaction = { id: 'spent', amount: 550, date: period.start, categoryId: source.id, memberId: snapshot.members[0].id, type: 'expense', note: '' }

it('uses the local financial calendar and changes only the matching category caps', () => {
  expect(currentLimitPeriod('week', now, settings)).toEqual(period)
  expect(currentLimitPeriod('month', now, settings)).toEqual({ kind: 'month', start: '2026-11-01', end: '2026-12-01' })
  assertLimitTransferChange(transfer, undefined, categories, [], [spent])
  expect(categories.map(category => effectiveCategoryLimit(category, period, [transfer]))).toEqual([600, 600])
  expect(effectiveCategoryLimit(categories[0], { ...period, start: '2026-11-26', end: '2026-12-03' }, [transfer])).toBe(1000)
  expect(effectiveCategoryLimit(categories[0], currentLimitPeriod('month', now, settings), [transfer])).toBe(3000)
})

it('checks scoped expenses and verifies the reverse side when cancelling', () => {
  expect(() => assertLimitTransferChange({ ...transfer, amount: 451 }, undefined, categories, [], [spent])).toThrow('Доступно')
  assertLimitTransferChange({ ...transfer, amount: 1000 }, undefined, categories, [], [{ ...spent, budgetScope: 'monthly_only' }])
  const recipientSpend = { ...spent, categoryId: destination.id, amount: 300 }
  expect(() => assertLimitTransferChange({ ...transfer, cancelled: true }, transfer, categories, [transfer], [recipientSpend])).toThrow('Доступно')
  assertLimitTransferChange({ ...transfer, amount: 450 }, transfer, categories, [transfer], [spent])
})

it('persists edit and cancellation history and round-trips without creating expenses', async () => {
  const dated = { ...transfer, ...currentLimitPeriod('week', Date.now(), settings), createdAt: Date.now() }
  await repository.replace({ ...snapshot, categories, profile: { ...snapshot.profile, settings } })
  await repository.putLimitTransfer(dated, 'local')
  const edited = { ...dated, amount: 350 }
  await repository.putLimitTransfer(edited, 'local', dated)
  const backup = JSON.parse(JSON.stringify(backupSnapshot((await repository.read())!)))
  expect(backup.limitTransfers).toEqual([edited])
  await repository.replace(backup)
  await repository.putLimitTransfer({ ...edited, cancelled: true }, 'local', edited)
  const restored = (await repository.read())!
  expect(restored.transactions).toEqual([])
  expect(restored.profile.budget).toEqual(snapshot.profile.budget)
  expect(restored.limitTransfers).toEqual([{ ...edited, cancelled: true }])
  expect(effectiveCategoryLimit(categories[0], dated, restored.limitTransfers)).toBe(1000)
  await expect(repository.replace(snapshot)).rejects.toThrow('историю переносов')
  expect((await repository.read())?.limitTransfers).toEqual(restored.limitTransfers)
})
