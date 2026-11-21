import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, CircleAlert, Package, Plus, ReceiptText, Search, Settings2, Trash2 } from 'lucide-react'
import { isDay, labelDay, money, moneyInput, parseMoney } from '../domain/engine'
import type { BudgetScope, Category, Snapshot } from '../domain/models'
import { normalizeProductName, receiptItemBudgetScope, receiptRuleId, type Receipt, type ReceiptRule } from '../domain/receipts'
import { repository } from '../data/repository'
import { CategoryIcon, MonthlyOnlyBadge, type Mutate } from './shared'
import { makeId } from './Operations'

export type DraftItem = Omit<Receipt['items'][number], 'amount'> & { amountText: string; suggestion?: 'high' | 'medium' | 'low' }
export type ReceiptDraft = Omit<Receipt, 'items' | 'total' | 'budgetAmount' | 'roundingDelta'> & {
  items: DraftItem[]; totalText: string; roundingEnabled?: boolean
}

export async function ruleIdentity(rules: ReceiptRule[], match: ReceiptRule['match'], pattern: string) {
  const existing = rules.find(rule => rule.match === match && normalizeProductName(rule.pattern) === normalizeProductName(pattern))
  if (existing) return { id: existing.id, previous: existing }
  const computed = await receiptRuleId(match, pattern)
  return { id: rules.some(rule => rule.id === computed) ? makeId() : computed, previous: undefined }
}

export function ReceiptHeader({ store, date, time, amount, refund = false }: {
  store: string; date: string; time?: string; amount: number | null; refund?: boolean
}) {
  return <div className="receipt-header"><span className="receipt-symbol"><ReceiptText size={23}/></span>
    <div><strong>{store.trim() || (refund ? 'Возврат по чеку' : 'Кассовый чек')}</strong><small>{isDay(date) ? labelDay(date, true) + ' ' + date.slice(0, 4) : 'Дата не указана'}{time && ' · ' + time}</small></div>
    <strong className={refund ? 'positive' : undefined}>{amount === null ? '—' : (refund ? '+' : '') + money(amount)}</strong></div>
}

const scopeLabel: Record<BudgetScope, string> = { weekly_and_monthly: 'Неделя и месяц', monthly_only: 'Только месяц' }

export function ReceiptScopeBadge({ scope }: { scope: BudgetScope }) {
  return scope === 'monthly_only' ? <MonthlyOnlyBadge/> : <small>{scopeLabel[scope]}</small>
}

function ReceiptScopeSelect({ value, defaultScope, onChange }: {
  value?: BudgetScope; defaultScope: BudgetScope; onChange: (scope?: BudgetScope) => void
}) {
  return <label className="field"><span>Учёт в бюджете</span>
    <select value={value ?? ''} onChange={event => onChange((event.currentTarget.value || undefined) as BudgetScope | undefined)}>
      <option value="">По настройке чека · {scopeLabel[defaultScope]}</option>
      <option value="weekly_and_monthly">{scopeLabel.weekly_and_monthly}</option>
      <option value="monthly_only">{scopeLabel.monthly_only}</option>
    </select>
  </label>
}

export function ReceiptBulkScope({ count, defaultScope, onApply }: {
  count: number; defaultScope: BudgetScope; onApply: (scope?: BudgetScope) => void
}) {
  const [value, setValue] = useState<BudgetScope>()
  return <div className="receipt-stack">
    <p className="receipt-notice">Выбрано товаров: {count}</p>
    <ReceiptScopeSelect value={value} defaultScope={defaultScope} onChange={setValue}/>
    <button className="primary full" onClick={() => onApply(value)}>Применить учёт</button>
  </div>
}

