import type { Budget, Category, Member, Profile, Snapshot, Transaction } from '../domain/models'
import type { Receipt, ReceiptRule } from '../domain/receipts'
import type { LimitTransfer } from '../domain/limit-transfers'

export type CloudRole = 'owner' | 'member'
export interface Session {
  householdId: string
  memberId: string
  role: CloudRole
}
export interface Authentication {
  session: Session
  recoveryCode: string
}
export type WireBudget = Record<keyof Budget, string>
export type WireProfile = Omit<Profile, 'budget'> & { budget: WireBudget }
export type WireCategory = Omit<Category, 'limits'> & { limits: WireBudget }
export type WireTransaction = Omit<Transaction, 'amount' | 'receiptId' | 'actualAmount' | 'receiptRounding'> & { amount: string }
export type WireMember = Member & { role?: CloudRole; active?: boolean; placeholder?: boolean }

export interface WireSnapshot {
  version: 2 | 3
  profile: WireProfile
  members: WireMember[]
  categories: WireCategory[]
  transactions: WireTransaction[]
  receipts?: Receipt[]
  receiptRules?: ReceiptRule[]
  limitTransfers?: LimitTransfer[]
}

export interface EntityValues {
  profile: WireProfile
  category: WireCategory
  transaction: WireTransaction
  member: WireMember
  receipt: Receipt
  receiptRule: ReceiptRule
  limitTransfer: LimitTransfer
}
export type EntityKind = keyof EntityValues
export type CloudRecord = { [K in EntityKind]: { kind: K; key: string; version: number; value: EntityValues[K] | null } }[EntityKind]
export type Mutation = { [K in EntityKind]: { id: string; kind: K; key: string; expectedVersion: number; value: EntityValues[K] | null } }[EntityKind]
export interface SyncPage {
  cursor: number
  records: CloudRecord[]
  more: boolean
  reset?: boolean
}
export interface Invitation { token: string; expiresAt: string }

export function fromCents(value: string): number {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new Error('Некорректная сумма в копейках.')
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new Error('Сумма выходит за пределы точности приложения.')
  return result
}

function toCents(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Некорректная сумма в копейках.')
  return String(value)
}

const encodeBudget = ({ week, month }: Budget): WireBudget => ({ week: toCents(week), month: toCents(month) })
const decodeBudget = ({ week, month }: WireBudget): Budget => ({ week: fromCents(week), month: fromCents(month) })
export const encodeProfile = (value: Profile): WireProfile => ({ ...value, budget: encodeBudget(value.budget) })
export const decodeProfile = (value: WireProfile): Profile => ({ ...value, budget: decodeBudget(value.budget) })
export const encodeCategory = (value: Category): WireCategory => ({ ...value, limits: encodeBudget(value.limits) })
export const decodeCategory = (value: WireCategory): Category => ({ ...value, limits: decodeBudget(value.limits) })
export const encodeTransaction = (value: Transaction): WireTransaction => ({ ...value, amount: toCents(value.amount) })
export const decodeTransaction = (value: WireTransaction): Transaction => ({ ...value, amount: fromCents(value.amount) })
export const encodeSnapshot = (value: Snapshot): WireSnapshot => ({
  version: value.version,
  members: value.members,
  profile: encodeProfile(value.profile),
  categories: value.categories.map(encodeCategory),
  transactions: value.transactions.filter(row => !row.receiptId).map(encodeTransaction),
  receipts: value.receipts ?? [],
  receiptRules: value.receiptRules ?? [],
  limitTransfers: value.limitTransfers,
})
