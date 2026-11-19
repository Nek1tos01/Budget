import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Download, Info, LayoutGrid, Palette, RotateCcw, Upload, UsersRound, Wallet } from 'lucide-react'
import { motion } from 'motion/react'
import { engine, isZone, labelDay, labelPeriod, money, moneyInput, parseMoney, toDay, weekdays, weekdayShort, weekdaysReset } from '../domain/engine'
import type { Member, Profile, Snapshot } from '../domain/models'
import { parseSnapshot, repository } from '../data/repository'
import { newSnapshot } from '../data/demo'
import { Avatar, Segmented, Sheet, spring, type Mutate } from './shared'
import { History } from './Operations'
import type { Transaction } from '../domain/models'

const themes = [['dark', 'Тёмная'], ['light', 'Светлая'], ['system', 'Системная']] as const

function SettingRow({ icon, label, value, onClick }: { icon: ReactNode; label: string; value?: string; onClick: () => void }) {
  return <button type="button" className="setting-row" onClick={onClick}><span className="mini-icon">{icon}</span><span>{label}</span>
    {value && <small>{value}</small>}<ChevronRight className="setting-arrow" size={17}/></button>
}

export function WeekDays({ value, change }: { value: number; change: (day: number) => void }) {
  const indicator = useId()
  return <div className="weekday-grid" role="group" aria-label="Начало финансовой недели">{weekdayShort.map((day, i) => <button type="button" key={day}
    aria-pressed={i + 1 === value} title={weekdays[i]} onClick={() => change(i + 1)}>{i + 1 === value && <motion.span layoutId={indicator} className="weekday-fill" transition={spring}/>}<span>{day}</span></button>)}</div>
}

export function SettingsPage({ data, now, week, limits, categories, members, mutate }: {
  data: Snapshot; now: number; week: () => void; limits: () => void; categories: () => void; members: () => void; mutate: Mutate
}) {
  const { settings, budget } = data.profile
  const [pending, setPending] = useState<Snapshot | 'demo' | null>(null)
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const current = engine.period('week', now, settings.timezone, settings.weekStart)
  function exportData() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = 'budget-' + toDay(now, settings.timezone) + '.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <><header className="page-head"><div><h1>Настройки</h1><p>Управление общим бюджетом</p></div></header>
    <div className="settings-grid">
      <div className="detail-stack"><section><div className="section-head"><h2>Ваш бюджет</h2></div><div className="panel grouped">
        <SettingRow icon={<Wallet size={19}/>} label="Общие лимиты" value={money(budget.week) + ' / нед.'} onClick={limits}/>
        <SettingRow icon={<CalendarDays size={19}/>} label="Финансовая неделя" value={weekdays[settings.weekStart - 1]} onClick={week}/>
        <SettingRow icon={<LayoutGrid size={19}/>} label="Категории" onClick={categories}/>
        <SettingRow icon={<UsersRound size={19}/>} label="Участники" value="2" onClick={members}/>
      </div><p className="group-note">Текущий период · {labelPeriod(current, toDay(now, settings.timezone).slice(0,4))}</p></section>
      <section><div className="section-head"><h2><Palette size={19}/> Внешний вид</h2></div><div className="panel padded">
        <Segmented items={themes} value={settings.theme} onChange={theme => void mutate(() => repository.updateProfile(profile => ({ ...profile, settings: { ...profile.settings, theme } })))} label="Тема оформления"/>
      </div></section></div>
      <div className="detail-stack"><section><div className="section-head"><h2>Локальные данные</h2></div><div className="panel grouped">
        <SettingRow icon={<Download size={19}/>} label="Экспорт JSON" onClick={exportData}/>
        <SettingRow icon={<Upload size={19}/>} label="Импорт JSON" onClick={() => file.current?.click()}/>
        <SettingRow icon={<RotateCcw size={19}/>} label="Сбросить демо-данные" onClick={() => setPending('demo')}/>
        <input type="file" hidden ref={file} accept="application/json,.json" onChange={event => {
          const selected = event.target.files?.[0]
          event.target.value = ''
          if (!selected) return
          void mutate(async () => {
            let parsed: unknown
            try { parsed = JSON.parse(await selected.text()) }
            catch { throw new Error('Не удалось прочитать JSON-файл.') }
            setPending(parseSnapshot(parsed))
          })
        }}/>
      </div></section>
      <div className="panel info-panel"><Info size={21}/><div><strong>{settings.demo ? 'Демонстрационный бюджет' : 'Локальный бюджет'}</strong>
        <p>{settings.demo ? 'В этом бюджете есть пример операций за последние несколько месяцев. ' : ''}Данные хранятся на этом устройстве.</p></div></div></div>
    </div>
    {pending && <Sheet title={pending === 'demo' ? 'Сбросить демо-данные?' : 'Импортировать бюджет?'} onClose={() => setPending(null)}>{close =>
      <div className="detail-stack"><p className="muted">{pending === 'demo' ? 'Текущие данные будут заменены новым демонстрационным бюджетом.' :
        `Резервная копия «${pending.profile.household.name}» заменит локальные данные. Операций в копии: ${pending.transactions.length}.`}</p>
        <div className="actions"><button className="secondary" type="button" onClick={close} disabled={busy}>Отмена</button>
          <button className="danger-button" type="button" disabled={busy} onClick={async () => {
            setBusy(true)
            if (await mutate(() => repository.replace(pending === 'demo' ? newSnapshot(true, now) : pending), pending === 'demo' ? 'Демо-данные обновлены' : 'Данные импортированы')) close()
            setBusy(false)
          }}>Заменить данные</button></div></div>}
    </Sheet>}
  </>
}

