import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion } from 'motion/react'
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight, Wallet, X } from 'lucide-react'
import { DEFAULT_CATEGORY_EMOJI } from '../domain/emoji'
import { money, percentChange, usageLabel } from '../domain/engine'
import type { WorkspaceScope } from '../cloud/client'
import type { Category, Member, Summary, Transaction } from '../domain/models'

export const colors = ['#a092ff','#f3ab72','#74b5ff','#e992c6','#71d4b6','#f1c86c','#ee838d','#98c678']
export const spring = { type: 'spring', stiffness: 400, damping: 36 } as const
export const sheetSpring = { type: 'spring', stiffness: 355, damping: 36, mass: .85 } as const
export const screenTransition = { duration: .19, ease: [.22, 1, .36, 1] } as const
export type Mutate = (work: (scope: WorkspaceScope) => Promise<unknown>, success?: string) => Promise<boolean>

export function CategoryIcon({ emoji, size = 26, income = false }: { emoji?: string; size?: number; income?: boolean }) {
  if (income) return <span aria-hidden="true" className="category-icon income-icon"><ArrowDownLeft size={20} strokeWidth={1.75}/></span>
  return <span aria-hidden="true" className="category-icon">
    <span className="category-emoji" style={{ fontSize: size }}>{emoji || DEFAULT_CATEGORY_EMOJI}</span>
  </span>
}

export function Avatar({ member }: { member: Member }) {
  return <span className="avatar" aria-hidden="true" style={{ '--tint': member.color } as CSSProperties}>{member.name.slice(0, 1).toUpperCase()}</span>
}

export function MoneyText({ text, label }: { text: string; label?: string }) {
  const width = Array.from(text).reduce((total, char) => total + (/\s/.test(char) ? .32 : char === ',' ? .34 : char === '₽' ? .67 : .63), .1)
  return <span className="money-fit" aria-label={label} style={{ '--money-width': width } as CSSProperties}>
    <span className="money-value">{text}</span>
  </span>
}

export function Money({ value }: { value: number }) {
  const reduced = useReducedMotion()
  const motionValue = useMotionValue(value)
  const [shown, setShown] = useState(value)
  useMotionValueEvent(motionValue, 'change', latest => setShown(Math.round(latest)))
  useEffect(() => {
    if (reduced) { motionValue.set(value); return }
    const controls = animate(motionValue, value, { duration: .32, ease: [.22, 1, .36, 1] })
    return () => controls.stop()
  }, [motionValue, reduced, value])
  return <MoneyText text={money(shown)} label={money(value)}/>
}

export function Progress({ summary, color }: { summary: Summary; color?: string }) {
  return <div className={`progress ${summary.remaining < 0 ? 'over' : ''}`} role="progressbar"
    aria-label="Использовано" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, summary.percent ?? 0)}
    aria-valuetext={summary.percent === null ? 'Нулевой лимит' : usageLabel(summary)}>
    <motion.span initial={{ scaleX: 0 }} animate={{ scaleX: Math.min(1, (summary.percent ?? 0) / 100) }} transition={spring}
      style={color && summary.remaining >= 0 ? { background: color } : undefined}/>
  </div>
}

export function Ring({ summary }: { summary: Summary }) {
  const id = useId()
  const circumference = 2 * Math.PI * 49
  const percent = summary.percent ?? 0
  return <div className={`budget-ring ${summary.remaining < 0 ? 'over' : ''}`} aria-label={summary.percent === null ? 'Нулевой лимит' : `Использовано ${usageLabel(summary)}`}>
    <svg viewBox="0 0 116 116" aria-hidden="true">
      <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--ring-start)"/><stop offset="1" stopColor="var(--ring-end)"/></linearGradient></defs>
      <circle cx="58" cy="58" r="49" className="ring-track" strokeWidth="9" fill="none"/>
      {percent > 0 && <motion.circle cx="58" cy="58" r="49" stroke={summary.remaining < 0 ? 'var(--danger)' : `url(#${id})`} strokeWidth="9" fill="none"
        strokeLinecap="round" transform="rotate(-90 58 58)" strokeDasharray={circumference}
        initial={{ strokeDashoffset: circumference }} animate={{ strokeDashoffset: circumference * (1 - Math.min(100, percent) / 100) }} transition={spring}/>}
    </svg>
    <div><strong className={percent >= 1000 ? "wide-percent" : undefined}>{usageLabel(summary)}</strong><small>от лимита</small></div>
  </div>
}

export function Segmented<T extends string>({ items, value, onChange, label }: {
  items: readonly (readonly [T, string])[]; value: T; onChange: (value: T) => void; label: string
}) {
  const id = useId()
  return <div className="segmented" role="group" aria-label={label}>
    {items.map(([key, name]) => <button type="button" key={key} aria-pressed={key === value} onClick={() => onChange(key)}>
      {key === value && <motion.span className="segment-fill" layoutId={id} transition={spring}/>}<span>{name}</span>
    </button>)}
  </div>
}

export function Toggle({ label, description, checked, onChange, disabled }: {
  label: string; description?: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean
}) {
  const id = useId()
  return <label className="setting-toggle">
    <span><strong id={id}>{label}</strong>{description && <small id={id + '-description'}>{description}</small>}</span>
    <span className="glass-switch">
      <input type="checkbox" role="switch" aria-labelledby={id} aria-describedby={description ? id + '-description' : undefined}
        checked={checked} onChange={event => onChange(event.currentTarget.checked)} disabled={disabled}/>
      <motion.i aria-hidden="true" initial={false} animate={{ x: checked ? 17 : 0 }} transition={spring}/>
    </span>
  </label>
}

