import assetUrl from './budget-core.wasm?url&no-inline'
import { forecastConfidences, forecastRisks, type Aggregate, type BudgetPeriod, type Day, type Forecast, type PeriodKind, type SpendingBasis, type Summary, type Transaction } from './models'

type ScalarOperation = (left: bigint, right: bigint, out: number) => number

interface BudgetExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory
  _initialize(): void
  malloc(size: number): number
  free(pointer: number): void
  budget_add: ScalarOperation
  budget_round_up_to_ruble(amount: bigint, out: number): number
  budget_usage_percent: ScalarOperation
  budget_percent_change: ScalarOperation
  budget_period(today: number, kind: number, weekStart: number, offset: number, out: number): number
  budget_includes(start: number, end: number, date: number): number
  budget_summary(rows: number, count: number, start: number, end: number, kind: number, limit: bigint, out: number): number
  budget_forecast(rows: number, count: number, start: number, end: number, kind: number, today: number, limit: bigint, out: number): number
  budget_breakdown(rows: number, count: number, start: number, end: number, kind: number, out: number, groups: number): number
}

// Sizes and field offsets match the static assertions in cpp/budget-core/src/wasm.cpp.
const periodSize = 12
const rowSize = 32
const summarySize = 48
const forecastSize = 48
const aggregateSize = 16
const maxSafeMoney = BigInt(Number.MAX_SAFE_INTEGER)
const overflowMessage = 'Общий оборот превышает точность хранения копеек.'
const inputMessage = 'Некорректные данные финансового расчёта.'
const isoDayPattern = /^\d{4}-\d{2}-\d{2}$/

let exports: BudgetExports | undefined
let loading: Promise<void> | undefined

async function fetchModule() {
  const response = await fetch(assetUrl)
  if (!response.ok) throw new Error(`Не удалось загрузить финансовое ядро (HTTP ${response.status}).`)
  return response.arrayBuffer()
}

export function initializeBudgetWasm(bytes?: BufferSource): Promise<void> {
  loading ??= (async () => {
    // DataViews are acquired after allocation, so memory growth needs no host-side bookkeeping.
    const { instance } = await WebAssembly.instantiate(bytes ?? await fetchModule(), {
      env: { emscripten_notify_memory_growth() {} },
    })
    const initialized = instance.exports as BudgetExports
    initialized._initialize()
    exports = initialized
  })().catch((error: unknown) => {
    loading = undefined
    throw error
  })
  return loading
}

function moduleExports() {
  if (!exports) throw new Error('Финансовое ядро ещё не загружено.')
  return exports
}

function withAllocation<T>(bytes: number, use: (wasm: BudgetExports, pointer: number) => T): T {
  const wasm = moduleExports()
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 0x7fff_ffff) {
    throw new RangeError('Слишком много операций для финансового расчёта.')
  }
  const pointer = wasm.malloc(bytes)
  if (pointer === 0) throw new Error('Не хватает памяти для расчёта бюджета.')
  try {
    return use(wasm, pointer)
  } finally {
    wasm.free(pointer)
  }
}

function checkStatus(status: number) {
  if (status === 1) throw new RangeError(inputMessage)
  if (status === 2) throw new RangeError(overflowMessage)
  if (status !== 0) throw new Error('Неизвестная ошибка финансового расчёта.')
}

function encodeMoney(cents: number) {
  if (!Number.isSafeInteger(cents)) throw new RangeError(overflowMessage)
  return BigInt(cents)
}

function readMoney(view: DataView, offset: number) {
  const value = view.getBigInt64(offset, true)
  if (value < -maxSafeMoney || value > maxSafeMoney) throw new RangeError(overflowMessage)
  return Number(value)
}

function encodeDay(day: Day) {
  if (!isoDayPattern.test(day)) throw new RangeError(inputMessage)
  return Number(day.replaceAll('-', ''))
}

