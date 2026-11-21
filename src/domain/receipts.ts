import { z } from 'zod'
import { budgetScopes, MAX_MONEY, type BudgetScope, type Category, type Transaction } from './models'

const id = z.string().min(1).max(128).refine(value => !Array.from(value).some(character => {
  const code = character.charCodeAt(0)
  return code < 32 || code === 127
}))
const cents = z.number().int().min(0).max(MAX_MONEY)
const day = z.string().regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
})
const fiscalSchema = z.strictObject({
  fn: z.string().regex(/^\d{10,16}$/),
  i: z.string().regex(/^\d{1,10}$/),
  fp: z.string().regex(/^\d{1,10}$/),
  n: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  date: day,
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/),
  total: cents.min(1),
})
export type FiscalReceipt = z.infer<typeof fiscalSchema>

export function parseFiscalQr(raw: string): FiscalReceipt {
  const input = raw.trim()
  if (input.length > 256 || !/^(?:[a-z]+=[\d.T]+&)*[a-z]+=[\d.T]+$/.test(input)) {
    throw new Error('Этот QR-код не похож на российский кассовый чек.')
  }
  const query = new URLSearchParams(input)
  if (Array.from(query).length !== 6 || !['t', 's', 'fn', 'i', 'fp', 'n'].every(key => query.getAll(key).length === 1)) {
    throw new Error('В QR-коде отсутствуют обязательные реквизиты чека или есть повторяющиеся поля.')
  }
  const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/.exec(query.get('t') ?? '')
  const amount = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(query.get('s') ?? '')
  if (!stamp || !amount || !/^[1-4]$/.test(query.get('n') ?? '')) {
    throw new Error('В QR-коде указаны некорректная дата, сумма или вид расчёта.')
  }
  const [, year, month, date, hour, minute, seconds] = stamp
  const [, rubles, fraction = ''] = amount
  const parsed = fiscalSchema.safeParse({
    date: [year, month, date].join('-'), time: [hour, minute, seconds].filter(Boolean).join(':'),
    total: Number(rubles + fraction.padEnd(2, '0')),
    n: Number(query.get('n')), fn: query.get('fn'), i: query.get('i'), fp: query.get('fp'),
  })
  if (!parsed.success) throw new Error('В QR-коде указаны некорректные фискальные реквизиты.')
  return parsed.data
}

export const fiscalReceiptKey = (fiscal?: FiscalReceipt) => fiscal
  ? [fiscal.fn, fiscal.i, fiscal.fp, fiscal.n].join(':') : null

export const receiptItemSchema = z.strictObject({
  id, originalName: z.string().max(250), name: z.string().trim().min(1).max(250),
  quantity: z.string().regex(/^\d{1,6}(?:\.\d{1,6})?$/).refine(value => /[1-9]/.test(value)),
  unit: z.string().max(20).optional(), amount: cents, unitPrice: cents.optional(),
  discount: cents.optional(), categoryId: id.nullable(), needsReview: z.boolean(),
  budgetScope: z.enum(budgetScopes).optional(),
})
export type ReceiptItem = z.infer<typeof receiptItemSchema>

export const receiptItemBudgetScope = (item: Pick<ReceiptItem, 'budgetScope'>, receiptScope?: BudgetScope): BudgetScope =>
  item.budgetScope ?? receiptScope ?? 'weekly_and_monthly'

export const receiptItemBudgetScopes = (items: readonly Pick<ReceiptItem, 'budgetScope'>[], receiptScope?: BudgetScope) =>
  new Set(items.map(item => receiptItemBudgetScope(item, receiptScope)))

// The bounded number of items and maximum per-line amount keep every sum a safe integer.
export const receiptItemsTotal = (items: readonly Pick<ReceiptItem, 'amount'>[]) =>
  items.reduce((total, item) => total + item.amount, 0)

