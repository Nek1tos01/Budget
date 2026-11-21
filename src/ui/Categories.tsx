import { useId, useRef, useState, type FormEvent } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Archive, ChevronLeft, Plus, RotateCcw, SquarePen } from 'lucide-react'
import { DEFAULT_CATEGORY_EMOJI, normalizeCategoryEmoji } from '../domain/emoji'
import { engine, moneyInput, parseMoney } from '../domain/engine'
import { effectiveCategoryLimit } from '../domain/limit-transfers'
import type { Category, PeriodKind, Snapshot, Transaction } from '../domain/models'
import { repository } from '../data/repository'
import { CategoryRow, periodItems, useBudgetPeriod } from './BudgetPage'
import { History, makeId } from './Operations'
import { LimitTransfers } from './LimitTransfers'
import { CategoryIcon, colors, Empty, Segmented, Sheet, Toggle, screenTransition, type Mutate } from './shared'

export function Categories({ data, now, open, edit, mutate }: {
  data: Snapshot; now: number; open: (item: Category) => void; edit: () => void; mutate: Mutate
}) {
  const [kind, setKind] = useState<PeriodKind>('week')
  const { period } = useBudgetPeriod(data, now, kind)
  const list = (archived: boolean) => data.categories.filter(item => item.archived === archived).map(category => <CategoryRow key={category.id}
    category={category} summary={engine.summary(data.transactions.filter(row => row.categoryId === category.id), period, effectiveCategoryLimit(category, period, data.limitTransfers))} onClick={() => open(category)}/>)
  const active = list(false)
  const archived = list(true)
  return <><header className="page-head"><div><h1>Категории</h1><p>Лимиты по видам расходов</p></div><motion.button className="secondary icon-button add-category" aria-label="Новая категория" title="Новая категория" onClick={edit} whileTap={{ scale: .91 }}><Plus size={21}/></motion.button></header>
    <div className="narrow detail-stack"><Segmented items={periodItems} value={kind} onChange={setKind} label="Лимиты категорий"/>
      <div className="panel grouped">{active.length ? active : <Empty title="Нет активных категорий" text="Создайте категорию или восстановите её из архива."/>}</div>
      <LimitTransfers data={data} period={period} mutate={mutate}/>
      {archived.length > 0 && <section><div className="section-head"><h2>Архив</h2></div><div className="panel grouped">{archived}</div></section>}
    </div></>
}

export function CategoryDetail({ data, category, now, open, edit, back, mutate }: {
  data: Snapshot; category: Category; now: number; open: (row: Transaction) => void; edit: () => void; back: () => void; mutate: Mutate
}) {
  const [kind, setKind] = useState<PeriodKind>('week')
  const reduceMotion = useReducedMotion()
  const [confirm, setConfirm] = useState(false)
  const { period } = useBudgetPeriod(data, now, kind)
  const summary = engine.summary(data.transactions.filter(row => row.categoryId === category.id), period, effectiveCategoryLimit(category, period, data.limitTransfers))
  return <><button className="text-button back-button" onClick={back}><ChevronLeft size={19}/> Категории</button>
    <motion.header className="page-head category-detail-head" initial={reduceMotion ? false : { opacity: .7 }} animate={{ opacity: 1 }} transition={screenTransition}><div className="category-page-title"><CategoryIcon emoji={category.emoji} size={28}/><div><h1>{category.name}</h1><p>{category.archived ? 'В архиве' : 'История и лимиты'}</p></div></div>
      <button className="secondary header-action" aria-label="Редактировать" onClick={edit}><SquarePen size={18}/> <span>Редактировать</span></button></motion.header>
    <div className="narrow detail-stack"><Segmented items={periodItems} value={kind} onChange={setKind} label="Лимит категории"/>
      <div className="panel"><CategoryRow category={category} summary={summary} onClick={edit}/></div>
      {confirm ? <div className="panel confirm-box"><strong>Архивировать категорию?</strong><p>Связанные операции останутся в истории.</p><div className="actions"><button className="secondary" onClick={() => setConfirm(false)}>Отмена</button>
        <button className="danger-button" onClick={async () => {
          if (await mutate(scope => repository.putCategory({ ...category, archived: true }, category, scope), 'Категория в архиве')) setConfirm(false)
        }}>Архивировать</button></div></div> : <button className="secondary self-start" onClick={() => {
          if (category.archived) void mutate(scope => repository.putCategory({ ...category, archived: false }, category, scope), 'Категория восстановлена')
          else setConfirm(true)
        }}>{category.archived ? <RotateCcw size={17}/> : <Archive size={17}/>} {category.archived ? 'Восстановить' : 'В архив'}</button>}
      <div className="section-head"><h2>Расходы категории</h2></div>
      <History data={data} now={now} onOpen={open} categoryId={category.id}/>
    </div></>
}

