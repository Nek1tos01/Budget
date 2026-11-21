import { useState, type FormEvent } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import { repository } from '../data/repository'
import { engine, labelPeriod, money, moneyInput, parseMoney } from '../domain/engine'
import { assertLimitTransferChange, effectiveCategoryLimit, sameLimitPeriod, type LimitTransfer } from '../domain/limit-transfers'
import type { BudgetPeriod, Snapshot } from '../domain/models'
import { makeId } from './Operations'
import { Sheet, type Mutate } from './shared'

export function LimitTransfers({ data, period, mutate }: { data: Snapshot; period: BudgetPeriod; mutate: Mutate }) {
  const [editor, setEditor] = useState<'new' | LimitTransfer | null>(null)
  const [cancel, setCancel] = useState<LimitTransfer | null>(null)
  const [busy, setBusy] = useState(false)
  const rows = (data.limitTransfers ?? []).filter(row => row.kind === period.kind)
    .sort((a, b) => b.start.localeCompare(a.start) || b.createdAt - a.createdAt || b.id.localeCompare(a.id))
  const categoryName = (id: string) => data.categories.find(row => row.id === id)?.name ?? 'Категория'
  return <section className="detail-stack">
    <div className="section-head"><h2>Переносы лимитов</h2></div>
    <button className="secondary self-start" disabled={data.categories.filter(category => !category.archived).length < 2}
      onClick={() => setEditor('new')}><ArrowLeftRight size={18}/> Перенести лимит</button>
    {!rows.length && <p className="muted">В истории пока нет переносов.</p>}
    {rows.map(row => {
      const editable = !row.cancelled && sameLimitPeriod(row, period)
      return <div key={row.id} className="panel padded detail-stack">
        <div><strong>{categoryName(row.fromCategoryId)} → {categoryName(row.toCategoryId)} · {money(row.amount)}</strong>
          <p className="muted">{labelPeriod(row, '')}{row.cancelled ? ' · Отменён' : ''}</p></div>
        {editable && <div className="actions">
          <button className="secondary" onClick={() => setEditor(row)}>Изменить</button>
          <button className="secondary" onClick={() => setCancel(row)}>Отменить перенос</button>
        </div>}
      </div>
    })}
    {editor && <TransferEditor data={data} period={period} original={editor === 'new' ? undefined : editor} mutate={mutate} close={() => setEditor(null)}/>}
    {cancel && <Sheet title="Отменить перенос лимита?" onClose={() => setCancel(null)} dismissible={!busy}>{close =>
      <div className="detail-stack"><p>Сумма {money(cancel.amount)} вернётся в категорию «{categoryName(cancel.fromCategoryId)}».</p>
        <div className="actions"><button className="secondary" disabled={busy} onClick={close}>Назад</button>
          <button className="danger-button" disabled={busy} onClick={async () => {
            setBusy(true)
            const saved = await mutate(scope => repository.putLimitTransfer({ ...cancel, cancelled: true }, scope, cancel), 'Перенос отменён')
            setBusy(false)
            if (saved) setCancel(null)
          }}>Подтвердить отмену</button></div>
      </div>}
    </Sheet>}
  </section>
}

function TransferEditor({ data, period, original, mutate, close }: {
  data: Snapshot; period: BudgetPeriod; original?: LimitTransfer; mutate: Mutate; close: () => void
}) {
  const [from, setFrom] = useState(original?.fromCategoryId ?? '')
  const [to, setTo] = useState(original?.toCategoryId ?? '')
  const [amount, setAmount] = useState(original ? moneyInput(original.amount) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const categories = data.categories.filter(row => !row.archived || row.id === original?.fromCategoryId || row.id === original?.toCategoryId)
  const source = categories.find(row => row.id === from)
  const available = source ? Math.max(0, engine.summary(data.transactions.filter(row => row.categoryId === from), period,
    effectiveCategoryLimit(source, period, data.limitTransfers)).remaining + (original?.amount ?? 0)) : null

  async function save(event: FormEvent) {
    event.preventDefault()
    const cents = parseMoney(amount)
    if (cents === null || cents <= 0 || !from || !to || from === to) {
      setError('Выберите две разные категории и введите сумму больше нуля.')
      return
    }
    const next = original ? { ...original, amount: cents } : {
      ...period, id: makeId(), amount: cents, cancelled: false, createdAt: Date.now(), fromCategoryId: from, toCategoryId: to,
    }
    try {
      assertLimitTransferChange(next, original, data.categories, data.limitTransfers ?? [], data.transactions)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Проверьте сумму переноса.')
      return
    }
    setError('')
    setBusy(true)
    if (await mutate(scope => repository.putLimitTransfer(next, scope, original), original ? 'Перенос изменён' : 'Лимит перенесён')) close()
    else setBusy(false)
  }

  return <Sheet title={original ? 'Изменить перенос' : 'Перенести лимит'} onClose={close} dismissible={!busy}>
    <form className="detail-stack" onSubmit={event => void save(event)}>
      <p>{period.kind === 'week' ? 'Текущая неделя' : 'Текущий месяц'} · {labelPeriod(period, period.start.slice(0, 4))}</p>
      <label className="field"><span>Из категории</span><select value={from} disabled={!!original || busy} onChange={event => setFrom(event.target.value)}>
        <option value="">Выберите категорию</option>{categories.filter(row => row.id !== to).map(row => <option value={row.id} key={row.id}>{row.name}</option>)}</select></label>
      <label className="field"><span>В категорию</span><select value={to} disabled={!!original || busy} onChange={event => setTo(event.target.value)}>
        <option value="">Выберите категорию</option>{categories.filter(row => row.id !== from).map(row => <option value={row.id} key={row.id}>{row.name}</option>)}</select></label>
      <label className="field"><span>Сумма переноса, ₽</span><input inputMode="decimal" value={amount} maxLength={15} onChange={event => setAmount(event.target.value)}/></label>
      {available !== null && <p className="muted">Доступно для переноса · {money(available)}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary full" disabled={busy}>Сохранить перенос</button>
    </form>
  </Sheet>
}