export const receiptSchema = z.strictObject({
  id, source: z.enum(['manual', 'qr', 'photo', 'combined']), store: z.string().trim().max(150),
  date: day, total: cents.min(1), fiscal: fiscalSchema.optional(),
  memberId: id, authorId: id.optional(), note: z.string().max(300),
  mode: z.enum(['single', 'split']), categoryId: id.nullable(),
  budgetScope: z.enum(budgetScopes).optional(),
  budgetAmount: z.number().int().min(1).max(MAX_MONEY + 1).optional(),
  roundingDelta: z.number().int().min(0).max(99).optional(),
  roundingCategoryId: id.optional(),
  adjustmentCategoryId: id.optional(), mismatchAccepted: z.boolean(),
  items: z.array(receiptItemSchema).max(200),
}).superRefine((receipt, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message })
  const fiscal = receipt.fiscal
  if ((receipt.source === 'qr' || receipt.source === 'combined') && !fiscal) issue('Укажите фискальные реквизиты чека.')
  if (fiscal && (receipt.total !== fiscal.total || receipt.date !== fiscal.date)) issue('Дата и итог должны совпадать с фискальным QR-кодом.')
  if (fiscal && fiscal.n > 2) issue('Этот вид кассового расчёта не поддерживается.')
  if (new Set(receipt.items.map(item => item.id)).size !== receipt.items.length) issue('В чеке повторяются идентификаторы позиций.')
  if (fiscal?.n === 2 && (receipt.budgetScope !== undefined || receipt.items.some(item => item.budgetScope !== undefined))) {
    issue('Режим учёта расходов не применяется к возврату.')
  }

  const { budgetAmount, roundingDelta, roundingCategoryId } = receipt
  if (budgetAmount === undefined) {
    if (roundingDelta !== undefined || roundingCategoryId !== undefined) issue('Укажите учётную сумму округлённого чека.')
  } else {
    if (receipt.source === 'manual' || (fiscal && fiscal.n !== 1)) issue('Округление применяется к импортированным чекам покупок.')
    // Validate untrusted JSON in the repository and on the server without loading the WASM runtime.
    const actual = BigInt(receipt.total)
    const expected = (actual + 99n) / 100n * 100n
    if (BigInt(budgetAmount) !== expected || roundingDelta !== budgetAmount - receipt.total) {
      issue('Учётная сумма и разница должны соответствовать округлению итога вверх до рубля.')
    }
    if (receipt.mode === 'split' && roundingDelta && !roundingCategoryId) issue('Выберите категорию для округления.')
    if (roundingCategoryId && (receipt.mode !== 'split' || !roundingDelta)) issue('Категория округления применяется только к разнице в распределённом чеке.')
  }

  const difference = receipt.total - receiptItemsTotal(receipt.items)
  if (receipt.items.length && difference !== 0 && !receipt.mismatchAccepted) {
    issue('Проверьте расхождение с итогом чека и подтвердите его вручную.')
  }
  if (receipt.mode === 'single') {
    if (fiscal?.n !== 2 && !receipt.categoryId) issue('Выберите категорию расхода.')
    if (receiptItemBudgetScopes(receipt.items, receipt.budgetScope).size > 1) issue('Товары с разным учётом нужно распределить по категориям.')
    if (receipt.adjustmentCategoryId) issue('Распределение разницы доступно в режиме по категориям.')
    return
  }
  if (receipt.categoryId !== null) issue('При распределении выберите категории товаров.')
  if (fiscal?.n === 2) issue('Возврат учитывается одной операцией дохода.')
  if (!receipt.items.length || receipt.items.some(item => item.amount > 0 && item.categoryId === null)) {
    issue('Добавьте позиции и выберите категории товаров.')
  }
  if (difference < 0 || (difference > 0 && (!receipt.mismatchAccepted || !receipt.adjustmentCategoryId))) {
    issue('Сведите сумму товаров с итогом чека или явно распределите недостающую сумму.')
  }
  if (difference === 0 && receipt.adjustmentCategoryId) issue('Сумма товаров уже совпадает с итогом.')
})
export type Receipt = z.infer<typeof receiptSchema>

export const receiptCategoryIds = (receipt: Receipt) =>
  new Set([receipt.categoryId, receipt.adjustmentCategoryId, receipt.roundingCategoryId, ...receipt.items.map(item => item.categoryId)]
    .filter((value): value is string => !!value))

function groupReceiptItems(items: Receipt['items']) {
  const grouped = new Map<string, number>()
  for (const item of items) {
    if (item.categoryId && item.amount > 0) grouped.set(item.categoryId, (grouped.get(item.categoryId) ?? 0) + item.amount)
  }
  return grouped
}