function decodeDay(day: number): Day {
  const digits = String(day).padStart(8, '0')
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`
}

const encodePeriodKind = (kind: PeriodKind) => kind === 'week' ? 0 : 1

function encodeRows(view: DataView, pointer: number, rows: Transaction[], groupBy?: 'categoryId' | 'memberId', basis: SpendingBasis = 'budget') {
  const indexes = new Map<string, number>()
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    const offset = pointer + index * rowSize
    const expense = row.type === 'expense'
    const actual = expense ? row.actualAmount ?? row.amount : row.amount
    const amount = basis === 'actual' ? actual : row.amount
    const id = groupBy && (basis === 'budget' || amount > 0) ? row[groupBy] : null
    if (id && !indexes.has(id)) indexes.set(id, indexes.size)
    view.setBigInt64(offset, encodeMoney(amount), true)
    view.setInt32(offset + 8, encodeDay(row.date), true)
    view.setInt32(offset + 12, id ? indexes.get(id)! : -1, true)
    view.setInt32(offset + 16, expense ? 0 : 1, true)
    view.setInt32(offset + 20, basis === 'budget' && expense && row.budgetScope === 'monthly_only' ? 1 : 0, true)
    view.setBigInt64(offset + 24, encodeMoney(actual), true)
  }
  return [...indexes.keys()]
}

function scalar(operation: 'budget_add' | 'budget_usage_percent' | 'budget_percent_change', left: number, right: number) {
  return withAllocation(8, (wasm, pointer) => {
    checkStatus(wasm[operation](encodeMoney(left), encodeMoney(right), pointer))
    const view = new DataView(wasm.memory.buffer)
    return operation === 'budget_add' ? readMoney(view, pointer) : Number(view.getBigInt64(pointer, true))
  })
}

export const budgetWasm = {
  period(kind: PeriodKind, day: Day, weekStart: number, offset: number): BudgetPeriod {
    if (!Number.isInteger(offset) || offset < -0x8000_0000 || offset > 0x7fff_ffff ||
        !Number.isInteger(weekStart) || weekStart < 1 || weekStart > 7) {
      throw new RangeError(inputMessage)
    }
    return withAllocation(periodSize, (wasm, pointer) => {
      checkStatus(wasm.budget_period(encodeDay(day), encodePeriodKind(kind), weekStart, offset, pointer))
      const view = new DataView(wasm.memory.buffer)
      return { kind, start: decodeDay(view.getInt32(pointer, true)), end: decodeDay(view.getInt32(pointer + 4, true)) }
    })
  },
  includes(period: BudgetPeriod, date: Day) {
    return moduleExports().budget_includes(encodeDay(period.start), encodeDay(period.end), encodeDay(date)) === 1
  },
  summary(rows: Transaction[], period: BudgetPeriod, limit: number): Summary {
    const rowBytes = rows.length * rowSize
    return withAllocation(rowBytes + summarySize, (wasm, pointer) => {
      const out = pointer + rowBytes
      encodeRows(new DataView(wasm.memory.buffer), pointer, rows)
      checkStatus(wasm.budget_summary(pointer, rows.length, encodeDay(period.start), encodeDay(period.end),
        encodePeriodKind(period.kind), encodeMoney(limit), out))
      const view = new DataView(wasm.memory.buffer)
      const percent = view.getBigInt64(out + 32, true)
      const spent = readMoney(view, out)
      const actualSpent = readMoney(view, out + 40)
      return {
        spent,
        income: readMoney(view, out + 8),
        limit,
        remaining: readMoney(view, out + 16),
        percent: percent < 0n ? null : Number(percent),
        ...(actualSpent !== spent ? { actualSpent } : {}),
      }
    })
  },
  forecast(rows: Transaction[], period: BudgetPeriod, today: Day, limit: number): Forecast {
    const rowBytes = rows.length * rowSize
    return withAllocation(rowBytes + forecastSize, (wasm, pointer) => {
      const out = pointer + rowBytes
      encodeRows(new DataView(wasm.memory.buffer), pointer, rows)
      checkStatus(wasm.budget_forecast(pointer, rows.length, encodeDay(period.start), encodeDay(period.end),
        encodePeriodKind(period.kind), encodeDay(today), encodeMoney(limit), out))
      const view = new DataView(wasm.memory.buffer)
      return {
        spentToDate: readMoney(view, out),
        futureSpent: readMoney(view, out + 8),
        projectedSpent: readMoney(view, out + 16),
        remaining: readMoney(view, out + 24),
        elapsedDays: view.getInt32(out + 32, true),
        remainingDays: view.getInt32(out + 36, true),
        confidence: forecastConfidences[view.getInt32(out + 40, true)],
        risk: forecastRisks[view.getInt32(out + 44, true)],
      }
    })
  },
  breakdown(rows: Transaction[], period: BudgetPeriod, group: 'memberId' | 'categoryId', basis: SpendingBasis = 'budget'): Aggregate[] {
    const rowBytes = rows.length * rowSize
    return withAllocation(Math.max(aggregateSize, rowBytes + rows.length * aggregateSize), (wasm, pointer) => {
      const out = pointer + rowBytes
      const ids = encodeRows(new DataView(wasm.memory.buffer), pointer, rows, group, basis)
      const count = wasm.budget_breakdown(pointer, rows.length, encodeDay(period.start), encodeDay(period.end),
        encodePeriodKind(period.kind), out, ids.length)
      if (count < 0) checkStatus(-count)
      const view = new DataView(wasm.memory.buffer)
      return Array.from({ length: count }, (_, index) => {
        const offset = out + index * aggregateSize
        return { id: ids[view.getInt32(offset + 8, true)], amount: readMoney(view, offset) }
      })
    })
  },
}

export const addMoney = (left: number, right: number) => scalar('budget_add', left, right)
export const usagePercent = (part: number, total: number) => scalar('budget_usage_percent', part, total)
export const percentChange = (current: number, previous: number) => scalar('budget_percent_change', current, previous)

export function roundUpToRuble(cents: number): number {
  return withAllocation(8, (wasm, pointer) => {
    checkStatus(wasm.budget_round_up_to_ruble(encodeMoney(cents), pointer))
    return readMoney(new DataView(wasm.memory.buffer), pointer)
  })
}
