import { Temporal } from '@js-temporal/polyfill'
import { z } from 'zod'
import { MAX_MONEY, type BudgetPeriod, type Category, type PeriodKind, type Settings, type Transaction } from './models'

const identifier = z.string().min(1).max(128)
const day = z.string().regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
})

function validTransferPeriod({ start, end, kind }: BudgetPeriod) {
  const first = new Date(start + 'T00:00:00Z')
  const after = new Date(end + 'T00:00:00Z')
  if (kind === 'week') return after.valueOf() - first.valueOf() === 7 * 86_400_000
  if (first.getUTCDate() !== 1) return false
  first.setUTCMonth(first.getUTCMonth() + 1)
  return first.valueOf() === after.valueOf()
}

export const limitTransferSchema = z.strictObject({
  id: identifier,
  kind: z.enum(['week', 'month']),
  start: day,
  end: day,
  fromCategoryId: identifier,
  toCategoryId: identifier,
  amount: z.number().int().min(1).max(MAX_MONEY),
  cancelled: z.boolean(),
  createdAt: z.number().int().nonnegative(),
}).refine(value => validTransferPeriod(value) && value.fromCategoryId !== value.toCategoryId,
  'Выберите две разные категории и корректный период.')

export type LimitTransfer = z.infer<typeof limitTransferSchema>

export function currentLimitPeriod(kind: PeriodKind, now: number, settings: Pick<Settings, 'timezone' | 'weekStart'>): BudgetPeriod {
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(settings.timezone).toPlainDate()
  const start = kind === 'week' ? today.subtract({ days: (today.dayOfWeek - settings.weekStart + 7) % 7 }) : today.with({ day: 1 })
  const end = start.add(kind === 'week' ? { weeks: 1 } : { months: 1 })
  return { kind, start: start.toString(), end: end.toString() }
}

export function sameLimitPeriod(a: BudgetPeriod, b: BudgetPeriod) {
  return a.kind === b.kind && a.start === b.start && a.end === b.end
}

function delta(transfer: LimitTransfer, categoryId: string): bigint {
  if (transfer.cancelled) return 0n
  if (categoryId === transfer.fromCategoryId) return -BigInt(transfer.amount)
  if (categoryId === transfer.toCategoryId) return BigInt(transfer.amount)
  return 0n
}

function limitInPeriod(category: Category, period: BudgetPeriod, transfers: readonly LimitTransfer[]) {
  let limit = BigInt(category.limits[period.kind])
  for (const transfer of transfers) if (sameLimitPeriod(transfer, period)) limit += delta(transfer, category.id)
  return limit
}

export function effectiveCategoryLimit(category: Category, period: BudgetPeriod, transfers: readonly LimitTransfer[] = []): number {
  const limit = limitInPeriod(category, period, transfers)
  // A version conflict can temporarily overlay stale pending writes on confirmed allocations.
  return Number(limit < 0n ? 0n : limit > BigInt(MAX_MONEY) ? BigInt(MAX_MONEY) : limit)
}

export function assertLimitTransferBalances(categories: readonly Category[], transfers: readonly LimitTransfer[]) {
  const byId = new Map(categories.map(row => [row.id, row]))
  const ids = new Set<string>()
  const balances = new Map<string, bigint>()
  for (const transfer of transfers) {
    const from = byId.get(transfer.fromCategoryId)
    const to = byId.get(transfer.toCategoryId)
    if (!from || !to || ids.has(transfer.id)) throw new Error('В истории переносов есть дубликаты или отсутствующие категории.')
    ids.add(transfer.id)
    for (const category of [from, to]) {
      const key = JSON.stringify([transfer.kind, transfer.start, transfer.end, category.id])
      balances.set(key, (balances.get(key) ?? BigInt(category.limits[transfer.kind])) + delta(transfer, category.id))
    }
  }
  if ([...balances.values()].some(value => value < 0n || value > BigInt(MAX_MONEY))) {
    throw new Error('Изменение нарушает лимиты категорий в периоде с переносами.')
  }
}

export function assertLimitTransferChange(next: LimitTransfer, previous: LimitTransfer | undefined,
  categories: readonly Category[], transfers: readonly LimitTransfer[], transactions: readonly Transaction[]) {
  if (previous && (previous.cancelled || previous.id !== next.id || !sameLimitPeriod(previous, next) ||
      previous.fromCategoryId !== next.fromCategoryId || previous.toCategoryId !== next.toCategoryId ||
      previous.createdAt !== next.createdAt || (next.cancelled && previous.amount !== next.amount))) {
    throw new Error('Этот перенос нельзя изменить таким способом.')
  }
  if (!previous && next.cancelled) throw new Error('Можно отменить только сохранённый перенос.')
  for (const categoryId of [next.fromCategoryId, next.toCategoryId]) {
    const category = categories.find(row => row.id === categoryId)
    if (!category || (category.archived && !previous)) throw new Error('Выберите действующие категории.')
    const current = limitInPeriod(category, next, transfers)
    const change = delta(next, categoryId) - (previous ? delta(previous, categoryId) : 0n)
    const limit = current + change
    if (limit < 0n || limit > BigInt(MAX_MONEY)) throw new Error('Перенос выходит за допустимый лимит категории.')
    if (change >= 0n) continue
    let spent = 0n
    for (const row of transactions) {
      if (row.categoryId === categoryId && row.type === 'expense' && row.date >= next.start && row.date < next.end &&
          (next.kind === 'month' || row.budgetScope !== 'monthly_only')) spent += BigInt(row.amount)
    }
    if (limit < spent) throw new Error('Доступно меньше, чем требуется для переноса: ' + category.name + '.')
  }
}