export function ReceiptItemList({ items, categories, selected, select, edit, pick, add, mass, rules, defaultScope, massScope }: {
  items: DraftItem[]; categories: Category[]; selected: Set<string>; select: (id: string) => void; edit: (item: DraftItem) => void;
  pick: (item: DraftItem) => void; add: () => void; mass: () => void; rules: () => void; defaultScope?: BudgetScope; massScope: () => void
}) {
  return <div className="receipt-stack">
    <div className="receipt-section-heading"><h3>Товары <span>{items.length}</span></h3><button className="text-button" onClick={rules}><Settings2 size={17}/> Правила</button></div>
    {items.length ? <>
      <div className="receipt-mass"><label><input type="checkbox" checked={selected.size === items.length} onChange={() => select('all')}/> Выбрать все</label>
        {selected.size > 0 && <><button className="text-button" onClick={mass}>Назначить ({selected.size})</button>
          {defaultScope && <button className="text-button" onClick={massScope}>Учёт ({selected.size})</button>}</>}</div>
      <div className="panel receipt-items">{items.map(item => {
        const category = categories.find(value => value.id === item.categoryId)
        const amount = parseMoney(item.amountText)
        const subtype = item.suggestion === 'high' ? 'Предложено · высокая уверенность' : item.suggestion === 'medium' ? 'Предложено · средняя уверенность' : item.suggestion === 'low' ? 'Предложено · низкая уверенность' : null
        return <div key={item.id} className="receipt-item-row">
          <label className="receipt-item-check"><input aria-label={`Выбрать ${item.name || 'товар'}`} type="checkbox" checked={selected.has(item.id)} onChange={() => select(item.id)}/></label>
          <button className="receipt-item-name" onClick={() => edit(item)} aria-label={`Изменить ${item.name || 'товар'}`}>
            {category ? <CategoryIcon emoji={category.emoji} size={21}/> : <span className="category-icon"><Package size={18}/></span>}
            <span><strong>{item.name || 'Новый товар'}</strong><small>{item.quantity || '—'}{item.unit && ' ' + item.unit}{item.needsReview && <span className="receipt-review"><CircleAlert size={12}/> Проверить</span>}</small>
              {defaultScope && <ReceiptScopeBadge scope={receiptItemBudgetScope(item, defaultScope)}/>}</span>
          </button>
          <div className="receipt-item-end"><strong>{amount === null ? '—' : money(amount)}</strong>
            <button className="receipt-pill" aria-label={`Категория для ${item.name || 'товара'}`} onClick={() => pick(item)}>{category?.name || 'Без категории'}<ChevronDown size={14}/></button>
            {subtype && <small className="receipt-confidence">{subtype}</small>}</div>
        </div>
      })}</div>
    </> : <p className="receipt-notice">Товаров пока нет. Можно добавить позиции или учесть итог чека одной операцией.</p>}
    <button className="secondary full" onClick={add}><Plus size={18}/> Добавить товар</button>
  </div>
}

