import Dexie, { type Table } from 'dexie'
import { z } from 'zod'
import { DEFAULT_CATEGORY_EMOJI, normalizeCategoryEmoji } from '../domain/emoji'
import { addMoney, isDay, isZone, MAX_MONEY } from '../domain/engine'
import { defaultCategories } from './demo'
import type { Category, Member, Profile, Snapshot, Transaction } from '../domain/models'

const stores = { profile: 'household.id', categories: 'id', members: 'id', transactions: 'id,date,categoryId,memberId,type' }
const legacyEmojis = {
  cart: '🛒', coffee: '☕', bus: '🚌', sparkles: '✨', home: '🏠',
  heart: '❤️', bag: '🛍️', plane: '✈️', gift: '🎁', wallet: '👛',
} as const
type LegacyIcon = keyof typeof legacyEmojis
type LegacyCategory = Omit<Category, 'emoji'> & { icon?: LegacyIcon; emoji?: string }

function upgradeCategory({ icon, emoji, ...category }: LegacyCategory): Category {
  const value = emoji === undefined && icon ? legacyEmojis[icon] : normalizeCategoryEmoji(emoji ?? '')
  return { ...category, emoji: value ?? DEFAULT_CATEGORY_EMOJI }
}

class BudgetDatabase extends Dexie {
  profile!: Table<Profile, string>
  categories!: Table<Category, string>
  members!: Table<Member, string>
  transactions!: Table<Transaction, string>

  constructor() {
    super('budget-local')
    this.version(1).stores(stores)
    this.version(2).stores(stores).upgrade(transaction =>
      transaction.table<LegacyCategory, string>('categories').toCollection().modify((category, entry) => {
        entry.value = upgradeCategory(category)
      }),
    )
  }
}

const db = new BudgetDatabase()
const starterOrder = new Map(defaultCategories.map((category, index) => [category.id, index]))
const id = z.string().min(1).max(128)
const name = z.string().trim().min(1).max(60)
const color = z.string().regex(/^#[\da-f]{6}$/i)
const amount = z.number().int().min(0).max(MAX_MONEY)
const budget = z.object({ week: amount, month: amount })
const schema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  profile: z.object({
    household: z.object({ id: z.literal('household'), name }),
    budget,
    settings: z.object({
      weekStart: z.number().int().min(1).max(7),
      timezone: z.string().refine(isZone),
      theme: z.enum(['dark', 'light', 'system']),
      lastCategory: id.nullable(),
      demo: z.boolean(),
    }),
  }),
  categories: z.array(z.object({
    id, name, color, limits: budget, archived: z.boolean(),
    icon: z.enum(Object.keys(legacyEmojis) as LegacyIcon[]).optional(),
    emoji: z.string().optional(),
  })),
  members: z.array(z.object({ id, name, color })).length(2),
  transactions: z.array(z.object({
    id, amount: amount.min(1), memberId: id, type: z.enum(['expense', 'income']), categoryId: id.nullable(),
    date: z.string().refine(isDay), note: z.string().max(300), source: z.string().trim().min(1).max(60).optional(),
    createdAt: z.number().int().min(0).optional(),
  })),
})

export function parseSnapshot(input: unknown): Snapshot {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new Error('Файл не соответствует формату резервной копии Бюджета.')
  const result = parsed.data
  if (result.categories.some(category => category.emoji !== undefined && normalizeCategoryEmoji(category.emoji) === null)) {
    throw new Error('В резервной копии у категории указан недопустимый эмодзи.')
  }
  const categoryIds = new Set(result.categories.map(row => row.id))
  const memberIds = new Set(result.members.map(row => row.id))
  result.transactions.reduce((total, row) => addMoney(total, row.amount), 0)
  const operationIds = new Set(result.transactions.map(row => row.id))
  if (categoryIds.size !== result.categories.length || memberIds.size !== result.members.length ||
      operationIds.size !== result.transactions.length ||
      result.transactions.some(row => !memberIds.has(row.memberId) ||
        (row.type === 'expense' ? !row.categoryId || !categoryIds.has(row.categoryId) : !row.source || row.categoryId !== null))) {
    throw new Error('В файле есть дубликаты или операции без действительной категории, источника или участника.')
  }
  return { ...result, version: 2, categories: result.categories.map(upgradeCategory) }
}

