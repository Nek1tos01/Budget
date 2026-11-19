import { describe, expect, it } from 'vitest'
import { engine, labelPeriod, parseMoney, toDay } from '../src/domain/engine'
import type { Transaction } from '../src/domain/models'

const at = Date.parse('2026-01-01T00:45:00+07:00')
const zone = 'Asia/Novosibirsk'
const expense: Transaction = { id: 'a', type: 'expense', amount: 12501, categoryId: 'food', memberId: 'm1', date: '2026-01-01', note: '' }
describe('финансовое ядро', () => {
  it('учитывает местную полночь, четверг и границы года', () => {
    expect(toDay(at, zone)).toBe('2026-01-01')
    expect(toDay(at, 'UTC')).toBe('2025-12-31')
    expect(engine.period('week', at - 60 * 60_000, zone, 4)).toEqual({ kind: 'week', start: '2025-12-25', end: '2026-01-01' })
    expect(engine.period('week', at, zone, 4).end).toBe('2026-01-08')
    expect(engine.period('month', at, zone, 4, -1).start).toBe('2025-12-01')
  })

  it('обрабатывает все дни начала и високосный месяц', () => {
    const leap = Date.parse('2024-02-29T12:00:00Z')
    const starts = ['2024-02-26', '2024-02-27', '2024-02-28', '2024-02-29', '2024-02-23', '2024-02-24', '2024-02-25']
    starts.forEach((start, index) => expect(engine.period('week', leap, 'UTC', index + 1).start).toBe(start))
    expect(engine.period('month', leap, 'UTC', 4)).toEqual({ kind: 'month', start: '2024-02-01', end: '2024-03-01' })
  })

  it('отделяет доход от лимитов, исключает конец интервала и сохраняет перерасход', () => {
    const period = engine.period('week', at, zone, 4)
    const rows: Transaction[] = [expense, { ...expense, id: 'b', type: 'income', amount: 50000, categoryId: null }, { ...expense, id: 'c', date: period.end }]
    expect(engine.summary(rows, period, 10000)).toEqual({ spent: 12501, income: 50000, limit: 10000, remaining: -2501, percent: 125 })
    expect(engine.breakdown(rows, period, 'categoryId')).toEqual([{ id: 'food', amount: 12501 }])
    expect(engine.summary(rows, period, 0).percent).toBeNull()
  })

  it('подписывает оба года в неделе на стыке декабря и января', () => {
    const crossing = engine.period('week', Date.parse('2024-01-01T12:00Z'), 'UTC', 4)
    expect(labelPeriod(crossing, '2024')).toBe('28 дек 2023 – 3 янв 2024')
  })

  it('возвращает местную полночь после смены часового смещения', () => {
    const before = Date.parse('2026-03-08T06:30:00Z')
    expect(engine.nextReset(before, 'America/New_York', 1)).toBe(Date.parse('2026-03-09T04:00:00Z'))
  })

  it('преобразует запятые, копейки и большие суммы без float', () => {
    expect(parseMoney('1 234,56')).toBe(123456)
    expect(parseMoney('9999999999.99')).toBe(999999999999)
    expect(parseMoney('10000000000')).toBeNull()
    expect(parseMoney('1,234')).toBeNull()
    expect(parseMoney(',05')).toBe(5)
  })
})