export function MonthlyOnlyBadge() {
  return <span className="monthly-only-badge">Только месяц</span>
}

export function PeriodArrows({ label, offset, onChange }: { label: string; offset: number; onChange: (offset: number) => void }) {
  return <div className="period-arrows">
    <button type="button" className="icon-button subtle" aria-label="Предыдущий период" onClick={() => onChange(offset - 1)} disabled={offset <= -1200}><ChevronLeft size={18}/></button>
    <span aria-live="polite" aria-atomic="true">{label}</span>
    <button type="button" className="icon-button subtle" aria-label="Следующий период" onClick={() => onChange(offset + 1)} disabled={offset >= 0}><ChevronRight size={18}/></button>
  </div>
}

export function Sheet({ title, description, onClose, onRequestClose, children, footer, dismissible = true, className = '', layoutId }: {
  title: string; description?: string; onClose: () => void; onRequestClose?: () => void; children: ReactNode | ((close: () => void) => ReactNode); footer?: ReactNode; dismissible?: boolean; className?: string; layoutId?: string
}) {
  const [open, setOpen] = useState(true)
  const closing = useRef(false)
  const reduced = useReducedMotion()
  const sheetRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const viewport = window.visualViewport
    const sheet = sheetRef.current
    if (!viewport || !sheet) return
    const update = () => {
      const unzoomed = Math.abs(viewport.scale - 1) < .01
      const bottom = unzoomed ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0
      sheet.style.setProperty('--keyboard-bottom', bottom + 'px')
      if (unzoomed) sheet.style.setProperty('--viewport-height', viewport.height + 'px')
      else sheet.style.removeProperty('--viewport-height')
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [])
  function close() {
    if (!dismissible || closing.current) return
    if (onRequestClose) { onRequestClose(); return }
    closing.current = true
    if (reduced) { onClose(); return }
    setOpen(false)
  }
  return <Dialog.Root open onOpenChange={value => { if (!value) close() }}>
    <Dialog.Portal>
      <Dialog.Overlay asChild><motion.div className="sheet-overlay" initial={reduced ? false : { opacity: 0 }} animate={{ opacity: open ? 1 : 0 }} transition={reduced ? { duration: 0 } : screenTransition}/></Dialog.Overlay>
      <Dialog.Content className={`sheet ${className}`} asChild onOpenAutoFocus={event => {
        event.preventDefault()
        const container = event.target instanceof HTMLElement ? event.target : null
        container?.querySelector<HTMLElement>('.sheet-close')?.focus({ preventScroll: true })
      }}>
        <motion.div ref={sheetRef} layoutId={reduced ? undefined : layoutId} style={{ borderRadius: '28px 28px 0 0' }}
          initial={reduced ? false : { y: layoutId ? 0 : '80%', opacity: layoutId ? .95 : .7 }} animate={{ y: open ? 0 : '100%', opacity: open ? 1 : .7 }}
          transition={reduced ? { duration: 0 } : open ? sheetSpring : screenTransition} onAnimationComplete={() => { if (!open) onClose() }}>
          <div className="sheet-handle"/><div className="sheet-head">
            <Dialog.Title>{title}</Dialog.Title><Dialog.Close disabled={!dismissible} className="icon-button sheet-close" aria-label="Закрыть"><X size={19}/></Dialog.Close>
          </div>
          <Dialog.Description className={description ? 'sheet-description' : 'sr-only'}>{description || title}</Dialog.Description>
          <div className="sheet-content">{typeof children === 'function' ? children(close) : children}</div>
          {footer && <div className="sheet-footer">{footer}</div>}
        </motion.div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

export function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Wallet size={25}/></span><h3>{title}</h3><p>{text}</p>{children}</div>
}

export function OperationRow({ row, category, member, author, onClick }: {
  row: Transaction; category?: Category; member?: Member; author?: Member; onClick: () => void
}) {
  const title = row.type === 'expense' ? row.note || category?.name || 'Расход' : row.source || 'Доход'
  const metadata = [row.type === 'expense' ? category?.name : 'Доход', member?.name, author ? 'Добавил ' + author.name : null].filter(Boolean).join(' · ')
  return <button type="button" className="operation-row" onClick={onClick}>
    <CategoryIcon emoji={category?.emoji} income={row.type === 'income'}/><span className="row-body"><strong>{title}</strong><small>{metadata}</small>
      {row.budgetScope === 'monthly_only' && <MonthlyOnlyBadge/>}</span>
    <strong className={`row-amount ${row.type === 'income' ? 'positive' : ''}`}><MoneyText text={(row.type === 'income' ? '+' : '−') + money(row.amount)}/></strong>
    <ChevronRight className="row-chevron" size={16}/>
  </button>
}

export function ChangeBadge({ current, previous }: { current: number; previous: number }) {
  if (!previous) return null
  const delta = percentChange(current, previous)
  if (!delta) return <span className="change-badge">0%</span>
  const Icon = delta < 0 ? ArrowDownLeft : ArrowUpRight
  return <span className={`change-badge ${delta < 0 ? 'positive' : 'negative'}`}>{delta < 0 ? '−' : '+'}{Math.abs(delta)}% <Icon size={13}/></span>
}
