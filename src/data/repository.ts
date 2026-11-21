import { project, readConnection, restoreCloud, workspaceScope, writeCloud, type WorkspaceScope } from '../cloud/client'
import { encodeCategory, encodeProfile, encodeTransaction } from '../cloud/protocol'
import Dexie, { type Table } from 'dexie'
import { z } from 'zod'
import { DEFAULT_CATEGORY_EMOJI, normalizeCategoryEmoji } from '../domain/emoji'
import { addMoney, isDay, isZone, MAX_MONEY } from '../domain/engine'
import {
  assertLimitTransferBalances, assertLimitTransferChange, currentLimitPeriod, limitTransferSchema, sameLimitPeriod,
  type LimitTransfer,
} from '../domain/limit-transfers'
import {
  fiscalReceiptKey, normalizeProductName, receiptCategoryIds, receiptOperations, receiptRuleSchema, receiptSchema,
  type Receipt, type ReceiptRule,
} from '../domain/receipts'
import { defaultCategories } from './demo'
import { budgetScopes, type Category, type Member, type Profile, type Snapshot, type Transaction } from '../domain/models'

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
  receipts!: Table<Receipt, string>
  receiptRules!: Table<ReceiptRule, string>
  receiptDrafts!: Table<{ scope: WorkspaceScope; value: unknown }, WorkspaceScope>
  limitTransfers!: Table<LimitTransfer, string>

  constructor() {
    super('budget-local')
    this.version(1).stores(stores)
    this.version(2).stores(stores).upgrade(transaction =>
      transaction.table<LegacyCategory, string>('categories').toCollection().modify((category, entry) => {
        entry.value = upgradeCategory(category)
      }),
    )
    this.version(3).stores({ ...stores, receipts: 'id', receiptRules: 'id', receiptDrafts: 'scope' })
    this.version(4).stores({ limitTransfers: 'id' })
  }
}

const db = new BudgetDatabase()
const workspaceTables = [db.profile, db.categories, db.members, db.transactions, db.receipts, db.receiptRules, db.limitTransfers]
const starterOrder = new Map(defaultCategories.map((category, index) => [category.id, index]))
const id = z.string().min(1).max(128)
const name = z.string().trim().min(1).max(60)
const color = z.string().regex(/^#[\da-f]{6}$/i)
const amount = z.number().int().min(0).max(MAX_MONEY)
const budget = z.object({ week: amount, month: amount })
const budgetScope = z.enum(budgetScopes).optional()
const schema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  profile: z.object({
    household: z.object({ id: z.literal('household'), name }),
    budget,
    settings: z.object({
      weekStart: z.number().int().min(1).max(7),
      timezone: z.string().refine(isZone),
      theme: z.enum(['dark', 'light', 'system']),
      lastCategory: id.nullable(),
      demo: z.boolean(),
      roundReceiptTotals: z.boolean().optional(),
    }),
  }),
  categories: z.array(z.object({
    id, name, color, limits: budget, archived: z.boolean(),
    icon: z.enum(Object.keys(legacyEmojis) as LegacyIcon[]).optional(),
    emoji: z.string().optional(),
    defaultBudgetScope: budgetScope,
  })),
  members: z.array(z.object({
    id, name, color, role: z.enum(['owner', 'member']).optional(),
    active: z.boolean().optional(), placeholder: z.boolean().optional(),
  })).min(2),
  transactions: z.array(z.object({
    id, amount: amount.min(1), memberId: id, type: z.enum(['expense', 'income']), categoryId: id.nullable(),
    date: z.string().refine(isDay), note: z.string().max(300), source: z.string().trim().min(1).max(60).optional(),
    createdAt: z.number().int().min(0).optional(), authorId: id.optional(),
    budgetScope,
  })),
  receipts: z.array(receiptSchema).optional(),
  receiptRules: z.array(receiptRuleSchema).optional(),
  limitTransfers: z.array(limitTransferSchema).max(8000).optional(),
})

export function backupSnapshot({ version, profile, categories, members, transactions, receipts, receiptRules, limitTransfers }: Snapshot): Snapshot {
  return {
    version, profile, categories, members,
    transactions: transactions.filter(row => !row.receiptId),
    ...(receipts?.length ? { receipts } : {}),
    ...(receiptRules?.length ? { receiptRules } : {}),
    ...(limitTransfers !== undefined ? { limitTransfers } : {}),
  }
}

