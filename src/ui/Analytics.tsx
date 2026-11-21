import { useState, type CSSProperties } from 'react'
import { Activity, ChartNoAxesColumnIncreasing, UsersRound } from 'lucide-react'
import type { Aggregate, PeriodKind, Snapshot } from '../domain/models'
import { engine, labelPeriod, money, usagePercent } from '../domain/engine'
import { periodItems, useBudgetPeriod } from './BudgetPage'
import { Avatar, CategoryIcon, ChangeBadge, Empty, PeriodArrows, Segmented } from './shared'
import { Trend } from './charts'
import { ForecastCard } from './ForecastCard'

function includeActualGroups(accounted: Aggregate[], actual: Map<string, number>) {
  const accountedIds = new Set(accounted.map(row => row.id))
  return [...accounted, ...Array.from(actual.keys()).filter(id => !accountedIds.has(id)).map(id => ({ id, amount: 0 }))]
}

export function Analytics({ data, now }: { data: Snapshot; now: number }) {
  const [kind, setKind] = useState<PeriodKind>('week')
  const [offset, setOffset] = useState(0)
  const [focused, setFocused] = useState('')
  const { today, period, summary, get } = useBudgetPeriod(data, now, kind, offset)
  const year = today.slice(0, 4)
  const previous = engine.summary(data.transactions, get(kind, offset - 1), 0).spent
  const groups = engine.breakdown(data.transactions, period, 'categoryId')
  const members = engine.breakdown(data.transactions, period, 'memberId')
  const actualSpent = summary.actualSpent ?? summary.spent
  const actualCategories = new Map(engine.breakdown(data.transactions, period, 'categoryId', 'actual')
    .filter(row => row.amount > 0).map(row => [row.id, row.amount]))
  const actualMembers = new Map(engine.breakdown(data.transactions, period, 'memberId', 'actual').map(row => [row.id, row.amount]))
  const allGroups = includeActualGroups(groups, actualCategories)
  const points = Array.from({ length: 5 }, (_, i) => {
    const index = offset + i - 4
    const point = get(kind, index)
    return { label: index === 0 ? 'Сейчас' : labelPeriod(point, year, true), amount: engine.summary(data.transactions, point, 0).spent }
  })
  const selected = allGroups.find(row => row.id === focused)
  let sliceStart = 0
  const slices = summary.spent > 0 ? groups.map((row, index) => {
    const start = sliceStart
    sliceStart += row.amount / summary.spent * 100
    return `var(--chart-slice-${index % 5}) ${start}% ${index === groups.length - 1 ? 100 : sliceStart}%`
  }) : []
  return <><header className="page-head"><div><h1>Аналитика</h1><p>Куда уходят деньги</p></div></header>
    <div className="period-toolbar"><Segmented items={periodItems} value={kind} onChange={value => { setKind(value); setOffset(0); setFocused('') }} label="Период аналитики"/>
      <PeriodArrows label={labelPeriod(period, year)} offset={offset} onChange={setOffset}/></div>
    <div className="analysis-grid">
      <section className="panel trend-panel analytics-trend"><div className="chart-head"><div><h2><Activity size={18}/> Динамика расходов</h2>
        {actualSpent !== summary.spent && <p>Учтено в бюджете</p>}
        <strong className="analytics-value">{money(summary.spent)}</strong>
        {actualSpent !== summary.spent && <p>Фактические расходы · {money(actualSpent)}</p>}
        <p>Прошлый период · {money(previous)}</p></div><ChangeBadge current={summary.spent} previous={previous}/></div>
        <Trend key={kind + offset} values={points} label="Динамика расходов за пять периодов" bars/>
      </section>
      {offset === 0 && <ForecastCard rows={data.transactions} period={period} today={today} limit={summary.limit}/>}
      <section className="panel analysis-panel"><h2><ChartNoAxesColumnIncreasing size={18}/> Расходы по категориям</h2>
        {slices.length > 0 && summary.spent > 0 && <div className="analytics-donut" aria-hidden="true"
          style={{ backgroundImage: `conic-gradient(${slices.join(', ')})` }}><span>{money(selected?.amount ?? summary.spent)}</span></div>}
        {allGroups.length ? <>{groups.length > 0 && <div className="category-distribution" aria-label="Распределение расходов">
          {groups.map((row, index) => { const category = data.categories.find(item => item.id === row.id); return <button type="button" key={row.id} aria-label={(category?.name || 'Категория') + ', ' + money(row.amount)}
            aria-pressed={row.id === focused} style={{ flex: row.amount, background: `var(--chart-slice-${index % 5})`, opacity: focused && focused !== row.id ? .37 : 1 }} onClick={() => setFocused(focused === row.id ? '' : row.id)}/> })}
        </div>}{(selected || groups.length > 0) && <p className="muted analytics-caption">{selected ? money(selected.amount) + ' · ' + usagePercent(selected.amount, summary.spent) + '%' : 'От самых затратных категорий'}</p>}
          {allGroups.map(row => {
            const category = data.categories.find(item => item.id === row.id)
            const actual = actualCategories.get(row.id) ?? 0
            return <button type="button" className="metric-row" key={row.id} onClick={() => setFocused(focused === row.id ? '' : row.id)} aria-pressed={focused === row.id}>
              <CategoryIcon emoji={category?.emoji}/><span>{category?.name}</span>
              <strong>{money(row.amount)}{actual !== row.amount && <small className="metric-actual">Факт {money(actual)}</small>}</strong>
            </button>
          })}
        </> : <Empty title="Расходов пока нет" text="Выберите другой период или добавьте расход."/>}
      </section>
      <section className="panel analysis-panel"><h2><UsersRound size={18}/> Расходы участников</h2>
        {data.members.map(member => {
          const amount = members.find(item => item.id === member.id)?.amount ?? 0
          const actual = actualMembers.get(member.id) ?? 0
          const percent = summary.spent ? usagePercent(amount, summary.spent) : 0
          return <div className="member-metric" key={member.id}><div className="metric-row"><Avatar member={member}/><span>{member.name}</span><strong>{money(amount)} <small>· {percent}%</small>
            {actual !== amount && <small className="metric-actual">Факт {money(actual)}</small>}</strong></div>
            <div className="progress"><span style={{ width: percent + '%', background: member.color } as CSSProperties}/></div></div>
        })}</section>
    </div>
  </>
}
