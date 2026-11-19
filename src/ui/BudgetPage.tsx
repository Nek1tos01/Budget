import { useRef } from 'react'
import { Activity, ArrowUpRight, CalendarDays, ChevronRight, LayoutGrid, Plus, UsersRound, Wallet } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { engine, labelDay, labelPeriod, labelMonth, money, toDay, usageLabel, weekdaysReset } from '../domain/engine'
import type { Category, PeriodKind, Snapshot, Transaction } from '../domain/models'
import { CategoryIcon, ChangeBadge, Empty, Money, MoneyText, OperationRow, PeriodArrows, Progress, Ring, Segmented, screenTransition } from './shared'
import { Trend } from './charts'

export const periodItems = [['week', 'Неделя'], ['month', 'Месяц']] as const

export function useBudgetPeriod(data: Snapshot, now: number, kind: PeriodKind, offset = 0) {
  const { timezone, weekStart } = data.profile.settings
  const today = toDay(now, timezone)
  const get = (unit: PeriodKind, index = 0) => engine.period(unit, now, timezone, weekStart, index)
  const period = get(kind, offset)
  const summary = engine.summary(data.transactions, period, data.profile.budget[kind])
  return { today, period, summary, get }
}

export function BudgetPage({ data, now, kind, offset, changeKind, changeOffset, openWeek, openCategory, openCategories, openHistory, openOperation, openMembers, add }: {
  data: Snapshot; now: number; kind: PeriodKind; offset: number; changeKind: (kind: PeriodKind) => void; changeOffset: (offset: number) => void
  openWeek: () => void; openCategory: (category: Category) => void; openCategories: () => void
  openHistory: () => void; openMembers: () => void; openOperation: (row: Transaction) => void; add: () => void
}) {
  const reduceMotion = useReducedMotion()
  const { today, period, summary, get } = useBudgetPeriod(data, now, kind, offset)
  const { settings, budget } = data.profile
  const spendOf = (unit: PeriodKind, index = 0) => engine.summary(data.transactions, get(unit, index), budget[unit]).spent
  const weekReset = toDay(engine.nextReset(now, settings.timezone, settings.weekStart), settings.timezone)
  const alternate = kind === 'week' ? 'month' : 'week'
  const other = get(alternate)
  const otherSummary = engine.summary(data.transactions, other, budget[alternate])
  const active = data.categories.filter(category => !category.archived)
  const recent = data.transactions.slice(0, 4)
  const touch = useRef<{ x: number; y: number } | null>(null)
  const trend = Array.from({ length: 5 }, (_, i) => {
    const index = offset + i - 4
    return { label: index === 0 ? 'Сейчас' : labelPeriod(get(kind, index), today.slice(0, 4), true), amount: spendOf(kind, index) }
  })

  return <>
    <header className="page-head budget-head">
      <div><button className="reset-chip" type="button" onClick={openWeek} title={'Обновление ' + labelDay(weekReset, true)}><CalendarDays size={15}/> Сброс {weekdaysReset[settings.weekStart - 1]} <ChevronRight size={14}/></button>
        <h1>Бюджет</h1></div>
      <button className="primary desktop-add" onClick={add}><Plus size={19}/> Добавить операцию</button>
      <button className="icon-button mobile-top" onClick={openMembers} aria-label="Участники"><UsersRound size={20}/></button>
    </header>
    <div className="period-toolbar">
      <Segmented items={periodItems} value={kind} onChange={changeKind} label="Вид бюджета"/>
      <PeriodArrows label={labelPeriod(period, today.slice(0, 4))} offset={offset} onChange={changeOffset}/>
    </div>
    <div className="dashboard-grid">
      <div className="overview">
        <div className="swipe-area" onTouchStart={event => {
          if (event.touches.length !== 1) { touch.current = null; return }
          const point = event.touches[0]
          touch.current = point.clientX < 24 || point.clientX > window.innerWidth - 24 ? null : { x: point.clientX, y: point.clientY }
        }} onTouchCancel={() => { touch.current = null }} onTouchEnd={event => {
          if (!touch.current) return
          const dx = event.changedTouches[0].clientX - touch.current.x
          const dy = event.changedTouches[0].clientY - touch.current.y
          touch.current = null
          if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) changeOffset(Math.max(-1200, Math.min(0, offset + (dx > 0 ? -1 : 1))))
        }}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.section key={kind + offset} className="hero" aria-label="Остаток бюджета" initial={reduceMotion ? false : { opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={reduceMotion ? { duration: 0 } : screenTransition}>
              <div className="hero-main">
                <div className="hero-copy"><div className="hero-label"><Wallet size={17}/> {kind === 'week' ? 'Осталось на неделю' : 'Осталось на месяц'}</div>
                  <strong className={`hero-number ${summary.remaining < 0 ? 'negative' : ''}`}><Money value={summary.remaining}/></strong>
                  <span className="hero-description">{summary.remaining < 0 ? 'Расходы превысили лимит' : 'Доступно до ' + labelDay(period.end, true)}</span>
                </div><Ring summary={summary}/>
              </div>
              <div className="hero-metrics"><div><span>Потрачено</span><strong><MoneyText text={money(summary.spent)}/></strong></div><div><span>Общий лимит</span><strong><MoneyText text={money(summary.limit)}/></strong></div></div>
            </motion.section>
          </AnimatePresence>
        </div>
        <button className="alternate" type="button" onClick={() => changeKind(alternate)}>
          <span className="mini-icon purple"><CalendarDays size={21}/></span>
          <span className="alternate-main"><span className="alternate-title">{alternate === 'month' ? 'Бюджет на месяц' : 'Бюджет на неделю'}</span>
            <span className="alternate-values"><strong><MoneyText text={money(otherSummary.spent)}/></strong><small>из {money(otherSummary.limit)}</small></span>
            <Progress summary={otherSummary}/>
          </span>
          <span className="alternate-end"><strong>{usageLabel(otherSummary)}</strong><small>{alternate === 'month' ? labelMonth(other.start) : labelPeriod(other, today.slice(0, 4))}</small></span>
          <ChevronRight className="alternate-arrow" size={17}/>
        </button>
        <section className="trend-panel overview-trend">
          <div className="chart-head"><div><h2><Activity size={17}/> {kind === 'week' ? 'Расходы по неделям' : 'Расходы по месяцам'}</h2></div>
            <ChangeBadge current={summary.spent} previous={spendOf(kind, offset - 1)}/></div>
          <Trend key={kind + offset} values={trend} label="Динамика расходов за пять периодов"/>
        </section>
      </div>
      <aside className="dashboard-aside">
        <section>
          <div className="section-head"><h2>Категории</h2><button className="text-button" onClick={openCategories}>Все <ChevronRight size={16}/></button></div>
          {active.length ? <div className="panel grouped">
            {active.slice(0, 5).map(category => <CategoryRow key={category.id} category={category} summary={engine.summary(data.transactions.filter(row => row.categoryId === category.id), period, category.limits[kind])}
              onClick={() => openCategory(category)}/>)}
          </div> : <div className="panel"><Empty title="Нет категорий" text="Создайте категорию, чтобы учитывать расходы."><button className="secondary" onClick={openCategories}><LayoutGrid size={17}/> Категории</button></Empty></div>}
        </section>
        <section>
          <div className="section-head"><h2>Последние операции</h2><button className="text-button" onClick={openHistory}>История <ArrowUpRight size={15}/></button></div>
          <div className="panel grouped">{recent.length ? recent.map(row => <OperationRow key={row.id} row={row} category={data.categories.find(c => c.id === row.categoryId)}
            member={data.members.find(m => m.id === row.memberId)} onClick={() => openOperation(row)}/>) :
            <Empty title="Операций пока нет" text="Добавьте первый расход или доход."/>}</div>
        </section>
      </aside>
    </div>
  </>
}

export function CategoryRow({ category, summary, onClick }: { category: Category; summary: ReturnType<typeof engine.summary>; onClick: () => void }) {
  return <motion.button layout className="category-row" type="button" onClick={onClick} whileTap={{ scale: .99 }}>
    <CategoryIcon emoji={category.emoji}/>
    <span className="category-progress"><span className="category-caption"><strong>{category.name}</strong><small><MoneyText text={money(summary.spent)}/><MoneyText text={'из ' + money(summary.limit)}/></small></span><Progress summary={summary} color={category.color}/></span>
    <span className={`category-rest ${summary.remaining < 0 ? 'negative' : ''}`}><strong><MoneyText text={money(summary.remaining)}/></strong><small>{summary.remaining < 0 ? 'перерасход' : 'осталось'}</small></span>
  </motion.button>
}