export function parseSnapshot(input: unknown): Snapshot {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new Error('Файл не соответствует формату резервной копии Бюджета.')
  const result = parsed.data
  if (result.version < 3 && result.members.length !== 2) throw new Error('Резервная копия должна содержать двух участников.')
  if (result.categories.some(category => category.emoji !== undefined && normalizeCategoryEmoji(category.emoji) === null)) {
    throw new Error('В резервной копии у категории указан недопустимый эмодзи.')
  }
  const categoryIds = new Set(result.categories.map(row => row.id))
  const memberIds = new Set(result.members.map(row => row.id))
  const receipts = result.receipts ?? []
  const rules = result.receiptRules ?? []
  const fiscal = receipts.flatMap(receipt => fiscalReceiptKey(receipt.fiscal) ?? [])
  const operations = [...result.transactions, ...receipts.flatMap(receiptOperations)]
  operations.reduce((total, row) => addMoney(total, row.amount), 0)
  const operationIds = new Set(result.transactions.map(row => row.id))
  if (categoryIds.size !== result.categories.length || memberIds.size !== result.members.length ||
      operationIds.size !== result.transactions.length ||
      result.transactions.some(row => !memberIds.has(row.memberId) || (row.authorId && !memberIds.has(row.authorId)) ||
        (row.type === 'expense' ? !row.categoryId || !categoryIds.has(row.categoryId) : !row.source || row.categoryId !== null || row.budgetScope !== undefined)) ||
      new Set(operations.map(row => row.id)).size !== operations.length ||
      new Set(receipts.map(row => row.id)).size !== receipts.length || new Set(fiscal).size !== fiscal.length ||
      new Set(rules.map(row => row.id)).size !== rules.length ||
      receipts.some(row => !memberIds.has(row.memberId) || (row.authorId && !memberIds.has(row.authorId)) ||
        [...receiptCategoryIds(row)].some(value => !categoryIds.has(value))) ||
      rules.some(rule => !categoryIds.has(rule.categoryId))) {
    throw new Error('В файле есть дубликаты или операции без действительной категории, источника или участника.')
  }
  const categories = result.categories.map(upgradeCategory)
  assertLimitTransferBalances(categories, result.limitTransfers ?? [])
  return { ...result, version: result.version === 3 ? 3 : 2, categories }
}

function assertUnchanged<T>(entity: z.ZodType<T>, previous: T | undefined, original: T | undefined, message: string) {
  if (original && (!previous || JSON.stringify(entity.parse(previous)) !== JSON.stringify(entity.parse(original)))) throw new Error(message)
}

function validateReceiptWrite(receipt: Receipt, snapshot: Snapshot, previous?: Receipt) {
  const fiscal = fiscalReceiptKey(receipt.fiscal)
  if (previous?.fiscal && JSON.stringify(previous.fiscal) !== JSON.stringify(receipt.fiscal)) {
    throw new Error('Фискальные реквизиты сохранённого чека нельзя изменить.')
  }
  if (fiscal && snapshot.receipts?.some(other => other.id !== receipt.id && fiscalReceiptKey(other.fiscal) === fiscal)) {
    throw new Error('Этот чек уже добавлен.')
  }
  const member = snapshot.members.find(row => row.id === receipt.memberId)
  if (!member || (member.active === false && !member.placeholder && member.id !== previous?.memberId)) {
    throw new Error('Участник больше не доступен.')
  }
  const previousCategories = previous ? receiptCategoryIds(previous) : new Set<string>()
  for (const categoryId of receiptCategoryIds(receipt)) {
    const category = snapshot.categories.find(row => row.id === categoryId)
    if (!category || (category.archived && !previousCategories.has(categoryId))) throw new Error('Категория больше не доступна.')
  }
  const derivedIds = new Set(receiptOperations(receipt).map(row => row.id))
  let total = receipt.budgetAmount ?? receipt.total
  for (const row of snapshot.transactions) {
    if (row.receiptId === receipt.id) continue
    if (derivedIds.has(row.id)) throw new Error('Идентификатор операции чека уже используется.')
    total = addMoney(total, row.amount)
  }
}

