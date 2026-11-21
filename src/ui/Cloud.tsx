import { useId, useRef, useState, type FormEvent } from 'react'
import { Cloud, CloudAlert, CloudCheck, CloudOff, CloudSync, Copy, Link2, RefreshCw, ShieldCheck } from 'lucide-react'
import { money, parseMoney, deviceZone } from '../domain/engine'
import type { Snapshot } from '../domain/models'
import { backupSnapshot } from '../data/repository'
import {
  authenticate, cancelRestore, confirmRecovery, disconnect, invite, readConnection, resolveConflict, restoreCloud, revoke, syncCloud, type Connection,
} from '../cloud/client'
import { fromCents, type CloudRecord, type Invitation, type Mutation, type Session } from '../cloud/protocol'
import { Sheet } from './shared'

export type CloudAction = 'menu' | 'households' | 'join' | 'recover'
export const initialInvitation = (() => {
  if (typeof window === 'undefined') return ''
  const hash = new URLSearchParams(location.hash.slice(1))
  const code = hash.get('invite')
  if (!code) return ''
  history.replaceState(null, '', location.pathname + location.search)
  return code
})()

function cloudStatus(connection: Connection) {
  if (connection.authRequired) return { state: 'error', label: 'Восстановите доступ', Icon: CloudAlert }
  if (connection.mode === 'staging' || connection.restore) return { state: 'syncing', label: 'Перенос данных', Icon: CloudSync }
  if (connection.conflict) return { state: 'error', label: 'Нужно решить конфликт', Icon: CloudAlert }
  if (connection.offline) return { state: 'offline', label: connection.queue.length ? 'Нет сети · в очереди ' + connection.queue.length : 'Нет сети', Icon: CloudOff }
  if (connection.error) return { state: 'error', label: 'Ошибка синхронизации', Icon: CloudAlert }
  if (connection.queue.length) return { state: 'queued', label: 'В очереди: ' + connection.queue.length, Icon: Cloud }
  if (!connection.cursor) return { state: 'syncing', label: 'Синхронизация…', Icon: CloudSync }
  return { state: 'synced', label: 'Синхронизировано', Icon: CloudCheck }
}

function exportSnapshot(snapshot: Snapshot) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backupSnapshot(snapshot))], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'budget-backup.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function describe(record: CloudRecord | Mutation | null) {
  if (!record?.value) return 'Запись удалена или отсутствует'
  const row = record.value
  switch (record.kind) {
    case 'transaction': {
      const value = record.value
      return [money(fromCents(value.amount)), value.date, value.note || value.source].filter(Boolean).join(' · ')
    }
    case 'category': return record.value.emoji + ' ' + record.value.name + ' · ' + money(fromCents(record.value.limits.week)) + ' / нед. · ' + money(fromCents(record.value.limits.month)) + ' / мес.'
    case 'profile': return record.value.household.name + ' · ' + money(fromCents(record.value.budget.week)) + ' / нед. · ' + money(fromCents(record.value.budget.month)) + ' / мес. · ' + record.value.settings.timezone + ' · день ' + record.value.settings.weekStart
    case 'member': return 'name' in row ? row.name : ''
    case 'receipt': return [money(record.value.total), record.value.date, record.value.store].filter(Boolean).join(' · ')
    case 'receiptRule': return record.value.pattern
    case 'limitTransfer': return money(record.value.amount) + ' · ' + record.value.start + (record.value.cancelled ? ' · Отменён' : '')
  }
}

function tokenFrom(input: string) {
  const clean = input.trim()
  if (!clean.includes('#')) return clean
  return new URLSearchParams(clean.slice(clean.indexOf('#') + 1)).get('invite') ?? ''
}

