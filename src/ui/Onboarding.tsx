import { useState } from 'react'
import { ArrowRight, CalendarDays, Check, ChevronLeft, Wallet } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { CloudAction } from './Cloud'
import { newSnapshot } from '../data/demo'
import { repository } from '../data/repository'
import { parseMoney } from '../domain/engine'
import { WeekDays } from './Settings'
import { CategoryIcon, Ring, type Mutate } from './shared'

export function Onboarding({ mutate, now, openCloud }: { mutate: Mutate; now: number; openCloud: (action: CloudAction) => void }) {
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState(() => newSnapshot(false, now))
  const [week, setWeek] = useState('20000')
  const [month, setMonth] = useState('90000')
  const [active, setActive] = useState(draft.categories.map(item => item.id))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function begin(demo: boolean) {
    setBusy(true)
    if (!await mutate(scope => repository.replace(demo ? newSnapshot(true, now) : { ...draft, categories: draft.categories.filter(item => active.includes(item.id)) }, true, scope))) setBusy(false)
  }
  return <main className="welcome">
    <div className="welcome-brand"><span className="brand-icon"><Wallet size={20}/></span> Бюджет</div>
    <section className="welcome-card">
      <div className="welcome-art" aria-hidden="true">
        <div className="welcome-orbit orbit-outer"/><div className="welcome-orbit orbit-inner"/>
        <div className="welcome-art-card"><Ring summary={{ spent: 62, limit: 100, remaining: 38, percent: 62, income: 0 }}/><span className="art-pill"><CalendarDays size={15}/> Ваш ритм</span></div>
      </div>
      <div className="welcome-content"><AnimatePresence mode="wait" initial={false}>
        <motion.div key={step} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: .18 }}>
          {step === 0 ? <div className="welcome-step"><div><h1>Бюджет для двоих</h1><p>Общие лимиты, расходы и финансовая неделя, которая начинается в удобный вам день.</p></div>
            <button className="primary full" disabled={busy} onClick={() => setStep(1)}>Настроить бюджет <ArrowRight size={18}/></button>
            <button className="secondary full" disabled={busy} onClick={() => void begin(true)}>Открыть демо-бюджет</button>
            <div className="welcome-cloud"><button className="text-button" onClick={() => openCloud('households')}>Создать общий бюджет</button>
              <button className="text-button" onClick={() => openCloud('join')}>Присоединиться</button></div>
            <button className="text-button self-start" onClick={() => openCloud('recover')}>Восстановить доступ</button>
          </div> : <form className="welcome-step" onSubmit={event => {
            event.preventDefault()
            setError('')
            if (step === 1) {
              const a = parseMoney(week), b = parseMoney(month), name = draft.profile.household.name.trim()
              if (!name || a === null || b === null) { setError('Проверьте название и суммы лимитов.'); return }
              setDraft({ ...draft, profile: { ...draft.profile, household: { id: 'household', name }, budget: { week: a, month: b } } })
            }
            if (step === 3) void begin(false)
            else setStep(step + 1)
          }}>
            <div className="welcome-steps"><button type="button" className="text-button" onClick={() => { setError(''); setStep(step - 1) }}><ChevronLeft size={18}/> Назад</button><span>Шаг {step} из 3</span></div>
            <div><h1>{['', 'Общий бюджет', 'Финансовая неделя', 'Ваши категории'][step]}</h1><p>{['', 'Укажите название и общие лимиты.', 'Выберите день обновления недельных лимитов.', 'Выберите стартовые категории. Их можно настроить позже.'][step]}</p></div>
            {step === 1 && <><label className="field"><span>Название бюджета</span><input value={draft.profile.household.name} maxLength={60} onChange={event => setDraft({ ...draft, profile: { ...draft.profile, household: { id: 'household', name: event.target.value } } })}/></label>
              <div className="form-fields inline-fields"><label className="field"><span>На неделю, ₽</span><input inputMode="decimal" value={week} onChange={event => setWeek(event.target.value)} maxLength={15}/></label>
                <label className="field"><span>На месяц, ₽</span><input inputMode="decimal" value={month} onChange={event => setMonth(event.target.value)} maxLength={15}/></label></div></>}
            {step === 2 && <WeekDays value={draft.profile.settings.weekStart} change={weekStart => setDraft({ ...draft, profile: { ...draft.profile, settings: { ...draft.profile.settings, weekStart } } })}/>}
            {step === 3 && <div className="panel grouped">{draft.categories.map(item => <button type="button" className="setting-row" aria-pressed={active.includes(item.id)} key={item.id}
              onClick={() => setActive(active.includes(item.id) ? active.filter(id => id !== item.id) : [...active, item.id])}><CategoryIcon emoji={item.emoji}/><span>{item.name}</span>{active.includes(item.id) && <Check size={19} className="accent-text"/>}</button>)}</div>}
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary full" disabled={busy}>{step === 3 ? 'Открыть бюджет' : 'Продолжить'} <ArrowRight size={18}/></button>
          </form>}
        </motion.div>
      </AnimatePresence></div>
    </section>
    <p className="welcome-foot">Данные хранятся на этом устройстве</p>
  </main>
}