function validateReceiptRuleWrite(rule: ReceiptRule, snapshot: Snapshot) {
  if (!snapshot.categories.some(category => category.id === rule.categoryId && !category.archived)) {
    throw new Error('Категория больше не доступна.')
  }
  const pattern = normalizeProductName(rule.pattern)
  if (snapshot.receiptRules?.some(other => other.id !== rule.id && other.match === rule.match && normalizeProductName(other.pattern) === pattern)) {
    throw new Error('Правило с таким условием уже есть.')
  }
}

function sameTransaction(a: Transaction, b: Transaction) {
  return a.id === b.id && a.type === b.type && a.amount === b.amount && a.categoryId === b.categoryId &&
    a.memberId === b.memberId && a.date === b.date && a.note === b.note && a.source === b.source && a.createdAt === b.createdAt && a.authorId === b.authorId &&
    (a.budgetScope ?? 'weekly_and_monthly') === (b.budgetScope ?? 'weekly_and_monthly')
}

function validateOrdinaryTransaction(operation: Transaction, original?: Transaction) {
  if (operation.receiptId || original?.receiptId || operation.receiptRounding || operation.actualAmount !== undefined) {
    throw new Error('Измените операцию в деталях чека.')
  }
  if (operation.budgetScope !== undefined && (operation.type !== 'expense' || !budgetScope.safeParse(operation.budgetScope).success)) {
    throw new Error('Выберите действительный режим учёта расхода.')
  }
}

