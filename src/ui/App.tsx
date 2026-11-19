import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from 'motion/react'
import { ChartNoAxesColumnIncreasing, Check, CircleAlert, House, LayoutGrid, List, Plus, Settings as Cog, UsersRound, Wallet } from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { repository } from '../data/repository'
import type { Member, PeriodKind, Theme, Transaction } from '../domain/models'
import { Analytics } from './Analytics'
import { BudgetPage } from './BudgetPage'
import { Categories, CategoryDetail, CategoryEditor } from './Categories'
import { HistoryPage, OperationDetail, OperationEditor } from './Operations'
import { LimitsEditor, MemberEditor, MembersPage, SettingsPage, WeekPage } from './Settings'
import { Onboarding } from './Onboarding'
import { Avatar, screenTransition, spring, type Mutate } from './shared'
import { PwaUpdate } from '../infrastructure/PwaUpdate'

type Page = 'budget' | 'history' | 'analytics' | 'settings' | 'categories' | 'members' | 'week' | 'category'
type Overlay = { type: 'operation'; row?: Transaction } | { type: 'detail'; row: Transaction } | { type: 'category'; id?: string } | { type: 'limits' } | { type: 'member'; member: Member }
const mainNav = [
  { id: 'budget', name: 'Бюджет', icon: House },
  { id: 'history', name: 'Операции', icon: List },
  { id: 'analytics', name: 'Аналитика', icon: ChartNoAxesColumnIncreasing },
  { id: 'settings', name: 'Настройки', icon: Cog },
] as const
const desktopNav = [...mainNav.slice(0, 3), { id: 'categories', name: 'Категории', icon: LayoutGrid },
  { id: 'members', name: 'Участники', icon: UsersRound }, mainNav[3]] as const

function useTheme(theme: Theme) {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => {
      const actual = theme === 'system' ? media.matches ? 'dark' : 'light' : theme
      document.documentElement.dataset.theme = actual
      const background = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
      if (background) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background)
    }
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [theme])
}

export class StorageBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false }
  static getDerivedStateFromError() { return { error: true } }
  render() {
    if (this.state.error) return <main className="loading-screen"><CircleAlert size={33}/><h1>Не удалось открыть бюджет</h1>
      <p>Проверьте, что браузер разрешает локальное хранилище.</p><button className="primary" onClick={() => window.location.reload()}>Повторить</button></main>
    return this.props.children
  }
}

