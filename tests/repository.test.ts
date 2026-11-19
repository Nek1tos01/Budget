import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { MAX_MONEY, money, usageLabel } from '../src/domain/engine'
import { newSnapshot } from '../src/data/demo'
import { parseSnapshot, repository } from '../src/data/repository'

describe('локальные данные', () => {
  it('сохраняет операции в копейках и импортирует только валидную копию', async () => {
    const example = newSnapshot(true, Date.parse('2026-11-19T12:00:00Z'))
    await repository.replace(example)
    const expense = { ...example.transactions.find(item => item.type === 'expense')!, id: 'test-operation', amount: 15043, createdAt: 1795090000000 }
    await repository.putTransaction(expense)
    const snapshot = (await repository.read())!
    expect(snapshot.transactions[0]).toEqual(expense)
    expect(snapshot.profile.settings.lastCategory).toBe(expense.categoryId)
    const broken = { ...snapshot, members: [] }
    expect(() => parseSnapshot(broken)).toThrow()
    expect(() => repository.replace(broken)).toThrow()
    expect((await repository.read())?.transactions.length).toBe(example.transactions.length + 1)
    await repository.deleteTransaction(expense.id)
    await expect(repository.putTransaction({ ...expense, amount: 65000 }, expense)).rejects.toThrow('другой вкладке')
    expect((await repository.read())?.transactions.length).toBe(example.transactions.length)
  })
})

it('отклоняет копию, в которой общий оборот нельзя выразить целыми копейками', () => {
  const example = newSnapshot(true)
  const row = example.transactions[0]
  example.transactions = Array.from({ length: 10000 }, (_, index) => ({ ...row, id: String(index), amount: MAX_MONEY }))
  expect(() => parseSnapshot(example)).toThrow('точность')
})

it('показывает копейки на верхней границе и перерасход меньше процента', () => {
  expect(money(Number.MAX_SAFE_INTEGER)).toBe('90 071 992 547 409,91 ₽')
  expect(usageLabel({ remaining: -1, percent: 100 })).toBe('>100%')
})
