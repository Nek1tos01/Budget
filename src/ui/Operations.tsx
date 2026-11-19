import { useId, useRef, useState, type FormEvent } from 'react'
import { motion } from 'motion/react'
import { CalendarDays, Delete, FileText, ListFilter, Plus, Search, SquarePen, Trash2, UserRound } from 'lucide-react'
import { engine, isDay, labelDay, labelPeriod, money, moneyInput, parseMoney, toDay } from '../domain/engine'
import type { OperationType, Snapshot, Transaction } from '../domain/models'
import { repository } from '../data/repository'
import { Avatar, CategoryIcon, Empty, OperationRow, PeriodArrows, Segmented, Sheet, type Mutate } from './shared'

const types = [['expense', 'Расход'], ['income', 'Доход']] as const
const historyPeriods = [['all', 'Всё время'], ['week', 'Неделя'], ['month', 'Месяц']] as const

export function OperationEditor({ data, row, now, onClose, mutate }: {
  data: Snapshot; row?: Transaction; now: number; onClose: () => void; mutate: Mutate
}) {
  const active = data.categories.filter(item => !item.archived || item.id === row?.categoryId)
  const { timezone, lastCategory } = data.profile.settings
  const [type, setType] = useState<OperationType>(row?.type ?? 'expense')
  const [input, setInput] = useState(row ? moneyInput(row.amount) : '')
  const [categoryId, setCategory] = useState(row?.categoryId ?? active.find(item => item.id === lastCategory)?.id ?? active[0]?.id ?? '')
  const [expanded, setExpanded] = useState(false)
  const [memberId, setMember] = useState(row?.memberId ?? data.members[0].id)
  const [date, setDate] = useState(row?.date ?? toDay(now, timezone))
  const [source, setSource] = useState(row?.source ?? '')
  const [note, setNote] = useState(row?.note ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const locked = useRef(false)
  const formId = useId()

  function changeInput(value: string) {
    const cleaned = value.replaceAll('.', ',').replace(/[\s\u00a0\u202f]/g, '')
    if (/^-?\d{0,10}(,\d{0,2})?$/.test(cleaned) && !cleaned.startsWith('-')) setInput(cleaned)
  }
  function key(value: string) {
    if (value === 'delete') { setInput(input.slice(0, -1)); return }
    changeInput(value === ',' && input === '' ? '0,' : input + value)
  }
  async function submit(event: FormEvent, close: () => void) {
    event.preventDefault()
    if (locked.current) return
    const amount = parseMoney(input)
    if (!amount) { setError('Введите сумму больше нуля.'); return }
    if (type === 'expense' && !active.some(item => item.id === categoryId)) { setError('Выберите категорию расхода.'); return }
    if (type === 'income' && !source.trim()) { setError('Укажите источник дохода.'); return }
    if (!isDay(date)) { setError('Укажите корректную дату операции.'); return }
    setError('')
    locked.current = true
    setSaving(true)
    const operation: Transaction = {
      id: row?.id ?? crypto.randomUUID?.() ?? makeId(), type, amount, categoryId: type === 'expense' ? categoryId : null,
      memberId, date, createdAt: row ? row.createdAt : Date.now(), note: note.trim(), source: type === 'income' ? source.trim() : undefined,
    }
    const saved = await mutate(() => repository.putTransaction(operation, row), row ? 'Изменения сохранены' : type === 'expense' ? 'Расход добавлен' : 'Доход добавлен')
    if (saved) close()
    else { locked.current = false; setSaving(false) }
  }
  const visible = expanded ? active : active.filter((item, i) => i < 3 || item.id === categoryId).slice(0, 4)

  return <Sheet title={row ? 'Изменить операцию' : type === 'expense' ? 'Новый расход' : 'Новый доход'} onClose={onClose} className="operation-sheet"
    footer={<button form={formId} type="submit" className="primary full" disabled={saving}>{saving ? 'Сохраняем…' : row ? 'Сохранить' : 'Добавить'}</button>}>{close =>
    <form id={formId} onSubmit={event => void submit(event, close)} className="operation-form">
      <Segmented items={types} value={type} onChange={setType} label="Тип операции"/>
      <div className="amount-field">
        <input aria-label="Сумма" inputMode="none" autoComplete="off" placeholder="0" value={input} onChange={event => changeInput(event.target.value)}
          style={{ width: Math.max(1, (input || '0').length) + 'ch', fontSize: input.length > 8 ? 'clamp(25px, 8vw, 42px)' : undefined }}/>
        <span>₽</span>
      </div>
      {type === 'expense' ? <div className="quick-categories" role="group" aria-label="Категория">
        {visible.map(item => <button type="button" key={item.id} className={item.id === categoryId ? 'chosen' : ''} aria-pressed={item.id === categoryId} onClick={() => setCategory(item.id)}><CategoryIcon emoji={item.emoji}/><span>{item.name}</span></button>)}
        {active.length > 3 && <button type="button" className="quick-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Меньше' : 'Ещё'}</button>}
        {!active.length && <p className="muted">Создайте категорию в настройках.</p>}
      </div> : <label className="field"><span>Источник дохода</span><input value={source} maxLength={60} onChange={event => setSource(event.target.value)} placeholder="Например, зарплата"/></label>}
      <div className="form-fields inline-fields">
        <label className="field"><span><UserRound size={14}/> {type === 'expense' ? 'Кто оплатил' : 'Кто получил'}</span><select value={memberId} onChange={event => setMember(event.target.value)}>{data.members.map(member => <option value={member.id} key={member.id}>{member.name}</option>)}</select></label>
        <label className="field"><span>Дата</span><span className="date-control">
          <span className="date-value" aria-hidden="true">{isDay(date) ? labelDay(date, true) + ' ' + date.slice(0, 4) : 'Выбрать дату'}</span>
          <CalendarDays size={16} aria-hidden="true"/>
          <input aria-label="Дата" type="date" lang="ru" value={date} onChange={event => setDate(event.target.value)}
            onClick={event => { try { event.currentTarget.showPicker?.() } catch { /* Native input remains available. */ } }}/>
        </span></label>
      </div>
      <label className="note-field"><FileText size={17}/><input aria-label="Комментарий" value={note} onChange={event => setNote(event.target.value)} maxLength={300} placeholder="Комментарий (необязательно)"/></label>
      <div className="keypad" aria-label="Цифровая клавиатура">
        {['1','2','3','4','5','6','7','8','9',',','0','delete'].map(value => <motion.button type="button" whileTap={{ scale: .96 }} key={value} aria-label={value === 'delete' ? 'Стереть цифру' : 'Ввести ' + value} onClick={() => key(value)}>{value === 'delete' ? <Delete size={21}/> : value}</motion.button>)}
      </div>
      {error && <p role="alert" className="form-error">{error}</p>}
    </form>}
  </Sheet>
}

export function makeId() {
  const random = crypto.getRandomValues(new Uint32Array(4))
  return Array.from(random, value => value.toString(16).padStart(8, '0')).join('')
}

export function OperationDetail({ data, row, onClose, onEdit, mutate }: {
  data: Snapshot; row: Transaction; onClose: () => void; onEdit: () => void; mutate: Mutate
}) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const category = data.categories.find(item => item.id === row.categoryId)
  const member = data.members.find(item => item.id === row.memberId)
  return <Sheet title={row.type === 'expense' ? 'Расход' : 'Доход'} onClose={onClose}>{close =>
    <div className="detail-stack">
      <div className="detail-hero"><CategoryIcon emoji={category?.emoji} income={row.type === 'income'} size={25}/><strong className={row.type === 'income' ? 'positive' : ''}>{row.type === 'income' ? '+' : '−'}{money(row.amount)}</strong>
        <p>{category?.name || row.source}</p></div>
      <dl className="panel meta-list"><div><dt>Дата</dt><dd>{labelDay(row.date, true)} {row.date.slice(0, 4)}</dd></div><div><dt>Участник</dt><dd>{member && <><Avatar member={member}/> {member.name}</>}</dd></div>
        {row.note && <div><dt>Комментарий</dt><dd>{row.note}</dd></div>}</dl>
      {confirm ? <div className="confirm-box"><strong>Удалить эту операцию?</strong><p>Суммы и лимиты будут пересчитаны.</p><div className="actions">
        <button className="secondary" onClick={() => setConfirm(false)} disabled={busy}>Отмена</button><button className="danger-button" disabled={busy} onClick={async () => {
          setBusy(true)
          if (await mutate(() => repository.deleteTransaction(row.id), 'Операция удалена')) close()
          else setBusy(false)
        }}>Удалить операцию</button></div></div> : <div className="actions">
        <button className="secondary" onClick={() => setConfirm(true)}><Trash2 size={17}/> Удалить</button>
        <button className="primary" onClick={onEdit}><SquarePen size={17}/> Редактировать</button></div>}
    </div>}
  </Sheet>
}

export function History({ data, now, onOpen, add, categoryId, memberId }: {
  data: Snapshot; now: number; onOpen: (row: Transaction) => void; add?: () => void; categoryId?: string; memberId?: string
}) {
  const [query, setQuery] = useState('')
  const [filters, showFilters] = useState(false)
  const [type, setType] = useState<'all' | OperationType>('all')
  const [category, setCategory] = useState(categoryId ?? '')
  const [member, setMember] = useState(memberId ?? '')
  const [unit, setUnit] = useState<'all' | 'week' | 'month'>('all')
  const [offset, setOffset] = useState(0)
  const { timezone, weekStart } = data.profile.settings
  const today = toDay(now, timezone)
  const period = unit === 'all' ? null : engine.period(unit, now, timezone, weekStart, offset)
  const grouped = new Map<string, Transaction[]>()
  const term = query.trim().toLocaleLowerCase('ru')
  for (const row of data.transactions) {
    if (type !== 'all' && row.type !== type || category && row.categoryId !== category ||
        member && row.memberId !== member || period && !engine.includes(period, row.date)) continue
    const haystack = [row.note, row.source, data.categories.find(item => item.id === row.categoryId)?.name, data.members.find(item => item.id === row.memberId)?.name, money(row.amount)].join(' ').toLocaleLowerCase('ru')
    if (term && !haystack.includes(term)) continue
    const sameDay = grouped.get(row.date)
    if (sameDay) sameDay.push(row)
    else grouped.set(row.date, [row])
  }
  return <div className="history">
    <div className="search-toolbar">
      <label className="search"><Search size={19}/><input aria-label="Поиск операций" value={query} placeholder="Поиск операций" onChange={event => setQuery(event.target.value)}/></label>
      <button type="button" className={`icon-button filter-button ${filters ? 'active' : ''}`} aria-pressed={filters} aria-label="Фильтры операций" onClick={() => showFilters(!filters)}><ListFilter size={21}/></button>
    </div>
    {filters && <div className="panel history-filters">
      <Segmented items={historyPeriods} value={unit} onChange={value => { setUnit(value); setOffset(0) }} label="Период операций"/>
      {period && <PeriodArrows label={labelPeriod(period, today.slice(0, 4))} offset={offset} onChange={setOffset}/>}
      <div className="form-fields">
        <label className="field"><span>Тип</span><select value={type} onChange={event => setType(event.target.value as typeof type)}><option value="all">Все операции</option><option value="expense">Расходы</option><option value="income">Доходы</option></select></label>
        {!categoryId && <label className="field"><span>Категория</span><select value={category} onChange={event => setCategory(event.target.value)}><option value="">Все категории</option>{data.categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        {!memberId && <label className="field"><span>Участник</span><select value={member} onChange={event => setMember(event.target.value)}><option value="">Все участники</option>{data.members.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      </div>
    </div>}
    {grouped.size ? Array.from(grouped, ([day, rows]) => <section className="history-day" key={day}>
      <h2>{day === today ? 'Сегодня' : labelDay(day, true) + (day.slice(0,4) !== today.slice(0,4) ? ' ' + day.slice(0,4) : '')}</h2>
      <div className="panel grouped">{rows.map(row => <OperationRow key={row.id} row={row} category={data.categories.find(item => item.id === row.categoryId)} member={data.members.find(item => item.id === row.memberId)} onClick={() => onOpen(row)}/>)}</div>
    </section>) : <div className="panel"><Empty title="Операций не найдено" text="Здесь появятся расходы и доходы, соответствующие выбранным фильтрам.">
      {add && <button className="secondary" onClick={add}><Plus size={18}/> Добавить операцию</button>}
    </Empty></div>}
  </div>
}

export function HistoryPage({ data, now, onOpen, add }: { data: Snapshot; now: number; onOpen: (row: Transaction) => void; add: () => void }) {
  return <><header className="page-head"><div><h1>Операции</h1><p>История расходов и доходов</p></div>
    <button className="primary desktop-add" onClick={add}><Plus size={19}/> Добавить операцию</button></header>
    <div className="narrow"><History data={data} now={now} onOpen={onOpen} add={add}/></div></>
}


