import { Temporal } from '@js-temporal/polyfill'
import { budgetWasm } from './budget-wasm'
import { MAX_MONEY, type BudgetEngine, type Day, type Summary } from './models'

export { addMoney, initializeBudgetWasm as initializeBudgetEngine, percentChange, roundUpToRuble, usagePercent } from './budget-wasm'
export { MAX_MONEY } from './models'
export const weekdays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье']
export const weekdayShort = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
export const weekdaysReset = ['в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу', 'в воскресенье']

export const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
export const addDays = (day: Day, days: number) => Temporal.PlainDate.from(day).add({ days }).toString()
export const toDay = (now: number, timezone: string) =>
  Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timezone).toPlainDate().toString()
export const isDay = (value: string) => {
  try { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Temporal.PlainDate.from(value).toString() === value }
  catch { return false }
}
export const isZone = (value: string) => {
  try { new Intl.DateTimeFormat('ru', { timeZone: value }); return true }
  catch { return false }
}

export function parseMoney(input: string): number | null {
  const clean = input.trim().replace(/[ \u00a0\u202f]/g, '').replace('.', ',')
  if (!/^(?:\d+(?:,\d{0,2})?|,\d{1,2})$/.test(clean)) return null
  const [whole, fraction = ''] = clean.split(',')
  const amount = Number(whole + fraction.padEnd(2, '0'))
  return Number.isSafeInteger(amount) && amount <= MAX_MONEY ? amount : null
}

const wholeCurrency = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
export function amountText(cents: number) {
  const absolute = Math.abs(cents)
  const fraction = absolute % 100
  const rubles = wholeCurrency.format((absolute - fraction) / 100)
  return (cents < 0 ? '−' : '') + rubles + (fraction ? ',' + String(fraction).padStart(2, '0') : '')
}
export function usageLabel(summary: Pick<Summary, 'remaining' | 'percent'>) {
  if (summary.percent === null) return '—'
  return summary.remaining < 0 && summary.percent === 100 ? '>100%' : summary.percent + '%'
}
export const money = (cents: number) => amountText(cents) + ' ₽'
export const moneyInput = (cents: number) => String(cents / 100).replace('.', ',')
const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const longDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })
const monthName = new Intl.DateTimeFormat('ru-RU', { month: 'long', timeZone: 'UTC' })
const asDate = (day: Day) => new Date(day + 'T12:00:00Z')
export const labelDay = (day: Day, long = false) => (long ? longDate : shortDate).format(asDate(day)).replaceAll('.', '')
export const labelMonth = (day: Day) => monthName.format(asDate(day))
export const labelPeriod = (period: ReturnType<BudgetEngine['period']>, year: string, forChart = false) => {
  const extra = !forChart && period.start.slice(0, 4) !== year ? ' ' + period.start.slice(0, 4) : ''
  if (period.kind === 'month') {
    const month = labelMonth(period.start)
    return (forChart ? month.slice(0, 3) : month[0].toUpperCase() + month.slice(1)) + extra
  }
  if (forChart) return labelDay(period.start)
  const last = addDays(period.end, -1)
  const startYear = period.start.slice(0, 4)
  const lastYear = last.slice(0, 4)
  if (startYear !== lastYear) return labelDay(period.start) + ' ' + startYear + ' – ' + labelDay(last) + ' ' + lastYear
  const first = period.start.slice(0, 7) === last.slice(0, 7) ? Number(period.start.slice(-2)) : labelDay(period.start)
  return first + ' – ' + labelDay(last) + extra
}

export const engine: BudgetEngine = {
  period(kind, now, timezone, weekStart, offset = 0) {
    return budgetWasm.period(kind, toDay(now, timezone), weekStart, offset)
  },
  includes: budgetWasm.includes,
  summary: budgetWasm.summary,
  forecast: budgetWasm.forecast,
  breakdown: budgetWasm.breakdown,
  nextReset(now, timezone, weekStart) {
    return Temporal.PlainDate.from(engine.period('week', now, timezone, weekStart).end)
      .toZonedDateTime(timezone).epochMilliseconds
  },
}
