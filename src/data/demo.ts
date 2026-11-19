import { addDays, deviceZone, engine, toDay } from '../domain/engine'
import type { Category, Snapshot, Transaction } from '../domain/models'

export const defaultCategories: Category[] = [
  { id: 'food', name: 'Продукты', emoji: '🛒', color: '#a092ff', limits: { week: 700000, month: 2900000 }, archived: false },
  { id: 'cafe', name: 'Кафе', emoji: '☕', color: '#f3ab72', limits: { week: 350000, month: 1500000 }, archived: false },
  { id: 'transport', name: 'Транспорт', emoji: '🚌', color: '#74b5ff', limits: { week: 250000, month: 1050000 }, archived: false },
  { id: 'fun', name: 'Развлечения', emoji: '🍿', color: '#e992c6', limits: { week: 300000, month: 1200000 }, archived: false },
  { id: 'home', name: 'Дом', emoji: '🏠', color: '#71d4b6', limits: { week: 400000, month: 1800000 }, archived: false },
]
const notes = ['Супермаркет', 'Кофе и завтрак', 'Поездки по городу', 'Кино и подписки', 'Покупки для дома']

export function newSnapshot(demo: boolean, now = Date.now()): Snapshot {
  const timezone = deviceZone()
  const weekStart = demo ? 4 : 1
  const today = toDay(now, timezone)
  const transactions: Transaction[] = []
  if (demo) {
    const week = engine.period('week', now, timezone, weekStart)
    const current = [[240000, 180000], [64000, 111000], [76000, 44000], [90000], [290000, 150000]]
    for (let offset = 0; offset > -24; offset--) {
      const start = addDays(week.start, offset * 7)
      const factors = [1, 1.14, 1.44, 1.26, 1.57, 1.32, .92, 1.21]
      defaultCategories.forEach((category, index) => current[index].forEach((amount, entry) => {
        const day = addDays(start, (index + entry * 2) % 7)
        const variation = offset ? factors[Math.abs(offset) % factors.length] * (1 + Math.sin(offset * 4 + index) * .12) : 1
        transactions.push({
          id: `demo-${offset}-${index}-${entry}`, categoryId: category.id, type: 'expense',
          memberId: (index + entry - offset) % 3 === 0 ? 'member-2' : 'member-1',
          amount: Math.round(amount * variation / 100) * 100, date: day > today ? today : day,
          note: entry === 0 ? notes[index] : '',
        })
      }))
      if (offset % 4 === 0) transactions.push({
        id: `income-${offset}`, categoryId: null, type: 'income', memberId: offset % 8 ? 'member-2' : 'member-1',
        amount: 7500000, date: start, note: '', source: 'Зарплата',
      })
    }
  }
  return {
    version: 2,
    profile: {
      household: { id: 'household', name: 'Семейный бюджет' },
      budget: { week: 2000000, month: 9000000 },
      settings: { weekStart, timezone, theme: 'dark', lastCategory: null, demo },
    },
    members: [
      { id: 'member-1', name: demo ? 'Никита' : 'Участник 1', color: '#a092ff' },
      { id: 'member-2', name: demo ? 'Алина' : 'Участник 2', color: '#f0a2bf' },
    ],
    categories: structuredClone(defaultCategories),
    transactions,
  }
}
