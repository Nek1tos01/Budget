import type { Receipt, ReceiptRule } from './receipts'
import type { LimitTransfer } from './limit-transfers'

export const MAX_MONEY = 999_999_999_999

export type Day = string
export type PeriodKind = 'week' | 'month'
export type Theme = 'dark' | 'light' | 'system'
export type OperationType = 'expense' | 'income'
export const budgetScopes = ['weekly_and_monthly', 'monthly_only'] as const
export type BudgetScope = (typeof budgetScopes)[number]

export interface Household { id: 'household'; name: string }
export interface Member { id: string; name: string; color: string; role?: 'owner' | 'member'; active?: boolean; placeholder?: boolean }
export interface Budget { week: number; month: number }
export interface Category { id: string; name: string; emoji: string; color: string; limits: Budget; archived: boolean; defaultBudgetScope?: BudgetScope }
export interface Transaction {
  id: string
  type: OperationType
  amount: number
  categoryId: string | null
  memberId: string
  date: Day
  note: string
  source?: string
  createdAt?: number
  authorId?: string
  budgetScope?: BudgetScope
  receiptId?: string
  actualAmount?: number
  receiptRounding?: true
}
export interface BudgetPeriod { kind: PeriodKind; start: Day; end: Day }
export interface Settings {
  weekStart: number
  timezone: string
  theme: Theme
  lastCategory: string | null
  demo: boolean
  roundReceiptTotals?: boolean
}
export interface Profile {
  household: Household
  settings: Settings
  budget: Budget
}
export interface Snapshot {
  version: 2 | 3
  viewerId?: string
  cloudCursor?: number
  profile: Profile
  categories: Category[]
  members: Member[]
  transactions: Transaction[]
  receipts?: Receipt[]
  receiptRules?: ReceiptRule[]
  limitTransfers?: LimitTransfer[]
}
export interface Summary { spent: number; income: number; limit: number; remaining: number; percent: number | null; actualSpent?: number }
export const forecastConfidences = ['insufficient', 'low', 'standard'] as const
export const forecastRisks = ['unknown', 'within_limit', 'over_limit'] as const
export interface Forecast {
  spentToDate: number
  futureSpent: number
  projectedSpent: number
  remaining: number
  elapsedDays: number
  remainingDays: number
  confidence: (typeof forecastConfidences)[number]
  risk: (typeof forecastRisks)[number]
}
export interface Aggregate { id: string; amount: number }
export type SpendingBasis = 'budget' | 'actual'

export interface BudgetEngine {
  period(kind: PeriodKind, now: number, timeZone: string, weekStart: number, offset?: number): BudgetPeriod
  includes(period: BudgetPeriod, date: Day): boolean
  summary(rows: Transaction[], period: BudgetPeriod, limit: number): Summary
  forecast(rows: Transaction[], period: BudgetPeriod, today: Day, limit: number): Forecast
  breakdown(rows: Transaction[], period: BudgetPeriod, group: 'memberId' | 'categoryId', basis?: SpendingBasis): Aggregate[]
  nextReset(now: number, timeZone: string, weekStart: number): number
}
