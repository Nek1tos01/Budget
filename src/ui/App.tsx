import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, LayoutGroup, motion, MotionConfig, useReducedMotion } from 'motion/react'
import { ChartNoAxesColumnIncreasing, Check, CircleAlert, House, LayoutGrid, List, Plus, Settings as Cog, Wallet } from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { readConnection, startCloudSync, type WorkspaceScope } from '../cloud/client'
import { CloudIndicator, CloudPanel, initialInvitation, type CloudAction } from './Cloud'
import { repository } from '../data/repository'
import type { Member, OperationType, PeriodKind, Theme, Transaction } from '../domain/models'
import { Analytics } from './Analytics'
import { BudgetPage } from './BudgetPage'
import { Categories, CategoryDetail, CategoryEditor } from './Categories'
import { HistoryPage, OperationDetail, OperationEditor } from './Operations'
import { LimitsEditor, MemberEditor, MembersPage, SettingsPage, WeekPage } from './Settings'
import { Onboarding } from './Onboarding'
import { Avatar, screenTransition, spring, type Mutate } from './shared'
import { PwaUpdate } from '../infrastructure/PwaUpdate'
import { AddOperationChoice, ReceiptFlow, SavedReceipt } from './Receipts'

type Page = 'budget' | 'history' | 'analytics' | 'settings' | 'categories' | 'members' | 'week' | 'category'
type Overlay = { type: 'add'; fromDock?: boolean } | { type: 'operation'; row?: Transaction; initialType?: OperationType } | { type: 'detail'; row: Transaction } |
  { type: 'receipt'; id?: string; edit?: boolean } | { type: 'category'; id?: string } | { type: 'limits' } | { type: 'member'; member: Member }