export function ReceiptItemEditor({ item, defaultScope, onSave, onDelete }: {
  item: DraftItem; defaultScope?: BudgetScope; onSave: (item: DraftItem) => void; onDelete?: () => void
}) {
  const [value, setValue] = useState(item)
  const [error, setError] = useState('')
  return <form className="receipt-stack" onSubmit={event => {
    event.preventDefault()
    const quantity = value.quantity.trim().replace(',', '.')
    const amount = parseMoney(value.amountText)
    if (!value.name.trim() || !/^\d{1,6}(\.\d{1,6})?$/.test(quantity) || !/[1-9]/.test(quantity) || amount === null) {
      setError('Проверьте название, количество и стоимость товара.'); return
    }
    onSave({ ...value, name: value.name.trim(), originalName: value.originalName || value.name.trim(), quantity, unit: value.unit?.trim() || undefined, amountText: moneyInput(amount), needsReview: false })
  }}>
    {value.originalName && value.originalName !== value.name && <p className="receipt-notice">На чеке: {value.originalName}</p>}
    <label className="field"><span>Название товара</span><input value={value.name} maxLength={200} onChange={event => setValue({ ...value, name: event.target.value })}/></label>
    <div className="inline-fields form-fields"><label className="field"><span>Количество</span><input inputMode="decimal" value={value.quantity} maxLength={16} onChange={event => setValue({ ...value, quantity: event.target.value })}/></label>
      <label className="field"><span>Единица измерения</span><input value={value.unit ?? ''} maxLength={16} onChange={event => setValue({ ...value, unit: event.target.value })}/></label></div>
    <label className="field"><span>Стоимость позиции, ₽</span><input inputMode="decimal" value={value.amountText} maxLength={16} onChange={event => setValue({ ...value, amountText: event.target.value })}/></label>
    {defaultScope && <ReceiptScopeSelect value={value.budgetScope} defaultScope={defaultScope} onChange={budgetScope => setValue({ ...value, budgetScope })}/>}
    {(value.discount !== undefined || value.unitPrice !== undefined) && <p className="field-hint">{[value.unitPrice === undefined ? null : `Цена за единицу ${money(value.unitPrice)}`, value.discount === undefined ? null : `Скидка ${money(value.discount)} учтена в сумме`].filter(Boolean).join(' · ')}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="primary full">Сохранить товар</button>
    {onDelete && <button type="button" className="text-button receipt-centered negative" onClick={onDelete}><Trash2 size={17}/> Удалить товар</button>}
  </form>
}

export function CategoryPicker({ categories, current, name, onChoose, onCreate, onRemember }: {
  categories: Category[]; current?: string | null; name?: string; onChoose: (id: string | null) => void; onCreate: () => void;
  onRemember?: (match: ReceiptRule['match'], pattern: string, id: string) => Promise<boolean>
}) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null | undefined>(current)
  const [match, setMatch] = useState<'' | ReceiptRule['match']>('')
  const [pattern, setPattern] = useState(name ?? '')
  const [busy, setBusy] = useState(false)
  const list = categories.filter(item => (!item.archived || item.id === current) && (item.name + ' ' + item.emoji).toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')))
  return <div className="receipt-stack">
    {name && <p className="receipt-notice">{name}</p>}
    <label className="search"><Search size={18}/><input aria-label="Поиск категорий" placeholder="Поиск категорий" value={query} onChange={event => setQuery(event.target.value)}/></label>
    <div className="panel receipt-category-list">
      {list.map(item => <button type="button" className="receipt-category-option" key={item.id} aria-pressed={picked === item.id} onClick={() => setPicked(item.id)}>
        <CategoryIcon emoji={item.emoji} size={20}/><span>{item.name}{item.archived && <small>В архиве</small>}</span>{picked === item.id && <Check size={19}/>}</button>)}
      {!query.trim() && <button className="receipt-category-option" aria-pressed={picked === null} onClick={() => setPicked(null)}><span className="category-icon">—</span><span>Без категории</span>{picked === null && <Check size={19}/>}</button>}
      {!list.length && query.trim() && <p className="receipt-notice">Категорий не найдено.</p>}
    </div>
    <button className="secondary full" onClick={onCreate}><Plus size={19}/> Создать категорию</button>
    {onRemember && picked && picked !== current && !categories.find(category => category.id === picked)?.archived && <div className="receipt-stack receipt-memory">
      <label className="field"><span>Запомнить выбор для похожих товаров?</span><select value={match} onChange={event => setMatch(event.target.value as typeof match)}>
        <option value="">Не запоминать</option><option value="exact">Для этого товара</option><option value="contains">По части названия</option></select></label>
      {match === 'contains' && <label className="field"><span>Часть названия</span><input value={pattern} maxLength={200} onChange={event => setPattern(event.target.value)}/></label>}
    </div>}
    <button className="primary full" disabled={picked === undefined || busy || (match === 'contains' && !pattern.trim())} onClick={async () => {
      if (picked === undefined) return
      if (onRemember && picked && picked !== current && match) {
        setBusy(true)
        const saved = await onRemember(match, match === 'exact' ? name ?? '' : pattern, picked)
        setBusy(false)
        if (!saved) return
      }
      onChoose(picked)
    }}>Применить</button>
  </div>
}

export function ReceiptRules({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const [editing, setEditing] = useState<ReceiptRule | null>(null)
  const [values, setValues] = useState<{ pattern: string; categoryId: string; match: ReceiptRule['match'] } | null>(null)
  const [remove, setRemove] = useState<ReceiptRule | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  function edit(rule?: ReceiptRule) {
    setRemove(null)
    setEditing(rule ?? null)
    setValues(rule ?? { pattern: '', categoryId: '', match: 'exact' })
    setError('')
  }
  if (values) return <form className="receipt-stack" onSubmit={async event => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    const pattern = values.pattern.trim()
    if (!/[\p{L}\p{N}]/u.test(pattern) || !values.categoryId) { setBusy(false); setError('Укажите название и выберите категорию.'); return }
    const { id, previous } = editing ? { id: editing.id, previous: editing } : await ruleIdentity(data.receiptRules ?? [], values.match, pattern)
    if (await mutate(scope => repository.putReceiptRule({ ...values, pattern, id }, scope, previous), 'Правило сохранено')) setValues(null)
    setBusy(false)
  }}>
    <label className="field"><span>Как искать</span><select value={values.match} onChange={event => setValues({ ...values, match: event.target.value as ReceiptRule['match'] })}><option value="exact">Точное название товара</option><option value="contains">Часть названия</option></select></label>
    <label className="field"><span>Название</span><input value={values.pattern} maxLength={200} onChange={event => setValues({ ...values, pattern: event.target.value })}/></label>
    <label className="field"><span>Категория</span><select value={values.categoryId} onChange={event => setValues({ ...values, categoryId: event.target.value })}>
      <option value="">Выберите категорию</option>{data.categories.filter(item => !item.archived || item.id === values.categoryId).map(item => <option value={item.id} key={item.id}>{item.emoji} {item.name}{item.archived ? ' (архив)' : ''}</option>)}</select></label>
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="actions"><button type="button" className="secondary" onClick={() => setValues(null)} disabled={busy}>Отмена</button><button className="primary" disabled={busy}>Сохранить правило</button></div>
  </form>
  return <div className="receipt-stack">
    {!data.receiptRules?.length && <p className="receipt-notice">Здесь появятся правила, которые вы создадите или запомните при выборе категории для товара.</p>}
    {!!data.receiptRules?.length && <div className="panel receipt-category-list">{data.receiptRules.map(rule => {
      const category = data.categories.find(item => item.id === rule.categoryId)
      return <div key={rule.id} className="receipt-rule-row"><button className="receipt-category-option" onClick={() => edit(rule)}><CategoryIcon emoji={category?.emoji} size={20}/>
        <span>{rule.pattern}<small>{rule.match === 'exact' ? 'Точное название' : 'Часть названия'} · {category?.name || 'Удалённая категория'}{category?.archived && ' (архив)'}</small></span><ChevronRight size={16}/></button>
        <button className="icon-button" aria-label={`Удалить правило ${rule.pattern}`} onClick={() => setRemove(rule)}><Trash2 size={17}/></button></div>
    })}</div>}
    {remove && <div className="confirm-box"><strong>Удалить правило «{remove.pattern}»?</strong><div className="actions"><button className="secondary" disabled={busy} onClick={() => setRemove(null)}>Отмена</button>
      <button className="danger-button" disabled={busy} onClick={async () => { setBusy(true); if (await mutate(scope => repository.deleteReceiptRule(remove.id, scope, remove), 'Правило удалено')) setRemove(null); setBusy(false) }}>Удалить правило</button></div></div>}
    <button className="secondary full" onClick={() => edit()}><Plus size={18}/> Новое правило</button>
  </div>
}