function sameTransaction(a: Transaction, b: Transaction) {
  return a.id === b.id && a.type === b.type && a.amount === b.amount && a.categoryId === b.categoryId &&
    a.memberId === b.memberId && a.date === b.date && a.note === b.note && a.source === b.source && a.createdAt === b.createdAt
}

export const repository = {
  read: () => db.transaction('r', [db.profile, db.categories, db.members, db.transactions], async (): Promise<Snapshot | null> => {
    const [profile, categories, members, transactions] = await Promise.all([
      db.profile.get('household'), db.categories.toArray(), db.members.toArray(), db.transactions.toArray(),
    ])
    categories.sort((a, b) => (starterOrder.get(a.id) ?? Infinity) - (starterOrder.get(b.id) ?? Infinity) || a.name.localeCompare(b.name, 'ru'))
    transactions.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.id.localeCompare(a.id))
    return profile ? { version: 2, profile, categories, members, transactions } : null
  }),
  replace: (input: Snapshot, initialize = false) => {
    const { profile, categories, members, transactions } = parseSnapshot(input)
    return db.transaction('rw', [db.profile, db.categories, db.members, db.transactions], async () => {
      if (initialize && await db.profile.get('household')) return
      await Promise.all([db.categories.clear(), db.members.clear(), db.transactions.clear()])
      await Promise.all([db.profile.put(profile), db.categories.bulkPut(categories), db.members.bulkPut(members), db.transactions.bulkPut(transactions)])
    })
  },
  updateProfile: (update: (profile: Profile) => Profile) => db.transaction('rw', db.profile, async () => {
    const current = await db.profile.get('household')
    if (current) await db.profile.put(update(current))
  }),
  putTransaction: (operation: Transaction, original?: Transaction) => db.transaction('rw', [db.transactions, db.profile, db.categories, db.members], async () => {
    const [member, category, previous] = await Promise.all([
      db.members.get(operation.memberId),
      operation.categoryId ? db.categories.get(operation.categoryId) : undefined,
      db.transactions.get(operation.id),
    ])
    if (original ? !previous || !sameTransaction(previous, original) : previous) {
      throw new Error('Операция была изменена в другой вкладке. Откройте её заново.')
    }
    const maxSafeCount = Math.floor(Number.MAX_SAFE_INTEGER / MAX_MONEY)
    if ((await db.transactions.count()) + (previous ? 0 : 1) > maxSafeCount) {
      let total = operation.amount
      await db.transactions.each(row => { if (row.id !== operation.id) total = addMoney(total, row.amount) })
    }
    if (!member) throw new Error('Участник больше не доступен. Откройте форму заново.')
    if (operation.type === 'expense' && (!category || (category.archived && previous?.categoryId !== category.id))) {
      throw new Error('Категория больше не доступна. Выберите другую.')
    }
    await db.transactions.put(operation)
    if (operation.categoryId) {
      await db.profile.update('household', { 'settings.lastCategory': operation.categoryId })
    }
  }),
  deleteTransaction: (id: string) => db.transactions.delete(id),
  putCategory: (category: Category) => {
    const emoji = normalizeCategoryEmoji(category.emoji)
    if (emoji === null) return Promise.reject(new Error('Укажите один эмодзи для категории.'))
    return db.categories.put({ ...category, emoji })
  },
  putMember: (member: Member) => db.transaction('rw', db.members, async () => {
    const updated = await db.members.update(member.id, { name: member.name })
    if (!updated) throw new Error('Участник больше не доступен. Откройте настройки заново.')
  }),
}
