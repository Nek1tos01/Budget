import { z } from 'zod'
import { decodeCategory, type Mutation, type WireSnapshot } from '../src/cloud/protocol'
import { normalizeCategoryEmoji } from '../src/domain/emoji'
import { assertLimitTransferBalances, limitTransferSchema } from '../src/domain/limit-transfers'
import { budgetScopes } from '../src/domain/models'
import { fiscalReceiptKey, receiptCategoryIds, receiptRuleSchema, receiptSchema } from '../src/domain/receipts'
import { ApiError } from './http'

export const profileName = z.string().trim().min(1).max(60)
export const identifier = z.string().min(1).max(128).refine(value => !Array.from(value).some(character => {
  const code = character.charCodeAt(0)
  return code < 32 || code === 127
}))
export const versionNumber = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const color = z.string().regex(/^#[\da-f]{6}$/i)
const cents = z.string().regex(/^(0|[1-9][0-9]{0,11})$/)
const limits = z.object({ week: cents, month: cents }).strict()
const role = z.enum(['owner', 'member'])
const budgetScope = z.enum(budgetScopes)
export const timezone = z.string().max(100).regex(/^[A-Za-z][A-Za-z0-9_+/-]*$/).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true }
  catch { return false }
})

export const profile = z.object({
  household: z.object({ id: z.literal('household'), name: profileName }).strict(),
  settings: z.object({
    weekStart: z.number().int().min(1).max(7), timezone,
    theme: z.enum(['light', 'dark', 'system']), lastCategory: identifier.nullable(), demo: z.boolean(),
    roundReceiptTotals: z.boolean().optional(),
  }).strict(),
  budget: limits,
}).strict()

export const category = z.object({
  id: identifier, name: profileName, color, limits, archived: z.boolean(),
  emoji: z.string().min(1).max(128).refine(value => normalizeCategoryEmoji(value) !== null),
  defaultBudgetScope: budgetScope.optional(),
}).strict()

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const day = new Date(value + 'T00:00:00Z')
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value
})

export const transaction = z.object({
  id: identifier, amount: cents.refine(value => value !== '0'), memberId: identifier,
  type: z.enum(['expense', 'income']), categoryId: identifier.nullable(), date,
  note: z.string().max(300), source: profileName.optional(), createdAt: versionNumber.optional(),
  authorId: identifier.optional(), budgetScope: budgetScope.optional(),
}).strict().refine(value => value.type === 'expense'
  ? value.categoryId !== null && value.source === undefined
  : value.categoryId === null && value.source !== undefined && value.budgetScope === undefined)

export const member = z.object({
  id: identifier, name: profileName, color, role: role.optional(),
  active: z.boolean().optional(), placeholder: z.boolean().optional(),
}).strict()

const baseMutation = { id: identifier, expectedVersion: versionNumber }
const mutation = z.discriminatedUnion('kind', [
  z.object({ ...baseMutation, kind: z.literal('profile'), key: z.literal('household'), value: profile }).strict(),
  z.object({ ...baseMutation, kind: z.literal('category'), key: identifier, value: category.nullable() }).strict(),
  z.object({ ...baseMutation, kind: z.literal('transaction'), key: identifier, value: transaction.nullable() }).strict(),
  z.object({ ...baseMutation, kind: z.literal('member'), key: identifier, value: member }).strict(),
  z.object({ ...baseMutation, kind: z.literal('receipt'), key: identifier, value: receiptSchema.nullable() }).strict(),
  z.object({ ...baseMutation, kind: z.literal('receiptRule'), key: identifier, value: receiptRuleSchema.nullable() }).strict(),
  z.object({ ...baseMutation, kind: z.literal('limitTransfer'), key: identifier, value: limitTransferSchema }).strict(),
])

const snapshot = z.object({
  version: z.union([z.literal(2), z.literal(3)]), profile,
  categories: z.array(category).max(8_000), members: z.array(member).min(1).max(1_000),
  transactions: z.array(transaction).max(8_000),
  receipts: z.array(receiptSchema).max(8_000).optional(), receiptRules: z.array(receiptRuleSchema).max(8_000).optional(),
  limitTransfers: z.array(limitTransferSchema).max(8_000).optional(),
}).strict()

export function validateLimitChange(assertion: () => void) {
  try {
    assertion()
  } catch (error) {
    if (!(error instanceof Error)) throw error
    throw new ApiError(400, error.message)
  }
}

export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new ApiError(400, 'Данные запроса имеют неверный формат.')
  return parsed.data
}

export function parseMutation(body: unknown): Mutation {
  const value = parse(mutation, body)
  if (value.value && 'id' in value.value && value.value.id !== value.key) {
    throw new ApiError(400, 'Идентификаторы записи не совпадают.')
  }
  return value
}

export const migration = z.object({ id: identifier, expectedCursor: versionNumber, snapshot }).strict()

export function validateSnapshot(value: WireSnapshot): bigint {
  const categories = new Set(value.categories.map(row => row.id))
  const members = new Set(value.members.map(row => row.id))
  const transactions = new Set(value.transactions.map(row => row.id))
  const receipts = value.receipts ?? []
  const rules = value.receiptRules ?? []
  const fiscalKeys = receipts.map(row => fiscalReceiptKey(row.fiscal)).filter(key => key !== null)
  if (categories.size !== value.categories.length || members.size !== value.members.length ||
      transactions.size !== value.transactions.length ||
      new Set(receipts.map(row => row.id)).size !== receipts.length || new Set(fiscalKeys).size !== fiscalKeys.length ||
      new Set(rules.map(row => row.id)).size !== rules.length ||
      (value.profile.settings.lastCategory !== null && !categories.has(value.profile.settings.lastCategory))) {
    throw new ApiError(400, 'В копии есть дубликаты или ссылки на отсутствующие записи.')
  }
  let total = 0n
  for (const row of value.transactions) {
    if (!members.has(row.memberId) || (row.authorId && !members.has(row.authorId)) ||
        (row.categoryId !== null && !categories.has(row.categoryId))) {
      throw new ApiError(400, 'В копии есть ссылки на отсутствующие записи.')
    }
    total += BigInt(row.amount)
  }
  for (const row of receipts) {
    if (!members.has(row.memberId) || (row.authorId && !members.has(row.authorId)) ||
        [...receiptCategoryIds(row)].some(id => !categories.has(id))) {
      throw new ApiError(400, 'В копии есть ссылки на отсутствующие записи.')
    }
    total += BigInt(row.budgetAmount ?? row.total)
  }
  if (rules.some(rule => !categories.has(rule.categoryId))) {
    throw new ApiError(400, 'В копии есть ссылки на отсутствующие записи.')
  }
  if (value.limitTransfers?.length) {
    validateLimitChange(() => assertLimitTransferBalances(value.categories.map(decodeCategory), value.limitTransfers ?? []))
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError(400, 'Оборот превышает допустимую точность.')
  return total
}