export function defaultReceiptRoundingCategory(receipt: Pick<Receipt, 'items' | 'adjustmentCategoryId'>): string | null {
  let preferred = receipt.adjustmentCategoryId ?? null
  let highest = 0
  for (const [category, amount] of groupReceiptItems(receipt.items)) {
    if (amount > highest) {
      preferred = category
      highest = amount
    }
  }
  return preferred
}

export function receiptOperations(receipt: Receipt): Transaction[] {
  const common = {
    receiptId: receipt.id, memberId: receipt.memberId, date: receipt.date,
    note: receipt.note || receipt.store, authorId: receipt.authorId,
  }
  const operationId = 'receipt:' + receipt.id.length + ':' + receipt.id + ':'
  if (receipt.fiscal?.n === 2) {
    return [{ ...common, id: operationId + 'return', type: 'income', categoryId: null, amount: receipt.total, source: 'Возврат по чеку' }]
  }
  const expense = { ...common, type: 'expense' as const }
  const hasBudgetScope = receipt.budgetScope !== undefined || receipt.items.some(item => item.budgetScope !== undefined)
  const scopeFields = (budgetScope: BudgetScope) => hasBudgetScope ? { budgetScope } : {}
  if (receipt.mode === 'single') {
    const amount = receipt.budgetAmount ?? receipt.total
    return [{
      ...expense, id: operationId + 'total', categoryId: receipt.categoryId, amount,
      ...scopeFields(receiptItemBudgetScope(receipt.items[0] ?? {}, receipt.budgetScope)),
      ...(amount !== receipt.total && { actualAmount: receipt.total }),
    }]
  }

  const grouped = new Map<string, { categoryId: string; scope: BudgetScope; amount: number }>()
  const key = (categoryId: string, scope: BudgetScope) =>
    (scope === 'monthly_only' ? 'monthly-category:' : 'category:') + categoryId
  function add(categoryId: string, scope: BudgetScope, amount: number) {
    const id = key(categoryId, scope)
    grouped.set(id, { categoryId, scope, amount: (grouped.get(id)?.amount ?? 0) + amount })
  }
  for (const item of receipt.items) {
    if (item.categoryId && item.amount > 0) add(item.categoryId, receiptItemBudgetScope(item, receipt.budgetScope), item.amount)
  }

  // Both adjustments follow the largest merchandise subtotal in their category.
  // A tie or a category without merchandise uses the receipt's default scope.
  function adjustmentScope(categoryId: string): BudgetScope {
    const weekly = grouped.get(key(categoryId, 'weekly_and_monthly'))?.amount ?? 0
    const monthly = grouped.get(key(categoryId, 'monthly_only'))?.amount ?? 0
    return weekly === monthly ? receiptItemBudgetScope({}, receipt.budgetScope) : weekly > monthly ? 'weekly_and_monthly' : 'monthly_only'
  }
  const roundingScope = receipt.roundingCategoryId && adjustmentScope(receipt.roundingCategoryId)
  if (receipt.adjustmentCategoryId) {
    const category = receipt.adjustmentCategoryId
    add(category, adjustmentScope(category), receipt.total - receiptItemsTotal(receipt.items))
  }
  const operations: Transaction[] = Array.from(grouped, ([id, { categoryId, scope, amount }]) => ({
    ...expense, id: operationId + id, amount, categoryId, ...scopeFields(scope),
  }))
  if (receipt.roundingDelta && receipt.roundingCategoryId && roundingScope) operations.push({
    ...expense, id: operationId + 'rounding', categoryId: receipt.roundingCategoryId,
    amount: receipt.roundingDelta, actualAmount: 0, receiptRounding: true, ...scopeFields(roundingScope),
  })
  return operations
}

export function normalizeProductName(name: string) {
  return name.normalize('NFKC').toLocaleLowerCase('ru-RU').trim()
    .replace(/^(?:\[[mм]\]|\([mм]\))\s*/u, '').replaceAll('ё', 'е')
    .replace(/(\d)[,.](?=\d)/gu, '$1.')
    .replace(/[^\p{L}\p{N}.%]+/gu, ' ').trim()
}

export const receiptRuleSchema = z.strictObject({
  id, match: z.enum(['exact', 'contains']),
  pattern: z.string().trim().min(1).max(250).refine(value => /[\p{L}\p{N}]/u.test(value)),
  categoryId: id,
})
export type ReceiptRule = z.infer<typeof receiptRuleSchema>