const mainNav = [
  { id: 'budget', name: 'Бюджет', icon: House },
  { id: 'history', name: 'Операции', icon: List },
  { id: 'analytics', name: 'Аналитика', icon: ChartNoAxesColumnIncreasing },
  { id: 'settings', name: 'Настройки', icon: Cog },
] as const
const desktopNav = [...mainNav.slice(0, 3), { id: 'categories', name: 'Категории', icon: LayoutGrid }, mainNav[3]] as const
const mobileNav = [mainNav[0], mainNav[1], mainNav[2], { id: 'categories', name: 'Категории', icon: LayoutGrid }] as const

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
  const workspace = useLiveQuery(repository.readWorkspace)
  const data = workspace?.data
  const connection = workspace?.connection
  const scope = workspace?.scope ?? 'local'
  const [cloudAction, setCloudAction] = useState<CloudAction | null>(initialInvitation ? 'join' : null)
  const [joinToken, setJoinToken] = useState(initialInvitation)
  useEffect(startCloudSync, [])
  const [page, setPage] = useState<Page>('budget')
  const [kind, setKind] = useState<PeriodKind>('week')
  const [offset, setOffset] = useState(0)
  const [editor, setEditor] = useState<{ overlay: Overlay; scope: WorkspaceScope } | null>(null)
  const overlay = editor?.scope === scope ? editor.overlay : null
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
    try {
      await work(scope)
      if (success) {
        const cloud = await readConnection()
        notify(cloud?.mode === 'active' && cloud.queue.length ? success + ' · ожидает синхронизации' : success)
      }
      return true
    }
    catch (error) { notify(error instanceof Error ? error.message : 'Не удалось сохранить данные.', true); return false }
    finally { mutating.current = false }
  }, [notify, scope])

  function navigate(next: Page) {
    setPage(next)
    window.scrollTo(0, 0)
  }
  function openOverlay(value: Overlay) {
    if (!overlay) navFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setEditor({ overlay: value, scope })
  }
  function closeOverlay() {
    setEditor(null)
  }
  const add = () => openOverlay({ type: 'add' })
  const openReceipt = (id: string) => openOverlay({ type: 'receipt', id })
  const openOperation = (row: Transaction) => row.receiptId ? openReceipt(row.receiptId) : openOverlay({ type: 'detail', row })
  const selectedReceipt = overlay?.type === 'receipt' ? data?.receipts?.find(receipt => receipt.id === overlay.id) : undefined
  const activePage = page === 'week' ? (weekBack === 'budget' ? 'budget' : 'settings') : page === 'category' ? 'categories' : page
  const secondaryPage = activePage === 'members' ? 'settings' : activePage
  const category = data?.categories.find(item => item.id === categoryId)
  const screens = data && {
    budget: <BudgetPage data={data} now={now} kind={kind} offset={offset} changeKind={value => { setKind(value); setOffset(0) }} changeOffset={setOffset}
      openWeek={() => { setWeekBack('budget'); navigate('week') }} openCategories={() => navigate('categories')}
      openCategory={item => { setCategoryId(item.id); navigate('category') }} openHistory={() => navigate('history')} openOperation={openOperation} add={add}/>,
    history: <HistoryPage data={data} now={now} onOpen={openOperation} add={add}/>,
    analytics: <Analytics data={data} now={now}/>,
    settings: <SettingsPage data={data} now={now} week={() => { setWeekBack('settings'); navigate('week') }} limits={() => openOverlay({ type: 'limits' })}
      categories={() => navigate('categories')} members={() => navigate('members')} mutate={mutate} openCloud={() => setCloudAction('menu')}/>,
    week: <WeekPage data={data} now={now} backLabel={weekBack === 'budget' ? 'Бюджет' : 'Настройки'} back={() => navigate(weekBack)} mutate={mutate}/>,
    categories: <Categories data={data} now={now} open={item => { setCategoryId(item.id); navigate('category') }} edit={() => openOverlay({ type: 'category' })} mutate={mutate}/>,
    category: category && <CategoryDetail category={category} data={data} now={now} open={openOperation} back={() => navigate('categories')}
      edit={() => openOverlay({ type: 'category', id: category.id })} mutate={mutate}/>,
    members: <MembersPage data={data} now={now} edit={member => openOverlay({ type: 'member', member })} onOpen={openOperation} back={() => navigate('settings')} openCloud={() => setCloudAction('menu')}/>,
  }

  return <MotionConfig reducedMotion="user"><LayoutGroup>
    {data === undefined ? <main className="loading-screen" aria-busy="true"><span className="brand-icon"><Wallet size={25}/></span><p>Открываем бюджет…</p></main>
      : connection?.mode === 'active' && connection.authRequired
        ? <main className="loading-screen"><CircleAlert size={25}/><h1>Восстановите доступ</h1>
          <p>Изменения на устройстве сохранены.</p><button className="primary" onClick={() => setCloudAction('recover')}>Восстановить доступ</button>
          <CloudIndicator connection={connection} open={() => setCloudAction('menu')}/></main>
      : data === null ? connection?.mode === 'active'
        ? <main className="loading-screen"><span className="brand-icon"><Wallet size={25}/></span><p>Загружаем общий бюджет…</p><CloudIndicator connection={connection} open={() => setCloudAction('menu')}/></main>
        : <Onboarding mutate={mutate} now={now} openCloud={setCloudAction}/>
      : <div className="app">
        <aside className="sidebar">
          <button className="brand" type="button" onClick={() => navigate('budget')}><span className="brand-icon"><Wallet size={19}/></span><span>Бюджет</span></button>
          <nav aria-label="Разделы бюджета" className="desktop-nav">{desktopNav.map(({ id, name, icon: Icon }) => <button key={id} type="button"
            aria-current={secondaryPage === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={19}/>{name}</button>)}</nav>
          <div className="household"><span className="avatar-pair">{data.members.filter(member => member.active !== false || member.placeholder).slice(0, 2).map(member => <Avatar key={member.id} member={member}/>)}</span>
            <span><strong>{data.profile.household.name}</strong><small>{connection?.mode === 'active' ? 'Общий бюджет' : data.profile.settings.demo ? 'Демо-бюджет' : 'Локальный бюджет'}</small></span></div>
        </aside>
        <main className="workspace" id="main-content">
          <nav className="page-tools" aria-label="Управление бюджетом">
            {connection && <CloudIndicator connection={connection} open={() => setCloudAction('menu')}/>}
            <button type="button" className="mobile-settings icon-button" aria-label="Настройки"
              aria-current={secondaryPage === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Cog size={20}/></button>
          </nav>
          <AnimatePresence mode="wait" initial={false}><motion.div key={scope + ':' + page} className="page" initial={reducedMotion ? false : { opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }} transition={reducedMotion ? { duration: 0 } : screenTransition}>{screens?.[page]}</motion.div></AnimatePresence>
        </main>
        <div className="mobile-dock"><nav className="mobile-nav" aria-label="Основная навигация">
          {mobileNav.map(({ id, name, icon: Icon }, i) => <button type="button" key={id} className={`tab tab-${i}`}
            aria-current={secondaryPage === id ? 'page' : undefined} onClick={() => navigate(id)}>
            <span className="tab-icon">{secondaryPage === id && <motion.span className="tab-marker" layoutId="active-tab" transition={spring}/>}<Icon size={21}/></span>
            <span>{name}</span>
          </button>)}
          <motion.button className="nav-add" type="button" aria-label="Добавить операцию" style={{ borderRadius: 22 }}
            layoutId={reducedMotion ? undefined : 'add-operation-glass'} whileTap={reducedMotion ? undefined : { scale: .93 }}
            transition={spring} onClick={() => openOverlay({ type: 'add', fromDock: true })}><Plus size={25}/></motion.button>
        </nav></div>
        {overlay?.type === 'add' && <AddOperationChoice fromDock={overlay.fromDock} onClose={closeOverlay} choose={type => openOverlay(type === 'receipt' ? { type } : { type: 'operation', initialType: type })}/>}
        {overlay?.type === 'operation' && <OperationEditor key={overlay.row?.id ?? 'new'} data={data} now={now} row={overlay.row} initialType={overlay.initialType} mutate={mutate} onClose={closeOverlay}/>}
        {overlay?.type === 'detail' && <OperationDetail data={data} row={overlay.row} onClose={closeOverlay} onEdit={() => openOverlay({ type: 'operation', row: overlay.row })} mutate={mutate}/>}
        {overlay?.type === 'receipt' && (!overlay.id || overlay.edit && selectedReceipt) && <ReceiptFlow key={overlay.id ?? 'new'} data={data} now={now} scope={scope}
          connection={connection} receipt={selectedReceipt} mutate={mutate} onClose={selectedReceipt ? () => openReceipt(selectedReceipt.id) : closeOverlay}
          onOpen={openReceipt} onHistory={() => { closeOverlay(); navigate('history') }} onBudget={() => { closeOverlay(); navigate('budget') }}/>}
        {overlay?.type === 'receipt' && selectedReceipt && !overlay.edit && <SavedReceipt key={selectedReceipt.id} data={data} receipt={selectedReceipt} connection={connection}
          mutate={mutate} onClose={closeOverlay} onEdit={() => openOverlay({ type: 'receipt', id: selectedReceipt.id, edit: true })}/>}
        {overlay?.type === 'category' && <CategoryEditor category={data.categories.find(item => item.id === overlay.id)} onClose={closeOverlay} mutate={mutate}/>}
        {overlay?.type === 'limits' && <LimitsEditor profile={data.profile} onClose={closeOverlay} mutate={mutate}/>}
        {overlay?.type === 'member' && <MemberEditor member={overlay.member} onClose={closeOverlay} mutate={mutate}/>}
      </div>}
    <div className="toast-wrap" aria-live="polite"><AnimatePresence>{toast && <motion.div key={toast.message} className={`toast ${toast.error ? 'negative' : ''}`}
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: .19 }}>
      {toast.error ? <CircleAlert size={18}/> : <Check size={18}/>} {toast.message}</motion.div>}</AnimatePresence></div>
    {cloudAction && <CloudPanel action={cloudAction} token={joinToken} connection={connection ?? undefined} data={data} onOpenReceipt={openReceipt} close={() => {
      setCloudAction(null)
      setJoinToken('')
    }}/>}
    <PwaUpdate/>
  </LayoutGroup></MotionConfig>
}