export function WeekPage({ data, now, back, backLabel, mutate }: { data: Snapshot; now: number; backLabel: string; back: () => void; mutate: Mutate }) {
  const { settings } = data.profile
  const [draft, setDraft] = useState(settings.timezone)
  const [error, setError] = useState('')
  const { timezone, weekStart } = settings
  const current = engine.period('week', now, timezone, weekStart)
  const next = toDay(engine.nextReset(now, timezone, weekStart), timezone)
  return <div className="narrow week-page">
      <header className="week-heading">
        <button className="text-button back-button" onClick={back}><ChevronLeft size={19}/> {backLabel}</button>
        <h1>Финансовая неделя</h1>
        <p>Настройте день обновления лимитов.</p>
      </header>
      <section className="panel padded detail-stack week-start"><div className="spread"><strong>Начало недели</strong><span className="muted">{weekdays[weekStart - 1]}</span></div>
        <WeekDays value={weekStart} change={day => void mutate(() => repository.updateProfile(profile => ({ ...profile, settings: { ...profile.settings, weekStart: day } })))}/>
        <div className="inset-note"><Info size={17}/> Лимиты обновляются {weekdaysReset[weekStart - 1]} в 00:00</div></section>
      <div className="week-next"><CalendarDays size={22} aria-hidden="true"/><dl>
        <dt>Следующее обновление</dt><dd>{labelDay(next, true)} <small>в 00:00</small></dd>
      </dl></div>
      <dl className="panel meta-list"><div><dt>Текущая неделя</dt><dd>{labelPeriod(current, toDay(now, timezone).slice(0,4))}</dd></div>
        <div><dt>Месячный цикл</dt><dd>С 1 числа</dd></div></dl>
      <form className="panel padded detail-stack week-zone" onSubmit={event => {
        event.preventDefault()
        if (!isZone(draft.trim())) { setError('Укажите часовой пояс, например Asia/Novosibirsk.'); return }
        setError('')
        void mutate(() => repository.updateProfile(profile => ({ ...profile, settings: { ...profile.settings, timezone: draft.trim() } })), 'Часовой пояс изменён')
      }}><label className="field"><span>Часовой пояс бюджета</span><input value={draft} onChange={event => setDraft(event.target.value)} maxLength={80} spellCheck={false} autoCapitalize="off"/></label>
        {error && <p className="form-error" role="alert">{error}</p>}<button type="submit" className="secondary self-start" disabled={draft.trim() === timezone}>Обновить часовой пояс</button></form>
    </div>
}

export function LimitsEditor({ profile, onClose, mutate }: { profile: Profile; onClose: () => void; mutate: Mutate }) {
  const [name, setName] = useState(profile.household.name)
  const [week, setWeek] = useState(moneyInput(profile.budget.week))
  const [month, setMonth] = useState(moneyInput(profile.budget.month))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent, close: () => void) {
    event.preventDefault()
    const a = parseMoney(week), b = parseMoney(month)
    if (a === null || b === null || !name.trim()) { setError('Проверьте название и суммы лимитов.'); return }
    setBusy(true)
    if (await mutate(() => repository.updateProfile(current => ({ ...current, household: { ...current.household, name: name.trim() }, budget: { week: a, month: b } })), 'Бюджет обновлён')) close()
    else setBusy(false)
  }
  return <Sheet title="Общий бюджет" onClose={onClose}>{close => <form className="detail-stack" onSubmit={event => void submit(event, close)}>
    <label className="field"><span>Название бюджета</span><input value={name} maxLength={60} onChange={event => setName(event.target.value)}/></label>
    <div className="form-fields inline-fields"><label className="field"><span>На неделю, ₽</span><input inputMode="decimal" value={week} maxLength={15} onChange={event => setWeek(event.target.value)}/></label>
      <label className="field"><span>На месяц, ₽</span><input inputMode="decimal" value={month} maxLength={15} onChange={event => setMonth(event.target.value)}/></label></div>
    {error && <p className="form-error" role="alert">{error}</p>}<button className="primary full" disabled={busy}>Сохранить</button>
  </form>}</Sheet>
}

export function MembersPage({ data, now, edit, onOpen, back }: { data: Snapshot; now: number; edit: (member: Member) => void; onOpen: (row: Transaction) => void; back: () => void }) {
  return <><button className="text-button back-button" onClick={back}><ChevronLeft size={19}/> Настройки</button>
    <header className="page-head"><div><h1>Участники</h1><p>{data.profile.household.name}</p></div></header>
    <div className="narrow detail-stack"><div className="panel grouped">{data.members.map(member =>
      <button className="setting-row" type="button" key={member.id} onClick={() => edit(member)}><Avatar member={member}/><span>{member.name}</span><small>Изменить</small><ChevronRight size={17}/></button>)}</div>
      <div className="panel info-panel"><UsersRound size={21}/><div><strong>Общий бюджет</strong><p>Подключение второго устройства появится на втором этапе.</p></div></div>
      <div className="section-head"><h2>Общие расходы</h2></div><History data={{ ...data, transactions: data.transactions.filter(row => row.type === 'expense') }} now={now} onOpen={onOpen}/>
    </div></>
}

export function MemberEditor({ member, mutate, onClose }: { member: Member; mutate: Mutate; onClose: () => void }) {
  const [name, setName] = useState(member.name)
  const [busy, setBusy] = useState(false)
  return <Sheet title="Имя участника" onClose={onClose}>{close => <form className="detail-stack" onSubmit={async event => {
    event.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    if (await mutate(() => repository.putMember({ ...member, name: name.trim() }), 'Имя участника обновлено')) close()
    else setBusy(false)
  }}><label className="field"><span>Имя</span><input maxLength={60} value={name} onChange={event => setName(event.target.value)}/></label><button className="primary full" disabled={!name.trim() || busy}>Сохранить</button></form>}</Sheet>
}