export function CloudPanel({ action, token, connection, data, close, onOpenReceipt }: {
  action: CloudAction; token?: string; connection?: Connection; data?: Snapshot | null; close: () => void
  onOpenReceipt?: (id: string) => void
}) {
  const [view, setView] = useState<CloudAction>(action)
  const [name, setName] = useState('')
  const [budgetName, setBudgetName] = useState(data?.profile.household.name ?? 'Семейный бюджет')
  const [code, setCode] = useState(token ?? '')
  const [recovery, setRecovery] = useState('')
  const [recoverySession, setRecoverySession] = useState<Session | null>(null)
  const [invitation, setInvitation] = useState<Invitation | null>(null)
  const [migration, setMigration] = useState(false)
  const [confirmation, setConfirmation] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [departing, setDeparting] = useState(false)
  const [cancelImport, setCancelImport] = useState(false)
  const [revokeId, setRevokeId] = useState('')
  const [editAmount, setEditAmount] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const transferId = useId()
  const sending = useRef(false)

  async function perform(work: () => Promise<unknown>) {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try { await work() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Действие не удалось. Попробуйте ещё раз.') }
    finally { sending.current = false; setBusy(false) }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setMessage('Скопировано')
    } catch {
      setMessage('Выделите текст и скопируйте его вручную.')
    }
  }

  async function transfer(expected: Session) {
    if (!data || !confirmation) return
    await syncCloud(true)
    const current = await readConnection()
    if (!current || current.mode !== 'staging' || current.session.householdId !== expected.householdId || current.session.memberId !== expected.memberId) {
      throw new Error('Подготовленный общий бюджет изменился. Подтвердите отправку заново.')
    }
    await restoreCloud(data, current)
    setMigration(false)
    setConfirmation(false)
    setMessage('Бюджет перенесён.')
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (view === 'menu') return
    void perform(async () => {
      if (migration && !confirmation) throw new Error('Подтвердите отправку локальных данных.')
      const action = view
      const body = action === 'households' ? { name: name.trim(), budgetName: budgetName.trim(), timezone: data?.profile.settings.timezone ?? deviceZone() }
        : action === 'join' ? { name: name.trim(), token: tokenFrom(code) } : { code: code.trim() }
      const result = await authenticate(action, body, data?.profile.settings.theme ?? 'dark', migration)
      setRecovery(result.recoveryCode)
      setRecoverySession(action === 'recover' ? result.session : null)
      setView('menu')
      setCode('')
      if (migration) await transfer(result.session)
    })
  }

  const role = connection?.session.role
  const inviteUrl = invitation ? location.origin + location.pathname + '#invite=' + encodeURIComponent(invitation.token) : ''
  const conflict = connection?.conflict
  const activeMembers = data?.members.filter(member => member.active !== false) ?? []
  const pendingCount = (connection?.queue.length ?? 0) + (connection?.restore ? 1 : 0)
  const showTransfer = migration || (view === 'menu' && connection?.mode === 'staging' && !connection.restore)

  return <Sheet title="Общий бюджет" onClose={close} dismissible={!busy && !recovery}>
    <div className="detail-stack">
      {recovery && <section className="panel padded detail-stack cloud-recovery">
        <h2><ShieldCheck size={19}/> Код восстановления</h2>
        <p>{recoverySession ? 'Сохраните новый код и нажмите «Готово», чтобы он вступил в силу.' : 'Сохраните код в надёжном месте. Он потребуется для восстановления доступа.'}</p>
        <output>{recovery}</output>
        <div className="actions"><button type="button" className="secondary" onClick={() => void copy(recovery)}><Copy size={16}/> Скопировать</button>
          <button type="button" className="primary" disabled={busy} onClick={() => void perform(async () => {
            if (recoverySession) await confirmRecovery(recoverySession, recovery)
            setRecovery('')
            setRecoverySession(null)
          })}>Готово</button></div>
        {recoverySession && <button type="button" className="text-button" disabled={busy} onClick={() => {
          setRecovery('')
          setRecoverySession(null)
        }}>Отложить подтверждение</button>}
      </section>}
      {showTransfer && data && <section className="panel padded detail-stack">
        <h2>Перенос локальных данных</h2>
        <p>Операций: {data.transactions.filter(row => !row.receiptId).length}. Чеков: {data.receipts?.length ?? 0}. Переносятся также категории, лимиты, участники и настройки финансовой недели.</p>
        <p className="muted">Данные будут отправлены в общий бюджет после вашего подтверждения.</p>
        <button type="button" className="secondary self-start" onClick={() => exportSnapshot(data)}>Сохранить резервную копию</button>
        <label htmlFor={transferId} className="cloud-check"><input type="checkbox" id={transferId} checked={confirmation} onChange={event => setConfirmation(event.target.checked)}/> Подтверждаю отправку этих данных</label>
        {view === 'menu' && connection?.mode === 'staging' && <button type="button" className="primary" disabled={busy || !confirmation} onClick={() => void perform(() => transfer(connection.session))}>Перенести данные</button>}
      </section>}
      {view !== 'menu' ? <form className="detail-stack" onSubmit={submit}>
        <h2>{view === 'households' ? 'Создать общий бюджет' : view === 'join' ? 'Присоединиться к бюджету' : 'Восстановить доступ'}</h2>
        {view !== 'recover' && <label className="field"><span>Имя участника</span><input value={name} onChange={event => setName(event.target.value)} required maxLength={60} autoComplete="nickname"/></label>}
        {view === 'households' && <label className="field"><span>Название бюджета</span><input value={budgetName} onChange={event => setBudgetName(event.target.value)} required maxLength={60}/></label>}
        {view !== 'households' && <label className="field"><span>{view === 'join' ? 'Ссылка или код приглашения' : 'Код восстановления'}</span><input value={code} onChange={event => setCode(event.target.value)} required maxLength={512} autoCapitalize="none" autoComplete="off" spellCheck={false}/></label>}
        <div className="actions"><button type="button" className="secondary" onClick={() => { setView('menu'); setMigration(false); setError('') }}>Назад</button>
          <button className="primary" disabled={busy || (migration && !confirmation)}>{view === 'households' ? 'Создать' : view === 'join' ? 'Присоединиться' : 'Восстановить'}</button></div>
      </form> : !connection ? <div className="detail-stack">
        <button className="primary full" onClick={() => setView('households')}>Создать общий бюджет</button>
        <button className="secondary full" onClick={() => setView('join')}>Присоединиться</button>
        {data && <button className="secondary full" onClick={() => { setMigration(true); setView('households') }}>Перенести текущий бюджет в общий</button>}
        <button className="text-button" onClick={() => setView('recover')}>Восстановить доступ</button>
      </div> : <>
        <div className="spread"><strong>{cloudStatus(connection).label}</strong><button className="icon-button" type="button" aria-label="Синхронизировать" disabled={busy || connection.authRequired} onClick={() => void perform(() => syncCloud(true))}><RefreshCw size={18}/></button></div>
        {connection.error && <p className="muted">{connection.error}</p>}
        {connection.authRequired && <button className="primary full" onClick={() => setView('recover')}>Восстановить доступ</button>}
        {connection.restore && <div className="confirm-box">
          <strong>Сохранён перенос данных</strong>
          <p>Общий бюджет переключится после подтверждения сервера.</p>
          {connection.restore.phase !== 'sending' && (cancelImport ? <button className="danger-button" onClick={() => void perform(async () => { await cancelRestore(connection.session); setCancelImport(false) })}>Подтвердить отмену переноса</button>
            : <button className="secondary" onClick={() => setCancelImport(true)}>Отменить подготовленный перенос</button>)}
        </div>}
        {conflict && <section className="panel padded detail-stack">
          <h2>Конфликт изменений</h2><p className="muted">{conflict.message}</p>
          <dl className="meta-list"><div><dt>На сервере</dt><dd>{describe(conflict.record)}</dd></div>
            <div><dt>На этом устройстве</dt><dd>{describe(conflict.mutation)}</dd></div></dl>
          {conflict.mutation.kind === 'transaction' && conflict.mutation.value && <label className="field"><span>Другая сумма, ₽</span><input inputMode="decimal" value={editAmount} onChange={event => setEditAmount(event.target.value)} /></label>}
          <div className="actions">
            <button className="secondary" disabled={busy} onClick={() => void perform(async () => {
              await resolveConflict(connection.session, 'server')
              if (conflict.code === 'receipt_duplicate' && conflict.record?.kind === 'receipt' && onOpenReceipt) {
                close()
                onOpenReceipt(conflict.record.key)
              }
            })}>{conflict.code === 'receipt_duplicate' ? 'Открыть существующий чек' : 'Принять серверную'}</button>
            {conflict.code !== 'receipt_duplicate' && <button className="primary" disabled={busy} onClick={() => void perform(async () => {
              const value = editAmount.trim() ? parseMoney(editAmount) : undefined
              if (value === null || value === 0) throw new Error('Введите корректную сумму.')
              await resolveConflict(connection.session, 'local', value)
            })}>{editAmount.trim() ? 'Отправить новую сумму' : 'Отправить мою версию'}</button>}
          </div>
        </section>}
        {role === 'owner' && !connection.authRequired && connection.mode === 'active' && activeMembers.length < 2 &&
          <button className="primary full" disabled={busy} onClick={() => void perform(async () => { setInvitation(await invite(connection.session)) })}><Link2 size={18}/> Пригласить</button>}
        {invitation && <section className="panel padded detail-stack">
          <label className="field"><span>Ссылка-приглашение</span><input value={inviteUrl} readOnly onFocus={event => event.currentTarget.select()}/></label>
          <p>Ссылка одноразовая, действует 15 минут.</p>
          <div className="actions"><button className="secondary" type="button" onClick={() => void copy(inviteUrl)}><Copy size={16}/> Скопировать ссылку</button>
            {typeof navigator.share === 'function' && <button className="primary" type="button" onClick={() => void navigator.share({ url: inviteUrl }).catch(() => {})}>Поделиться</button>}</div>
        </section>}
        {role === 'owner' && !connection.authRequired && activeMembers.filter(member => member.role === 'member' && !member.placeholder).map(member =>
          <div className="spread" key={member.id}><span>{member.name}</span>
            <button className={revokeId === member.id ? 'danger-button' : 'secondary'} disabled={busy} onClick={() => {
              if (revokeId !== member.id) { setRevokeId(member.id); return }
              void perform(async () => { await revoke(connection.session, member.id); setRevokeId(''); setInvitation(null) })
            }}>{revokeId === member.id ? 'Подтвердить отзыв' : 'Отозвать доступ'}</button>
          </div>)}
        {pendingCount > 0 && data && <button className="secondary self-start" onClick={() => exportSnapshot(data)}>Сохранить резервную копию</button>}
        <button className={discard ? 'danger-button' : 'secondary'} disabled={busy} onClick={() => {
          if (pendingCount && !discard) { setDiscard(true); return }
          void perform(async () => { await disconnect(connection.session, { discard, unavailable: connection.authRequired }); close() })
        }}>{discard ? 'Выйти и удалить очередь' : 'Выйти из бюджета'}</button>
        {role === 'member' && !connection.authRequired && <button className={departing ? 'danger-button' : 'secondary'} disabled={busy} onClick={() => {
          if (!departing) { setDeparting(true); return }
          void perform(async () => { await disconnect(connection.session, { discard: pendingCount > 0, leave: true }); close() })
        }}>{departing ? 'Подтвердить выход из общего бюджета' : 'Покинуть бюджет'}</button>}
        {departing && <p className="muted" role="status">Доступ будет закрыт, а история сохранится у владельца.{pendingCount > 0 && ' Сохраните резервную копию ожидающих изменений перед подтверждением.'}</p>}
        {discard && <p className="form-error" role="alert">При выходе ожидающие изменения на этом устройстве будут удалены. Сохраните резервную копию перед подтверждением.</p>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="muted" role="status">{message}</p>}
    </div>
  </Sheet>
}

export function CloudIndicator({ connection, open }: { connection: Connection; open: () => void }) {
  const { state, label, Icon } = cloudStatus(connection)
  return <button className="icon-button cloud-indicator" type="button" data-status={state} aria-label={label} title={label} onClick={open}>
    <Icon size={20} aria-hidden="true"/>
  </button>
}
