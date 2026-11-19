import { useState, type CSSProperties } from 'react'
import { Activity, ChartNoAxesColumnIncreasing, UsersRound } from 'lucide-react'
import type { PeriodKind, Snapshot } from '../domain/models'
import { engine, labelPeriod, money } from '../domain/engine'
import { periodItems, useBudgetPeriod } from './BudgetPage'
import { Avatar, CategoryIcon, ChangeBadge, Empty, PeriodArrows, Segmented } from './shared'
import { Trend } from './charts'

export function Analytics({ data, now }: { data: Snapshot; now: number }) {
  const [kind, setKind] = useState<PeriodKind>('week')
  const [offset, setOffset] = useState(0)
  const [focused, setFocused] = useState('')
  const { today, period, summary, get } = useBudgetPeriod(data, now, kind, offset)
  const year = today.slice(0, 4)
  const previous = engine.summary(data.transactions, get(kind, offset - 1), 0).spent
  const groups = engine.breakdown(data.transactions, period, 'categoryId')
  const members = engine.breakdown(data.transactions, period, 'memberId')
  const points = Array.from({ length: 5 }, (_, i) => {
    const index = offset + i - 4
    const point = get(kind, index)
    return { label: index === 0 ? 'Сейчас' : labelPeriod(point, year, true), amount: engine.summary(data.transactions, point, 0).spent }
  })
  const selected = groups.find(row => row.id === focused)
  return <><header className="page-head"><div><h1>Аналитика</h1><p>Куда уходят деньги</p></div></header>
    <div className="period-toolbar"><Segmented items={periodItems} value={kind} onChange={value => { setKind(value); setOffset(0); setFocused('') }} label="Период аналитики"/>
      <PeriodArrows label={labelPeriod(period, year)} offset={offset} onChange={setOffset}/></div>
    <div className="analysis-grid">
      <section className="panel trend-panel analytics-trend"><div className="chart-head"><div><h2><Activity size={18}/> Динамика расходов</h2><strong className="analytics-value">{money(summary.spent)}</strong><p>Прошлый период · {money(previous)}</p></div><ChangeBadge current={summary.spent} previous={previous}/></div>
        <Trend key={kind + offset} values={points} label="Динамика расходов за пять периодов"/>
      </section>
      <section className="panel analysis-panel"><h2><ChartNoAxesColumnIncreasing size={18}/> Расходы по категориям</h2>
        {groups.length ? <><div className="category-distribution" aria-label="Распределение расходов">
          {groups.map(row => { const category = data.categories.find(item => item.id === row.id); return <button type="button" key={row.id} aria-label={(category?.name || 'Категория') + ', ' + money(row.amount)}
            aria-pressed={row.id === focused} style={{ flex: row.amount, background: category?.color, opacity: focused && focused !== row.id ? .37 : 1 }} onClick={() => setFocused(focused === row.id ? '' : row.id)}/> })}
        </div><p className="muted analytics-caption">{selected ? money(selected.amount) + ' · ' + Math.round(selected.amount / summary.spent * 100) + '%' : 'От самых затратных категорий'}</p>
          {groups.map(row => { const category = data.categories.find(item => item.id === row.id); return <button type="button" className="metric-row" key={row.id} onClick={() => setFocused(focused === row.id ? '' : row.id)} aria-pressed={focused === row.id}><CategoryIcon emoji={category?.emoji}/><span>{category?.name}</span><strong>{money(row.amount)}</strong></button> })}
        </> : <Empty title="Расходов пока нет" text="Выберите другой период или добавьте расход."/>}
      </section>
      <section className="panel analysis-panel"><h2><UsersRound size={18}/> Расходы участников</h2>
        {data.members.map(member => {
          const amount = members.find(item => item.id === member.id)?.amount ?? 0
          const percent = summary.spent ? Math.round(amount / summary.spent * 100) : 0
          return <div className="member-metric" key={member.id}><div className="metric-row"><Avatar member={member}/><span>{member.name}</span><strong>{money(amount)} <small>· {percent}%</small></strong></div>
            <div className="progress"><span style={{ width: percent + '%', background: member.color } as CSSProperties}/></div></div>
        })}</section>
    </div>
  </>
}