export function CategoryEditor({ category, onClose, mutate, onSaved }: {
  category?: Category; onClose: () => void; mutate: Mutate; onSaved?: () => void
}) {
  const original = useRef(category).current
  const [name, setName] = useState(category?.name ?? '')
  const [emojiInput, setEmojiInput] = useState(category?.emoji ?? '')
  const [emojiTouched, setEmojiTouched] = useState(false)
  const emojiHintId = useId()
  const emojiField = useRef<HTMLInputElement>(null)
  const emoji = normalizeCategoryEmoji(emojiInput)
  const emojiInvalid = emojiTouched && emoji === null
  const [color, setColor] = useState(category?.color ?? colors[0])
  const [week, setWeek] = useState(moneyInput(category?.limits.week ?? 0))
  const [month, setMonth] = useState(moneyInput(category?.limits.month ?? 0))
  const [monthlyOnly, setMonthlyOnly] = useState(category?.defaultBudgetScope === 'monthly_only')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent, close: () => void) {
    event.preventDefault()
    setError('')
    setEmojiTouched(true)
    if (emoji === null) {
      emojiField.current?.focus()
      return
    }
    const a = parseMoney(week)
    const b = parseMoney(month)
    if (!name.trim() || a === null || b === null) { setError('Проверьте название и суммы лимитов.'); return }
    setBusy(true)
    const value: Category = { id: category?.id ?? makeId(), name: name.trim(), emoji, color, limits: { week: a, month: b },
      archived: category?.archived ?? false, defaultBudgetScope: monthlyOnly ? 'monthly_only' : undefined }
    if (await mutate(scope => repository.putCategory(value, original, scope), 'Категория сохранена')) { onSaved?.(); close() }
    else setBusy(false)
  }
  return <Sheet title={category ? 'Изменить категорию' : 'Новая категория'} onClose={onClose}>{close =>
    <form className="detail-stack" onSubmit={event => void submit(event, close)}>
      <label className="field"><span>Название</span><input value={name} onChange={event => setName(event.target.value)} maxLength={60} placeholder="Например, Здоровье"/></label>
      <div className="emoji-editor">
        <div className="emoji-preview" aria-hidden="true">
          {emoji === null ? <span className="emoji-preview-empty">—</span> : <CategoryIcon emoji={emoji} size={44}/>}
        </div>
        <div className="emoji-field">
          <label className="field"><span>Эмодзи</span>
            <input ref={emojiField} type="text" inputMode="text" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
              value={emojiInput} placeholder={DEFAULT_CATEGORY_EMOJI}
              aria-invalid={emojiInvalid || undefined} aria-describedby={emojiHintId}
              onChange={event => setEmojiInput(event.target.value)} onBlur={() => setEmojiTouched(true)}/>
          </label>
          <p id={emojiHintId} className={emojiInvalid ? 'form-error' : 'field-hint'} aria-live="polite" aria-atomic="true">
            {emojiInvalid ? 'Введите один эмодзи, например 👩‍💻.' : 'Выберите один эмодзи на клавиатуре.'}
          </p>
        </div>
      </div>
      <div className="choice-group"><span>Цвет</span><div className="color-choices">{colors.map((key, index) => <button type="button" key={key}
        aria-label={['Лавандовый','Оранжевый','Голубой','Розовый','Мятный','Золотой','Коралловый','Зелёный'][index]} aria-pressed={key === color} onClick={() => setColor(key)} style={{ '--swatch': key } as React.CSSProperties}/>)}</div></div>
      <div className="form-fields inline-fields"><label className="field"><span>На неделю, ₽</span><input inputMode="decimal" value={week} maxLength={15} onChange={event => setWeek(event.target.value)}/></label>
        <label className="field"><span>На месяц, ₽</span><input inputMode="decimal" value={month} maxLength={15} onChange={event => setMonth(event.target.value)}/></label></div>
      <Toggle label="По умолчанию только в месячном бюджете" description="Для новых расходов в этой категории. Выбор можно изменить при добавлении расхода."
        checked={monthlyOnly} onChange={setMonthlyOnly}/>
      {error && <p className="form-error" role="alert">{error}</p>}<button className="primary full" disabled={busy}>Сохранить</button>
    </form>}
  </Sheet>
}