export function App() {
  const reducedMotion = useReducedMotion()
  const data = useLiveQuery(repository.read)
  const [page, setPage] = useState<Page>('budget')
  const [kind, setKind] = useState<PeriodKind>('week')
  const [offset, setOffset] = useState(0)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [categoryId, setCategoryId] = useState('')
  const [weekBack, setWeekBack] = useState<Page>('settings')
  const [now, setNow] = useState(Date.now)
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mutating = useRef(false)
  const navFocus = useRef<HTMLElement | null>(null)
  useTheme(data?.profile.settings.theme ?? 'dark')
  useEffect(() => {
    if (overlay || !navFocus.current) return
    const trigger = navFocus.current
    const frame = requestAnimationFrame(() => {
      trigger.focus({ preventScroll: true })
      navFocus.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [overlay])
  useEffect(() => {
    const update = () => setNow(Date.now())
    const timer = setInterval(update, 15_000)
    document.addEventListener('visibilitychange', update)
    return () => { clearInterval(timer); clearTimeout(toastTimer.current); document.removeEventListener('visibilitychange', update) }
  }, [])
  const notify = useCallback((message: string, error = false) => {
    clearTimeout(toastTimer.current)
    setToast({ message, error })
    toastTimer.current = setTimeout(() => setToast(null), error ? 5400 : 2800)
  }, [])
  const mutate: Mutate = useCallback(async (work, success) => {
    if (mutating.current) return false
    mutating.current = true
    try { await work(); if (success) notify(success); return true }
    catch (error) { notify(error instanceof Error ? error.message : 'Не удалось сохранить данные.', true); return false }
    finally { mutating.current = false }
  }, [notify])

  function navigate(next: Page) {
    setPage(next)
    window.scrollTo(0, 0)
  }
  function openOverlay(value: Overlay) {
    if (!overlay) navFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOverlay(value)
  }
  function closeOverlay() {
    setOverlay(null)
  }
  const add = () => openOverlay({ type: 'operation' })
  const openOperation = (row: Transaction) => openOverlay({ type: 'detail', row })
  const activePage = page === 'week' ? (weekBack === 'budget' ? 'budget' : 'settings') : page === 'category' ? 'categories' : page
  const secondaryPage = activePage === 'categories' || activePage === 'members' ? 'settings' : activePage
  const category = data?.categories.find(item => item.id === categoryId)
  const screens = data && {
    budget: <BudgetPage data={data} now={now} kind={kind} offset={offset} changeKind={value => { setKind(value); setOffset(0) }} changeOffset={setOffset}
      openWeek={() => { setWeekBack('budget'); navigate('week') }} openCategories={() => navigate('categories')}
      openCategory={item => { setCategoryId(item.id); navigate('category') }} openHistory={() => navigate('history')} openMembers={() => navigate('members')} openOperation={openOperation} add={add}/>,
    history: <HistoryPage data={data} now={now} onOpen={openOperation} add={add}/>,
    analytics: <Analytics data={data} now={now}/>,
    settings: <SettingsPage data={data} now={now} week={() => { setWeekBack('settings'); navigate('week') }} limits={() => openOverlay({ type: 'limits' })}
      categories={() => navigate('categories')} members={() => navigate('members')} mutate={mutate}/>,
    week: <WeekPage data={data} now={now} backLabel={weekBack === 'budget' ? 'Бюджет' : 'Настройки'} back={() => navigate(weekBack)} mutate={mutate}/>,
    categories: <Categories data={data} now={now} open={item => { setCategoryId(item.id); navigate('category') }} edit={() => openOverlay({ type: 'category' })}/>,
    category: category && <CategoryDetail category={category} data={data} now={now} open={openOperation} back={() => navigate('categories')}
      edit={() => openOverlay({ type: 'category', id: category.id })} mutate={mutate}/>,
    members: <MembersPage data={data} now={now} edit={member => openOverlay({ type: 'member', member })} onOpen={openOperation} back={() => navigate('settings')}/>,
  }

  return <MotionConfig reducedMotion="user">
    {data === undefined ? <main className="loading-screen" aria-busy="true"><span className="brand-icon"><Wallet size={25}/></span><p>Открываем бюджет…</p></main>
      : data === null ? <Onboarding mutate={mutate} now={now}/>
      : <div className="app">
        <aside className="sidebar">
          <button className="brand" type="button" onClick={() => navigate('budget')}><span className="brand-icon"><Wallet size={19}/></span><span>Бюджет</span></button>
          <nav aria-label="Разделы бюджета" className="desktop-nav">{desktopNav.map(({ id, name, icon: Icon }) => <button key={id} type="button"
            aria-current={activePage === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={19}/>{name}</button>)}</nav>
          <button className="household" onClick={() => navigate('members')}><span className="avatar-pair">{data.members.map(member => <Avatar key={member.id} member={member}/>)}</span>
            <span><strong>{data.profile.household.name}</strong><small>{data.profile.settings.demo ? 'Демо-бюджет' : 'Локальный бюджет'}</small></span></button>
        </aside>
        <main className="workspace" id="main-content">
          <AnimatePresence mode="wait" initial={false}><motion.div key={page} className="page" initial={reducedMotion ? false : { opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }} transition={reducedMotion ? { duration: 0 } : screenTransition}>{screens?.[page]}</motion.div></AnimatePresence>
        </main>
        <div className="mobile-dock"><nav className="mobile-nav" aria-label="Основная навигация">
          {mainNav.map(({ id, name, icon: Icon }, i) => <button type="button" key={id} className={`tab tab-${i}`}
            aria-current={secondaryPage === id ? 'page' : undefined} onClick={() => navigate(id)}>
            <span className="tab-icon">{secondaryPage === id && <motion.span className="tab-marker" layoutId="active-tab" transition={spring}/>}<Icon size={21}/></span>
            <span>{name}</span>
          </button>)}
          <motion.button className="nav-add" type="button" aria-label="Добавить операцию" whileTap={{ scale: .93 }} transition={spring} onClick={add}><Plus size={27}/></motion.button>
        </nav></div>
        {overlay?.type === 'operation' && <OperationEditor key={overlay.row?.id ?? 'new'} data={data} now={now} row={overlay.row} mutate={mutate} onClose={closeOverlay}/>}
        {overlay?.type === 'detail' && <OperationDetail data={data} row={overlay.row} onClose={closeOverlay} onEdit={() => openOverlay({ type: 'operation', row: overlay.row })} mutate={mutate}/>}
        {overlay?.type === 'category' && <CategoryEditor category={data.categories.find(item => item.id === overlay.id)} onClose={closeOverlay} mutate={mutate}/>}
        {overlay?.type === 'limits' && <LimitsEditor profile={data.profile} onClose={closeOverlay} mutate={mutate}/>}
        {overlay?.type === 'member' && <MemberEditor member={overlay.member} onClose={closeOverlay} mutate={mutate}/>}
      </div>}
    <div className="toast-wrap" aria-live="polite"><AnimatePresence>{toast && <motion.div key={toast.message} className={`toast ${toast.error ? 'negative' : ''}`}
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: .19 }}>
      {toast.error ? <CircleAlert size={18}/> : <Check size={18}/>} {toast.message}</motion.div>}</AnimatePresence></div>
    <PwaUpdate/>
  </MotionConfig>
}