export const localRepository = {
  read: () => db.transaction('r', workspaceTables, async (): Promise<Snapshot | null> => {
    const [profile, categories, members, regularTransactions, receipts, receiptRules, limitTransfers] = await Promise.all([
      db.profile.get('household'), db.categories.toArray(), db.members.toArray(), db.transactions.toArray(),
      db.receipts.toArray(), db.receiptRules.toArray(), db.limitTransfers.toArray(),
    ])
    const transactions = [...regularTransactions, ...receipts.flatMap(receiptOperations)]
    categories.sort((a, b) => (starterOrder.get(a.id) ?? Infinity) - (starterOrder.get(b.id) ?? Infinity) || a.name.localeCompare(b.name, 'ru'))
    transactions.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.id.localeCompare(a.id))
    return profile ? {
      version: members.length !== 2 || members.some(row => row.role) || transactions.some(row => row.authorId) ? 3 : 2,
      profile, categories, members, transactions,
      ...(receipts.length ? { receipts } : {}),
      ...(receiptRules.length ? { receiptRules } : {}),
      limitTransfers,
    } : null
  }),
  replace: (input: Snapshot, initialize = false) => {
    const { profile, categories, members, transactions, receipts = [], receiptRules = [], limitTransfers } = parseSnapshot(backupSnapshot(input))
    return db.transaction('rw', workspaceTables, async () => {
      if (initialize && await db.profile.get('household')) return
      if (limitTransfers === undefined && await db.limitTransfers.count()) {
        throw new Error('Эта копия не содержит историю переносов. Используйте актуальную копию бюджета.')
      }
      await Promise.all([db.categories.clear(), db.members.clear(), db.transactions.clear(), db.receipts.clear(), db.receiptRules.clear(), db.limitTransfers.clear()])
      await Promise.all([
        db.profile.put(profile), db.categories.bulkPut(categories), db.members.bulkPut(members), db.transactions.bulkPut(transactions),
        db.receipts.bulkPut(receipts), db.receiptRules.bulkPut(receiptRules), db.limitTransfers.bulkPut(limitTransfers ?? []),
      ])
    })
  },
  updateProfile: (update: (profile: Profile) => Profile) => db.transaction('rw', db.profile, async () => {
    const current = await db.profile.get('household')
    if (current) await db.profile.put(update(current))
  }),
  putTransaction: (operation: Transaction, original?: Transaction) => db.transaction('rw', workspaceTables, async () => {
    validateOrdinaryTransaction(operation, original)
    const [member, category, previous] = await Promise.all([
      db.members.get(operation.memberId),
      operation.categoryId ? db.categories.get(operation.categoryId) : undefined,
      db.transactions.get(operation.id),
    ])
    if (original ? !previous || !sameTransaction(previous, original) : previous) {
      throw new Error('Операция была изменена в другой вкладке. Откройте её заново.')
    }
    const maxSafeCount = Math.floor(Number.MAX_SAFE_INTEGER / (MAX_MONEY + 1))
    if ((await db.transactions.count()) + (await db.receipts.count()) + (previous ? 0 : 1) > maxSafeCount) {
      let total = operation.amount
      await db.transactions.each(row => { if (row.id !== operation.id) total = addMoney(total, row.amount) })
      await db.receipts.each(receipt => { total = addMoney(total, receipt.budgetAmount ?? receipt.total) })
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
    return db.transaction('rw', [db.categories, db.limitTransfers], async () => {
      const categories = (await db.categories.toArray()).filter(row => row.id !== category.id)
      assertLimitTransferBalances([...categories, category], await db.limitTransfers.toArray())
      return db.categories.put({ ...category, emoji })
    })
  },
  putMember: (member: Member) => db.transaction('rw', db.members, async () => {
    const updated = await db.members.update(member.id, { name: member.name })
    if (!updated) throw new Error('Участник больше не доступен. Откройте настройки заново.')
  }),
}


function sharedProfile(profile: Profile): Profile {
  return { ...profile, settings: { ...profile.settings, theme: 'dark', lastCategory: null, demo: false } }
}

async function connectionFor(scope?: WorkspaceScope) {
  const cloud = await readConnection()
  if (scope && workspaceScope(cloud) !== scope) throw new Error('Бюджет изменился. Откройте форму заново.')
  if (cloud?.mode === 'staging') throw new Error('Завершите перенос или выйдите из подготовленного общего бюджета, чтобы снова редактировать локальные данные.')
  return cloud
}
async function readWorkspace() {
  const connection = await readConnection()
  return {
    connection, scope: workspaceScope(connection),
    data: connection?.mode === 'active' ? project(connection) : await localRepository.read(),
  }
}

export const repository = {
  readWorkspace,
  async read() { return (await readWorkspace()).data },
  replace(input: Snapshot, initialize = false, scope?: WorkspaceScope, expectedCursor?: number) {
    const snapshot = parseSnapshot(backupSnapshot(input))
    return connectionFor(scope).then(cloud => cloud?.mode === 'active'
      ? restoreCloud(snapshot, cloud, expectedCursor)
      : localRepository.replace(snapshot, initialize))
  },
  async updateProfile(update: (profile: Profile) => Profile, original?: Profile, scope?: WorkspaceScope) {
    const cloud = await connectionFor(scope)
    if (cloud?.mode !== 'active') return localRepository.updateProfile(update)
    return writeCloud(cloud, (current, snapshot) => {
      if (original && (original.household.name !== snapshot.profile.household.name || original.budget.week !== snapshot.profile.budget.week ||
        original.budget.month !== snapshot.profile.budget.month)) throw new Error('Лимиты изменились. Откройте редактор заново.')
      const next = update(snapshot.profile)
      current.theme = next.settings.theme
      current.lastCategory = next.settings.lastCategory
      const profile = sharedProfile(next)
      if (JSON.stringify(profile) === JSON.stringify(sharedProfile(snapshot.profile))) return null
      return { kind: 'profile', key: 'household', value: encodeProfile(profile) }
    })
  },
  async putTransaction(operation: Transaction, original?: Transaction, scope?: WorkspaceScope) {
    const cloud = await connectionFor(scope)
    if (cloud?.mode !== 'active') return localRepository.putTransaction(operation, original)
    validateOrdinaryTransaction(operation, original)
    return writeCloud(cloud, (current, snapshot) => {
      const previous = snapshot.transactions.find(row => row.id === operation.id)
      if (original ? !previous || !sameTransaction(previous, original) : previous) throw new Error('Операция изменилась. Откройте её заново.')
      const member = snapshot.members.find(item => item.id === operation.memberId)
      if (!member || (member.active === false && !member.placeholder && previous?.memberId !== member.id)) {
        throw new Error('Участник больше не доступен.')
      }
      if (operation.type === 'expense') {
        const category = snapshot.categories.find(item => item.id === operation.categoryId)
        if (!category || (category.archived && previous?.categoryId !== category.id)) throw new Error('Категория больше не доступна.')
      }
      let total = operation.amount
      for (const other of snapshot.transactions) if (other.id !== operation.id) total = addMoney(total, other.amount)
      if (operation.categoryId) current.lastCategory = operation.categoryId
      const authorId = previous?.authorId ?? current.session.memberId
      return { kind: 'transaction', key: operation.id, value: encodeTransaction({ ...operation, authorId }) }
    })
  },
  async deleteTransaction(id: string, original?: Transaction, scope?: WorkspaceScope) {
    if (original?.receiptId) throw new Error('Удалите операцию в деталях чека.')
    const cloud = await connectionFor(scope)
    if (cloud?.mode !== 'active') return localRepository.deleteTransaction(id)
    return writeCloud(cloud, (_current, snapshot) => {
      const stored = snapshot.transactions.find(item => item.id === id)
      if (!stored || stored.receiptId || (original && !sameTransaction(stored, original))) throw new Error('Операция изменилась. Откройте её заново.')
      return { kind: 'transaction', key: id, value: null }
    })
  },
  async putCategory(category: Category, original?: Category, scope?: WorkspaceScope) {
    const cloud = await connectionFor(scope)
    if (cloud?.mode !== 'active') return localRepository.putCategory(category)
    return writeCloud(cloud, (_current, snapshot) => {
      const actual = snapshot.categories.find(item => item.id === category.id)
      if (original && (!actual || actual.name !== original.name || actual.emoji !== original.emoji || actual.color !== original.color ||
        actual.archived !== original.archived || actual.limits.week !== original.limits.week || actual.limits.month !== original.limits.month ||
        (actual.defaultBudgetScope ?? 'weekly_and_monthly') !== (original.defaultBudgetScope ?? 'weekly_and_monthly'))) {
        throw new Error('Категория изменилась. Откройте редактор заново.')
      }
      const emoji = normalizeCategoryEmoji(category.emoji)
      if (emoji === null) throw new Error('Укажите один эмодзи для категории.')
      assertLimitTransferBalances([...snapshot.categories.filter(row => row.id !== category.id), category], snapshot.limitTransfers ?? [])
      return { kind: 'category', key: category.id, value: encodeCategory({ ...category, emoji }) }
    })
  },
  async putMember(member: Member, scope?: WorkspaceScope) {
    const cloud = await connectionFor(scope)
    if (cloud?.mode !== 'active') return localRepository.putMember(member)
    if (member.id !== cloud.session.memberId) throw new Error('Можно изменить только собственный профиль.')
    return writeCloud(cloud, (_current, snapshot) => {
      const stored = snapshot.members.find(item => item.id === member.id)
      if (!stored) throw new Error('Участник больше не доступен.')
      return { kind: 'member', key: member.id, value: { ...stored, name: member.name } }
    })
  },
  async putReceipt(input: Receipt, scope?: WorkspaceScope, original?: Receipt) {
    const receipt = receiptSchema.parse(input)
    const cloud = await connectionFor(scope)
    const update = (snapshot: Snapshot) => {
      const previous = snapshot.receipts?.find(row => row.id === receipt.id)
      assertUnchanged(receiptSchema, previous, original, 'Чек изменился. Откройте его заново.')
      if (previous && !original) throw new Error('Этот чек уже добавлен.')
      validateReceiptWrite(receipt, snapshot, previous)
      return previous
    }
    if (cloud?.mode === 'active') return writeCloud(cloud, (current, snapshot) => {
      const previous = update(snapshot)
      return { kind: 'receipt', key: receipt.id, value: { ...receipt, authorId: previous?.authorId ?? current.session.memberId } }
    })
    await db.transaction('rw', workspaceTables, async () => {
      const snapshot = await localRepository.read()
      if (!snapshot) throw new Error('Создайте бюджет перед добавлением чека.')
      update(snapshot)
      await db.receipts.put(receipt)
    })
  },
  async deleteReceipt(id: string, scope?: WorkspaceScope, original?: Receipt) {
    const cloud = await connectionFor(scope)
    const validate = (previous: Receipt | undefined) => {
      if (!previous) throw new Error('Чек уже удалён.')
      assertUnchanged(receiptSchema, previous, original, 'Чек изменился. Откройте его заново.')
    }
    if (cloud?.mode === 'active') return writeCloud(cloud, (_current, snapshot) => {
      validate(snapshot.receipts?.find(row => row.id === id))
      return { kind: 'receipt', key: id, value: null }
    })
    await db.transaction('rw', db.receipts, async () => {
      validate(await db.receipts.get(id))
      await db.receipts.delete(id)
    })
  },
  async putReceiptRule(input: ReceiptRule, scope?: WorkspaceScope, original?: ReceiptRule) {
    const rule = receiptRuleSchema.parse(input)
    const cloud = await connectionFor(scope)
    const validate = (snapshot: Snapshot) => {
      assertUnchanged(receiptRuleSchema, snapshot.receiptRules?.find(row => row.id === rule.id), original, 'Правило изменилось. Откройте его заново.')
      validateReceiptRuleWrite(rule, snapshot)
    }
    if (cloud?.mode === 'active') return writeCloud(cloud, (_current, snapshot) => {
      validate(snapshot)
      return { kind: 'receiptRule', key: rule.id, value: rule }
    })
    await db.transaction('rw', workspaceTables, async () => {
      const snapshot = await localRepository.read()
      if (!snapshot) throw new Error('Создайте бюджет перед добавлением правила.')
      validate(snapshot)
      await db.receiptRules.put(rule)
    })
  },
  async deleteReceiptRule(id: string, scope?: WorkspaceScope, original?: ReceiptRule) {
    const cloud = await connectionFor(scope)
    if (cloud?.mode === 'active') return writeCloud(cloud, (_current, snapshot) => {
      const previous = snapshot.receiptRules?.find(row => row.id === id)
      if (!previous && !original) return null
      assertUnchanged(receiptRuleSchema, previous, original, 'Правило изменилось. Откройте его заново.')
      return { kind: 'receiptRule', key: id, value: null }
    })
    await db.transaction('rw', db.receiptRules, async () => {
      assertUnchanged(receiptRuleSchema, await db.receiptRules.get(id), original, 'Правило изменилось. Откройте его заново.')
      await db.receiptRules.delete(id)
    })
  },
  async putLimitTransfer(input: LimitTransfer, scope?: WorkspaceScope, original?: LimitTransfer) {
    const transfer = limitTransferSchema.parse(input)
    const cloud = await connectionFor(scope)
    const check = (snapshot: Snapshot) => {
      const transfers = snapshot.limitTransfers ?? []
      const previous = transfers.find(row => row.id === transfer.id)
      if (previous && !original) throw new Error('Этот перенос уже существует.')
      assertUnchanged(limitTransferSchema, previous, original, 'Перенос изменился. Откройте его заново.')
      if (!sameLimitPeriod(transfer, currentLimitPeriod(transfer.kind, Date.now(), snapshot.profile.settings))) {
        throw new Error('Этот финансовый период уже не текущий.')
      }
      assertLimitTransferChange(transfer, previous, snapshot.categories, transfers, snapshot.transactions)
    }
    if (cloud?.mode === 'active') return writeCloud(cloud, (_current, snapshot) => {
      check(snapshot)
      return { kind: 'limitTransfer', key: transfer.id, value: transfer }
    })
    await db.transaction('rw', workspaceTables, async () => {
      const snapshot = await localRepository.read()
      if (!snapshot) throw new Error('Создайте бюджет перед переносом.')
      check(snapshot)
      await db.limitTransfers.put(transfer)
    })
  },
  async loadReceiptDraft(scope: WorkspaceScope): Promise<unknown> {
    return (await db.receiptDrafts.get(scope))?.value
  },
  saveReceiptDraft(scope: WorkspaceScope, value: unknown) {
    return db.receiptDrafts.put({ scope, value })
  },
  deleteReceiptDraft(scope: WorkspaceScope) {
    return db.receiptDrafts.delete(scope)
  },
}
