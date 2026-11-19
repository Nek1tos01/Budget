export type Day = string
export type PeriodKind = 'week' | 'month'
export type Theme = 'dark' | 'light' | 'system'
export type OperationType = 'expense' | 'income'

export interface Household { id: 'household'; name: string }
export interface Member { id: string; name: string; color: string }
export interface Budget { week: number; month: number }
export interface Category { id: string; name: string; emoji: string; color: string; limits: Budget; archived: boolean }
export interface Transaction { id: string; type: OperationType; amount: number; categoryId: string | null; memberId: string; date: Day; note: string; source?: string; createdAt?: number }
export interface BudgetPeriod { kind: PeriodKind; start: Day; end: Day }
export interface Settings {
  weekStart: number
  timezone: string
  theme: Theme
  lastCategory: string | null
  demo: boolean
}
export interface Profile {
  household: Household
  settings: Settings
  budget: Budget
}
export interface Snapshot {
  version: 2
  profile: Profile
  categories: Category[]
  members: Member[]
  transactions: Transaction[]
}
export interface Summary { spent: number; income: number; limit: number; remaining: number; percent: number | null }
export interface Aggregate { id: string; amount: number }

export interface BudgetEngine {
  period(kind: PeriodKind, now: number, timeZone: string, weekStart: number, offset?: number): BudgetPeriod
  includes(period: BudgetPeriod, date: Day): boolean
  summary(rows: Transaction[], period: BudgetPeriod, limit: number): Summary
  breakdown(rows: Transaction[], period: BudgetPeriod, group: 'memberId' | 'categoryId'): Aggregate[]
  nextReset(now: number, timeZone: string, weekStart: number): number
}
