import { describe, expect, it } from 'vitest'
import { addMoney, engine, percentChange, roundUpToRuble, toDay, usagePercent } from '../src/domain/engine'
import type { Transaction } from '../src/domain/models'

const now = Date.parse('2026-01-01T12:00:00Z')
const row = (id: string, amount: number, date: string, group: string | null, type: Transaction['type'] = 'expense'): Transaction =>
  ({ id, amount, date, categoryId: group, memberId: group === 'food' ? 'anna' : 'boris', type, note: '' })
const rows = [
  row('a', 20_000, '2025-12-31', 'utilities'),
  row('b', 50_000, '2026-01-01', 'food'),
  row('c', 80_000, '2026-01-07', 'utilities'),
  row('d', 12_501, '2026-01-07', 'food'),
  row('e', 50_000, '2026-01-01', 'utilities', 'income'),
  row('f', 10_000, '2026-01-08', 'food'),
  row('g', 1, '2026-01-03', null),
]

describe('публичный контракт WebAssembly', () => {
  it('исключает расходы только на месяц из недельного лимита и разбивки', () => {
    const week = engine.period('week', now, 'UTC', 4)
    const month = engine.period('month', now, 'UTC', 4)
    const mixed: Transaction[] = [
      row('manual', 10_000, '2026-01-01', 'food'),
      { ...row('receipt', 50_000, '2026-01-02', 'food'), actualAmount: 50_050 },
      { ...row('monthly', 25_000, '2026-01-03', 'utilities'), budgetScope: 'monthly_only' },
      { ...row('rounding', 100, '2026-01-02', 'rounding'), actualAmount: 0 },
      row('income', 5_000, '2026-01-04', 'food', 'income'),
      row('later', 7_500, week.end, 'food'),
    ]

    expect(engine.summary(mixed, week, 70_000)).toEqual({
      spent: 60_100, actualSpent: 85_050, income: 5_000, limit: 70_000, remaining: 9_900, percent: 86,
    })
    expect(engine.summary(mixed, month, 100_000)).toEqual({
      spent: 92_600, actualSpent: 92_550, income: 5_000, limit: 100_000, remaining: 7_400, percent: 93,
    })
    expect(engine.breakdown(mixed, week, 'categoryId')).toEqual([
      { id: 'food', amount: 60_000 }, { id: 'rounding', amount: 100 },
    ])
    expect(engine.breakdown(mixed, month, 'categoryId')).toEqual([
      { id: 'food', amount: 67_500 }, { id: 'utilities', amount: 25_000 }, { id: 'rounding', amount: 100 },
    ])
    expect(engine.breakdown(mixed, week, 'memberId')).toEqual([
      { id: 'anna', amount: 60_000 }, { id: 'boris', amount: 100 },
    ])
  })

  it('округляет целые копейки вверх до рубля', () => {
    expect(roundUpToRuble(50_000)).toBe(50_000)
    expect(roundUpToRuble(50_001)).toBe(50_100)
    expect(roundUpToRuble(50_050)).toBe(50_100)
    expect(roundUpToRuble(50_099)).toBe(50_100)
    expect(roundUpToRuble(999_999_999_999)).toBe(1_000_000_000_000)
    expect(() => roundUpToRuble(Number.MAX_SAFE_INTEGER)).toThrow(RangeError)
    expect(() => roundUpToRuble(50.1)).toThrow(RangeError)
    expect(() => roundUpToRuble(-1)).toThrow(RangeError)
  })

  it('совпадает с эталонными результатами нативных тестов', () => {
    const week = engine.period('week', now, 'UTC', 4)
    const month = engine.period('month', now, 'UTC', 4)
    expect(engine.summary(rows, week, 100_000)).toEqual({ spent: 142_502, income: 50_000, limit: 100_000, remaining: -42_502, percent: 143 })
    expect(engine.summary(rows, month, 300_000)).toEqual({ spent: 152_502, income: 50_000, limit: 300_000, remaining: 147_498, percent: 51 })
    expect(engine.breakdown(rows, week, 'categoryId')).toEqual([{ id: 'utilities', amount: 80_000 }, { id: 'food', amount: 62_501 }])
    expect(engine.breakdown(rows, week, 'memberId')).toEqual([{ id: 'boris', amount: 80_001 }, { id: 'anna', amount: 62_501 }])
    expect(engine.summary(rows.filter(item => item.categoryId === 'food'), week, 62_501).remaining).toBe(0)
    expect(usagePercent(62_501, 142_502)).toBe(44)
    expect(percentChange(142_502, 20_000)).toBe(613)
    expect(percentChange(199, 200)).toBe(0)
    expect(percentChange(197, 200)).toBe(-1)
    expect(percentChange(87, 0)).toBe(0)
  })

  it('передаёт целые копейки как BigInt и проверяет точность старого формата Number', () => {
    const max = Number.MAX_SAFE_INTEGER
    const week = engine.period('week', now, 'UTC', 4)
    const large = row('large', max, '2026-01-01', 'food')
    expect(addMoney(max - 1, 1)).toBe(max)
    expect(addMoney(-max, -0)).toBe(-max)
    expect(engine.summary([large], week, max)).toEqual({ spent: max, income: 0, limit: max, remaining: 0, percent: 100 })
    expect(() => addMoney(max, 1)).toThrow(RangeError)
    expect(() => addMoney(max + 1, -1)).toThrow(RangeError)
    expect(() => engine.summary([large, rows[1]], week, max)).toThrow(RangeError)
    expect(() => engine.breakdown([large, rows[1]], week, 'categoryId')).toThrow(RangeError)
    expect(() => engine.summary([row('negative', -1, '2026-01-01', 'food')], week, max)).toThrow(RangeError)
    expect(() => engine.summary(rows, week, 0.1)).toThrow(RangeError)
  })

  it('сохраняет порядок первых расходов при совпадении итоговых сумм', () => {
    const week = engine.period('week', now, 'UTC', 4)
    expect(engine.breakdown([
      row('prior', 50, '2025-12-31', 'food'),
      row('alpha', 50, '2026-01-01', 'utilities'),
      row('beta', 50, '2026-01-01', 'food'),
    ], week, 'categoryId')).toEqual([{ id: 'utilities', amount: 50 }, { id: 'food', amount: 50 }])
    expect(engine.breakdown([], week, 'memberId')).toEqual([])
  })

  it('прогнозирует конец финансовой недели с учётом будущих расходов, режима и округления чеков', () => {
    const moment = Date.parse('2026-01-03T20:00:00Z')
    const timezone = 'Asia/Novosibirsk'
    const today = toDay(moment, timezone)
    const week = engine.period('week', moment, timezone, 4)
    expect(engine.forecast([
      row('past', 10_000, '2026-01-01', 'food'),
      { ...row('receipt', 50_100, '2026-01-02', 'food'), actualAmount: 50_050 },
      { ...row('monthly', 25_000, '2026-01-03', 'food'), budgetScope: 'monthly_only' },
      row('today', 5_000, '2026-01-04', 'food'),
      row('income', 60_000, '2026-01-05', null, 'income'),
      row('future', 70_000, '2026-01-05', 'food'),
      row('future-small', 1, '2026-01-06', 'food'),
      row('next-week', 7_500, '2026-01-08', 'food'),
    ], week, today, 190_000)).toEqual({
      spentToDate: 65_100,
      futureSpent: 70_001,
      projectedSpent: 190_200,
      remaining: -200,
      elapsedDays: 3,
      remainingDays: 4,
      confidence: 'standard',
      risk: 'over_limit',
    })
  })

  it('сохраняет осторожную оценку на первый день и отмечает превышение уже известных трат', () => {
    const week = engine.period('week', now, 'UTC', 4)
    const payments = [row('future', 101, '2026-01-06', 'food')]
    expect(engine.forecast(payments, week, '2026-01-01', 110)).toEqual({
      spentToDate: 0,
      futureSpent: 101,
      projectedSpent: 101,
      remaining: 9,
      elapsedDays: 0,
      remainingDays: 7,
      confidence: 'insufficient',
      risk: 'unknown',
    })
    expect(engine.forecast(payments, week, '2026-01-01', 100).risk).toBe('over_limit')
    expect(engine.forecast([], week, '2026-01-04', 100).risk).toBe('unknown')
  })

  it('прогнозирует последний день високосного месяца до целой копейки', () => {
    const moment = Date.parse('2024-02-29T00:00:00Z')
    const month = engine.period('month', moment, 'UTC', 1)
    expect(engine.forecast([{ ...row('monthly', 42, '2024-02-01', 'food'), budgetScope: 'monthly_only' }],
      month, '2024-02-29', 44)).toMatchObject({
      projectedSpent: 44, remaining: 0, elapsedDays: 28, remainingDays: 1, confidence: 'low', risk: 'within_limit',
    })
  })

  it('проверяет точность прогноза при преобразовании копеек из WebAssembly', () => {
    const max = Number.MAX_SAFE_INTEGER
    const week = engine.period('week', now, 'UTC', 4)
    const large = row('large', max, '2026-01-01', 'food')
    expect(engine.forecast([large], week, '2026-01-01', max).projectedSpent).toBe(max)
    expect(() => engine.forecast([large], week, '2026-01-07', max)).toThrow(RangeError)
    expect(() => engine.forecast([], week, week.end, max)).toThrow(RangeError)
  })
})