export async function receiptRuleId(match: ReceiptRule['match'], pattern: string) {
  const input = new TextEncoder().encode(match + ':' + normalizeProductName(pattern))
  const hash = await crypto.subtle.digest('SHA-256', input)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

const productTypes = [
  { product: /^(?:молок[оа]|кефир|сыр|йогурт|творог|сметана|сливки)(?: |$)/u, category: /^(?:молоч\p{L}*|молоко|сыр)/u },
  { product: /^(?:куриц\p{L}*|голень|филе кур\p{L}*|филе индей\p{L}*|говядин\p{L}*|свинин\p{L}*|грудка)(?: |$)/u, category: /^(?:мяс\p{L}*|птиц\p{L}*)/u },
  { product: /^(?:огурц\p{L}*|огурек|помидор\p{L}*|морков\p{L}*|картофел\p{L}*|капуст\p{L}*)(?: |$)/u, category: /^овощ\p{L}*/u },
  { product: /^(?:яблок\p{L}*|банан\p{L}*|груш\p{L}*|апельсин\p{L}*)(?: |$)/u, category: /^фрукт\p{L}*/u },
  { product: /^(?:печенье|конфет\p{L}*|шоколад\p{L}*|вафл\p{L}*)(?: |$)/u, category: /^(?:слад\p{L}*|десерт\p{L}*)/u },
  { product: /^(?:мыло|шампунь|стиральный порошок|средство|туалетная бумага)(?: |$)/u, category: /^(?:бытов\p{L}*|гигиен\p{L}*|уход\p{L}*)/u, household: true },
  { product: /^(?:рис|крупа|гречк\p{L}*|мука|макарон\p{L}*|соус)(?: |$)/u, category: /^бакале\p{L}*/u },
]

type CategorySuggestion = { categoryId: string; confidence: 'high' | 'medium' | 'low' }

function uniqueCategory(ids: string[], confidence: CategorySuggestion['confidence']): CategorySuggestion | null {
  const unique = new Set(ids)
  return unique.size === 1 ? { categoryId: ids[0], confidence } : null
}

export function suggestReceiptCategory(name: string, categories: Category[], rules: ReceiptRule[]): CategorySuggestion | null {
  const normalized = normalizeProductName(name)
  if (!normalized) return null
  const active = categories.filter(category => !category.archived)
  const available = new Set(active.map(category => category.id))
  const applicable = rules.filter(rule => available.has(rule.categoryId))
  const exact = applicable.filter(rule => rule.match === 'exact' && rule.pattern === name)
  if (exact.length) return uniqueCategory(exact.map(rule => rule.categoryId), 'high')
  const equivalent = applicable.filter(rule => rule.match === 'exact' && normalizeProductName(rule.pattern) === normalized)
  if (equivalent.length) return uniqueCategory(equivalent.map(rule => rule.categoryId), 'high')
  const contains = applicable.filter(rule => rule.match === 'contains' && (' ' + normalized + ' ').includes(' ' + normalizeProductName(rule.pattern) + ' '))
  if (contains.length) return uniqueCategory(contains.map(rule => rule.categoryId), 'medium')

  const type = productTypes.find(entry => entry.product.test(normalized))
  if (!type) return null
  const matched = active.filter(category => type.category.test(normalizeProductName(category.name)))
  if (matched.length) return uniqueCategory(matched.map(category => category.id), 'medium')
  const tokens = new Set(normalized.split(' ').filter(token => token.length >= 3 && /\p{L}/u.test(token)))
  const similar = applicable.filter(rule => {
    if (rule.match !== 'exact') return false
    const pattern = normalizeProductName(rule.pattern)
    if (!type.product.test(pattern)) return false
    const other = new Set(pattern.split(' ').filter(token => token.length >= 3 && /\p{L}/u.test(token)))
    const overlap = [...other].filter(token => tokens.has(token)).length
    return overlap >= 2 && overlap / new Set([...tokens, ...other]).size >= 0.66
  })
  if (similar.length) return uniqueCategory(similar.map(rule => rule.categoryId), 'low')
  if (type.household) return null
  const food = active.filter(category => /^(?:еда|продукты|продукты питания)$/u.test(normalizeProductName(category.name)))
  return uniqueCategory(food.map(category => category.id), 'low')
}
