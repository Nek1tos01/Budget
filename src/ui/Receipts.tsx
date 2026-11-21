import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { ArrowDownLeft, Camera, Check, ChevronLeft, CircleAlert, ReceiptText, ShoppingCart, SquarePen, Trash2 } from 'lucide-react'
import { z } from 'zod'
import type { Connection, WorkspaceScope } from '../cloud/client'
import { repository } from '../data/repository'
import { isDay, money, moneyInput, parseMoney, roundUpToRuble, toDay } from '../domain/engine'
import { budgetScopes, type OperationType, type Snapshot, type Transaction } from '../domain/models'
import { defaultReceiptRoundingCategory, fiscalReceiptKey, normalizeProductName, parseFiscalQr, receiptItemBudgetScope, receiptItemBudgetScopes, receiptItemSchema, receiptItemsTotal, receiptOperations, receiptSchema, suggestReceiptCategory, type FiscalReceipt, type Receipt, type ReceiptRule } from '../domain/receipts'
import { parseReceiptText } from '../receipts/ocr-parser'
import { prepareReceiptImage, readReceiptQr, recognizeReceipt } from '../receipts/media'
import { CategoryEditor } from './Categories'
import { makeId } from './Operations'
import { CategoryPicker, ReceiptBulkScope, ReceiptHeader, ReceiptItemEditor, ReceiptItemList, ReceiptRules, ReceiptScopeBadge, ruleIdentity, type DraftItem, type ReceiptDraft } from './ReceiptItems'
import { ReceiptAction, ReceiptMethods, ReceiptPhoto, ReceiptProcessing, ReceiptScanner, selectedFile, type PhotoOptions } from './ReceiptMedia'
import { Avatar, CategoryIcon, MonthlyOnlyBadge, Sheet, Toggle, screenTransition, type Mutate } from './shared'

type Stage = 'methods' | 'scan' | 'photo' | 'processing' | 'items' | 'item' | 'category' | 'scope' | 'review' | 'success' | 'rules'
type Picker = { type: 'item'; ids: string[] } | { type: 'single' | 'adjustment' }
const noPhotoOptions: PhotoOptions = {}
const titles: Record<Stage, string> = { methods: 'Добавить чек', scan: 'Сканировать QR-код', photo: 'Фото чека', processing: 'Обрабатываем чек', items: 'Товары из чека', item: 'Изменить товар', category: 'Выбрать категорию', scope: 'Учёт выбранных товаров', review: 'Проверка и добавление', success: 'Чек сохранён', rules: 'Правила категорий' }

const draftSchema = z.object({
  id: z.string(), source: z.enum(['manual', 'qr', 'photo', 'combined']), store: z.string(), date: z.string(),
  fiscal: z.object({ fn: z.string(), i: z.string(), fp: z.string(), n: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), date: z.string(), time: z.string(), total: z.number() }).optional(),
  totalText: z.string(), memberId: z.string(), authorId: z.string().optional(), note: z.string(),
  mode: z.enum(['single', 'split']), categoryId: z.string().nullable(), adjustmentCategoryId: z.string().optional(), mismatchAccepted: z.boolean(),
  budgetScope: z.enum(budgetScopes).optional(), roundingEnabled: z.boolean().optional(), roundingCategoryId: z.string().optional(),
  items: z.array(receiptItemSchema.omit({ amount: true }).extend({ amountText: z.string(), suggestion: z.enum(['high', 'medium', 'low']).optional() })).max(200),
})

function importDraft(raw: unknown) {
  const parsed = draftSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  const saved = receiptSchema.safeParse(raw)
  return saved.success ? draftFromReceipt(saved.data) : null
}

function draftFromReceipt(receipt: Receipt): ReceiptDraft {
  const { total, items, budgetAmount, ...fields } = receipt
  return { ...fields, roundingEnabled: budgetAmount !== undefined, totalText: moneyInput(total),
    items: items.map(({ amount, ...item }) => ({ ...item, amountText: moneyInput(amount) })) }
}

function blankDraft(data: Snapshot, now: number): ReceiptDraft {
  const authorId = data.viewerId ?? data.members.find(member => member.active !== false && !member.placeholder)?.id ?? data.members[0]?.id
  return {
    id: makeId(), source: 'manual', store: '', date: toDay(now, data.profile.settings.timezone), totalText: '',
    memberId: authorId ?? '', authorId,
    note: '', mode: 'single', categoryId: null, items: [], mismatchAccepted: false,
  }
}

export function AddOperationChoice({ onClose, choose, fromDock }: { onClose: () => void; choose: (basis: OperationType | 'receipt') => void; fromDock?: boolean }) {
  return <Sheet title="Добавить операцию" onClose={onClose} layoutId={fromDock ? 'add-operation-glass' : undefined} className="receipt-choice-sheet"><div className="receipt-stack">
    <ReceiptAction icon={<ShoppingCart size={22}/>} title="Расход" description="Покупки, услуги и подписки" onClick={() => choose('expense')}/>
    <ReceiptAction icon={<ArrowDownLeft size={22}/>} title="Доход" description="Зарплата, переводы и возвраты" onClick={() => choose('income')}/>
    <ReceiptAction icon={<ReceiptText size={22}/>} title="Чек" description="Сканировать QR-код или загрузить фото" onClick={() => choose('receipt')} highlighted/>
  </div></Sheet>
}

function syncLabel(id: string, connection?: Connection | null) {
  if (connection?.mode !== 'active') return 'Сохранён на этом устройстве'
  if (connection.conflict?.mutation.kind === 'receipt' && connection.conflict.mutation.key === id) return 'Требуется решить конфликт синхронизации'
  if (connection.queue.some(mutation => mutation.kind === 'receipt' && mutation.key === id)) return 'Сохранён на устройстве · ожидает синхронизации'
  if (connection.records.some(record => record.kind === 'receipt' && record.key === id && record.value)) return 'Синхронизирован с общим бюджетом'
  return 'Сохранён на этом устройстве'
}

function ReceiptDistribution({ rows, data }: { rows: Transaction[]; data: Snapshot }) {
  return <div className="panel receipt-distribution">{rows.map(row => {
    const category = data.categories.find(item => item.id === row.categoryId)
    return <div key={row.id}>{category ? <CategoryIcon emoji={category.emoji} size={20}/> : <span className="receipt-symbol"><ArrowDownLeft size={19}/></span>}
      <span><strong>{category?.name || (row.type === 'income' ? 'Возврат по чеку' : 'Категория не выбрана')}</strong>
        {row.receiptRounding && <small>Округление чека</small>}
        {row.type === 'expense' && <ReceiptScopeBadge scope={receiptItemBudgetScope(row)}/>}</span>
      <strong className={row.type === 'income' ? 'positive' : undefined}>{(row.receiptRounding ? '+' : '') + money(row.amount)}</strong></div>
  })}</div>
}

function ReceiptAmounts({ total, fiscal, delta = 0, accounted = total }: {
  total: number; fiscal?: FiscalReceipt; delta?: number; accounted?: number
}) {
  return <dl className="panel meta-list" aria-label="Суммы чека">
    {fiscal && <div><dt>Сумма по QR-коду</dt><dd>{money(fiscal.total)}</dd></div>}
    <div><dt>Сумма чека</dt><dd>{money(total)}</dd></div>
    <div><dt>Округление</dt><dd>{(delta ? '+' : '') + money(delta)}</dd></div>
    <div><dt>Учтено в бюджете</dt><dd>{money(accounted)}</dd></div>
  </dl>
}

function withFiscal(draft: ReceiptDraft, fiscal: FiscalReceipt, photo = false): ReceiptDraft {
  return { ...draft, fiscal, source: photo ? 'combined' : 'qr', date: fiscal.date, totalText: moneyInput(fiscal.total),
    mode: fiscal.n === 2 || !draft.items.length ? 'single' : draft.mode, mismatchAccepted: false, adjustmentCategoryId: undefined,
    ...(fiscal.n === 2 && { budgetScope: undefined, items: draft.items.map(item => ({ ...item, budgetScope: undefined })) }) }
}

export function ReceiptFlow({ data, now, scope, connection, receipt, mutate, onClose, onOpen, onHistory, onBudget }: {
  data: Snapshot; now: number; scope: WorkspaceScope; connection?: Connection | null; receipt?: Receipt; mutate: Mutate; onClose: () => void;
  onOpen: (id: string) => void; onHistory: () => void; onBudget: () => void
}) {
  const [stage, setStage] = useState<Stage>(receipt ? 'items' : 'methods')
  const original = useRef(receipt).current
  const [draft, setDraft] = useState(() => original ? draftFromReceipt(original) : blankDraft(data, now))
  const [storedDraft, setStoredDraft] = useState<ReceiptDraft | null>(null)
  const [hasChanges, setHasChanges] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState('')
  const [duplicate, setDuplicate] = useState<Receipt | null>(null)
  const [possibleDuplicateAccepted, setPossibleDuplicateAccepted] = useState(false)
  const [working, setWorking] = useState(false)
  const [confirmRounding, setConfirmRounding] = useState(false)
  const [saved, setSaved] = useState<Receipt | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [editing, setEditing] = useState<DraftItem | null>(null)
  const [picker, setPicker] = useState<Picker | null>(null)
  const [creatingCategory, setCreatingCategory] = useState(false)
  const [returnStage, setReturnStage] = useState<Stage>('methods')
  const [file, setFile] = useState<File | null>(null)
  const [ocrText, setOcrText] = useState('')
  const [photoStop, setPhotoStop] = useState<'return' | 'unsupported' | null>(null)
  const [photoOptions, setPhotoOptions] = useState<PhotoOptions>(noPhotoOptions)
  const [progress, setProgress] = useState<{ stage: number; message: string; fraction?: number }>({ stage: 0, message: '' })
  const capture = useRef<HTMLInputElement>(null)
  const upload = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const running = useRef<AbortController | null>(null)
  const qrReadAttempt = useRef(0)
  const bufferedWrite = useRef<Promise<unknown>>(Promise.resolve())
  const cancelled = useRef(false)
  const busy = useRef(false)

  useEffect(() => {
    cancelled.current = false
    let current = true
    if (!original) void repository.loadReceiptDraft(scope).then(raw => {
      if (current) setStoredDraft(importDraft(raw))
    }).catch(() => { /* Import remains available if a draft can’t be loaded. */ })
    return () => { current = false; cancelled.current = true; running.current?.abort() }
  }, [scope, original])
  useLayoutEffect(() => { bodyRef.current?.closest('.sheet-content')?.scrollTo(0, 0) }, [stage, leaving])

  function go(next: Stage) { qrReadAttempt.current++; setError(''); setDuplicate(null); setConfirmRounding(false); setStage(next) }
  function queueWrite(work: () => Promise<unknown>) {
    const previous = bufferedWrite.current
    const result = previous.catch(() => undefined).then(work)
    bufferedWrite.current = result
    return result
  }
  function change(next: ReceiptDraft, resetAcknowledgment = false) {
    const value = resetAcknowledgment ? { ...next, mismatchAccepted: false, adjustmentCategoryId: undefined } : next
    setHasChanges(true)
    setDraft(value)
    if (resetAcknowledgment) setPossibleDuplicateAccepted(false)
    if (!original) void queueWrite(() => repository.saveReceiptDraft(scope, value)).catch(() => { /* Explicit draft save handles storage errors. */ })
  }
  function startPhoto(camera: boolean) {
    go('photo')
    if (camera) capture.current?.click()
    else upload.current?.click()
  }
  function pickPhoto(value: File) { setFile(value); setPhotoOptions(noPhotoOptions); setPhotoStop(null); go('photo') }
  function findFiscalDuplicate(fiscal: FiscalReceipt) {
    const key = fiscalReceiptKey(fiscal)
    return data.receipts?.find(item => item.id !== draft.id && fiscalReceiptKey(item.fiscal) === key)
  }
  function readQr(raw: string) {
    try {
      const fiscal = parseFiscalQr(raw)
      const existing = findFiscalDuplicate(fiscal)
      if (existing) { setDuplicate(existing); setError('Этот чек уже добавлен.'); return }
      if (fiscal.n > 2) { setError('Этот вид кассового расчёта пока не поддерживается.'); return }
      setPhotoStop(null)
      change(withFiscal(draft, fiscal), true)
      go('review')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось прочитать QR-код.') }
  }
  async function readQrImage(image: File) {
    const attempt = ++qrReadAttempt.current
    try {
      const prepared = await prepareReceiptImage(image)
      const raw = await readReceiptQr(prepared)
      if (cancelled.current || attempt !== qrReadAttempt.current) return
      if (raw) readQr(raw)
      else setError('QR-код на фото не найден. Попробуйте более чёткое изображение.')
    } catch { if (!cancelled.current && attempt === qrReadAttempt.current) setError('Не удалось открыть фото QR-кода.') }
  }
  async function process() {
    if (!file || running.current) return
    const controller = new AbortController()
    const { signal } = controller
    running.current = controller
    setProgress({ stage: 0, message: '' })
    go('processing')
    try {
      const prepared = await prepareReceiptImage(file, photoOptions)
      if (signal.aborted) return
      setProgress({ stage: 1, message: '' })
      // Check the full photo before cropping; the framing for OCR may exclude the QR.
      const qrImage = photoOptions.crop ? await prepareReceiptImage(file) : prepared
      if (signal.aborted) return
      const raw = await readReceiptQr(qrImage)
      if (signal.aborted) return
      let fiscal = draft.fiscal
      if (raw) {
        try { fiscal = parseFiscalQr(raw) } catch { /* A non-fiscal QR does not prevent OCR. */ }
      }
      let next = draft
      if (fiscal) {
        const other = draft.fiscal && fiscalReceiptKey(draft.fiscal) !== fiscalReceiptKey(fiscal)
        if (other) { go('photo'); setError('На фото другой чек. Загрузите фото чека, чей QR-код был считан.'); return }
        const existing = findFiscalDuplicate(fiscal)
        if (existing) { go('photo'); setDuplicate(existing); setError('Этот чек уже добавлен.'); return }
        if (fiscal.n > 2) { go('photo'); setError('Этот вид кассового расчёта пока не поддерживается.'); return }
        next = withFiscal(draft, fiscal, true)
      }
      setProgress({ stage: 2, message: '' })
      const content = await recognizeReceipt(prepared, signal, (message, fraction) => {
        if (!signal.aborted) setProgress({ stage: 2, message, fraction })
      })
      if (signal.aborted) return
      setProgress({ stage: 3, message: '' })
      const parsed = parseReceiptText(content)
      if (parsed.transactionType === 'other' || parsed.transactionType === 'return' && fiscal && fiscal.n !== 2) {
        go('photo')
        setPhotoStop('unsupported')
        setError(parsed.transactionType === 'other' ? 'Распознана коррекция или другой неподдерживаемый вид расчёта.' : 'В тексте чека указан возврат, а QR-код относится к покупке. Проверьте фото.')
        return
      }
      if (!fiscal && parsed.transactionType === 'return') {
        go('photo')
        setPhotoStop('return')
        setError('Чек похож на возврат. Считайте фискальный QR-код, чтобы проверить вид расчёта.')
        return
      }
      setPhotoStop(null)
      setProgress({ stage: 4, message: '' })
      setOcrText(content)
      const items = parsed.items.slice(0, 200).map(({ amount, ...item }) => {
        const suggestion = suggestReceiptCategory(item.name, data.categories, data.receiptRules ?? [])
        return { ...item, name: item.name.slice(0, 250), originalName: item.originalName.slice(0, 250), id: makeId(), categoryId: suggestion?.categoryId ?? null, suggestion: suggestion?.confidence, amountText: moneyInput(amount) }
      })
      const mode = next.fiscal?.n === 2 || !items.length ? 'single' : 'split'
      change({ ...next, source: fiscal ? 'combined' : 'photo', store: next.store || (parsed.store ?? '').slice(0, 150),
        date: fiscal?.date ?? parsed.date ?? next.date, totalText: fiscal ? moneyInput(fiscal.total) : parsed.total === undefined ? next.totalText : moneyInput(parsed.total),
        items: items.length ? items : next.items, mode, categoryId: mode === 'single' ? next.categoryId : null }, true)
      setSelected(new Set())
      go('items')
      if (!items.length) setError('Товары не распознаны. Проверьте фото или добавьте позиции вручную.')
      else if (parsed.items.length > 200) setError('Добавлены первые 200 распознанных позиций. Остальные строки доступны в тексте чека.')
    } catch {
      if (signal.aborted) return
      go('photo')
      setError(navigator.onLine ? 'Не удалось распознать чек. Попробуйте ещё раз или введите данные вручную.' : 'Ресурсы распознавания недоступны без сети. Можно ввести данные вручную.')
    } finally { if (running.current === controller) running.current = null }
  }
  function cancelProcess() { running.current?.abort(); running.current = null; go('photo') }
  function openEditor(item?: DraftItem) {
    setEditing(item ?? { id: makeId(), originalName: '', name: '', quantity: '1', amountText: '', categoryId: null, needsReview: false })
    go('item')
  }
  function chooseCategory(target: Picker) { setPicker(target); go('category') }
  function applyCategory(id: string | null) {
    if (picker?.type === 'item') {
      const ids = new Set(picker.ids)
      change({ ...draft, items: draft.items.map(item => ids.has(item.id) ? { ...item, categoryId: id, suggestion: undefined } : item) })
      setSelected(new Set())
      go('items')
    } else {
      change(picker?.type === 'single' ? { ...draft, categoryId: id } : { ...draft, adjustmentCategoryId: id ?? undefined })
      go('review')
    }
  }
  async function remember(match: ReceiptRule['match'], pattern: string, id: string) {
    return mutate(async workspace => {
      const { id: key, previous } = await ruleIdentity(data.receiptRules ?? [], match, pattern)
      await repository.putReceiptRule({ id: key, match, pattern, categoryId: id }, workspace, previous)
    }, 'Выбор запомнен')
  }
  function goBack() {
    if (stage === 'category') go(picker?.type === 'item' ? 'items' : 'review')
    else if (stage === 'item' || stage === 'scope') go('items')
    else if (stage === 'rules') go(returnStage)
    else if (stage === 'processing') cancelProcess()
    else if (stage === 'review' && (draft.items.length > 0 || original)) go('items')
    else if (stage === 'photo' && draft.fiscal) go('review')
    else if (stage === 'items' && original) exit()
    else go('methods')
  }
  function exit() {
    if (busy.current) return
    if (stage === 'processing') cancelProcess()
    if (hasChanges && !saved) setLeaving(true)
    else onClose()
  }

  const total = parseMoney(draft.totalText)
  const quantities = draft.items.map(item => parseMoney(item.amountText))
  const linesTotal = receiptItemsTotal(quantities.map(amount => ({ amount: amount ?? 0 })))
  const difference = total === null ? 0 : total - linesTotal
  const refund = draft.fiscal?.n === 2
  const category = data.categories.find(item => item.id === draft.categoryId)
  const adjustment = data.categories.find(item => item.id === draft.adjustmentCategoryId)
  const roundingEligible = !refund && draft.source !== 'manual'
  const roundingEnabled = roundingEligible && (draft.roundingEnabled ?? data.profile.settings.roundReceiptTotals ?? false)
  const budgetAmount = roundingEnabled && total !== null ? roundUpToRuble(total) : undefined
  const roundingDelta = budgetAmount !== undefined && total !== null ? budgetAmount - total : undefined
  const items = draft.items.map((item, index) => ({ id: item.id, originalName: item.originalName, name: item.name, quantity: item.quantity, unit: item.unit,
    unitPrice: item.unitPrice, discount: item.discount, categoryId: item.categoryId, needsReview: item.needsReview, amount: quantities[index] ?? 0,
    budgetScope: refund ? undefined : item.budgetScope }))
  const baseCategories = draft.mode === 'single' ? [draft.categoryId] : items.filter(item => item.amount > 0).map(item => item.categoryId)
  if (draft.mode === 'split' && difference > 0) baseCategories.push(draft.adjustmentCategoryId ?? null)
  const categoryDefault = baseCategories.length > 0 && baseCategories.every(id =>
    data.categories.find(item => item.id === id)?.defaultBudgetScope === 'monthly_only')
  const defaultScope = draft.budgetScope ?? (original || !categoryDefault ? 'weekly_and_monthly' : 'monthly_only')
  const mixedScopes = !refund && receiptItemBudgetScopes(items, defaultScope).size > 1
  const mode = refund ? 'single' : mixedScopes ? 'split' : draft.mode
  const adjustmentCategoryId = mode === 'split' && difference > 0 ? draft.adjustmentCategoryId : undefined
  const roundingCategoryId = mode === 'split' && roundingDelta
    ? draft.roundingCategoryId ?? defaultReceiptRoundingCategory({ items, adjustmentCategoryId }) ?? undefined
    : undefined
  const pending = draft.items.filter(item => item.needsReview || item.suggestion === 'low').length
  const candidate: Receipt | null = total !== null && quantities.every(amount => amount !== null) ? {
    id: draft.id, source: draft.source, fiscal: draft.fiscal, store: draft.store.trim(), date: draft.date, total,
    memberId: draft.memberId, authorId: draft.authorId, note: draft.note.trim(), mode,
    categoryId: mode === 'split' || refund ? null : draft.categoryId,
    adjustmentCategoryId, budgetAmount, roundingDelta, roundingCategoryId,
    budgetScope: refund ? undefined : draft.budgetScope ?? (defaultScope === 'monthly_only' ? defaultScope : undefined),
    mismatchAccepted: draft.items.length > 0 && difference !== 0 && draft.mismatchAccepted,
    items,
  } : null
  const checked = candidate && receiptSchema.safeParse(candidate)
  const distribution = checked?.success ? receiptOperations(checked.data) : []
  const possibleDuplicate = candidate && !candidate.fiscal && candidate.store && data.receipts?.find(other => other.id !== candidate.id &&
    other.total === candidate.total && other.date === candidate.date && normalizeProductName(other.store) === normalizeProductName(candidate.store) &&
    other.items.length > 0 && other.items.length === candidate.items.length && other.items.map(item => normalizeProductName(item.name) + ':' + item.amount).sort().join('|') ===
    candidate.items.map(item => normalizeProductName(item.name) + ':' + item.amount).sort().join('|'))
  async function save(roundingConfirmed = false) {
    if (busy.current) return
    setError('')
    if (total === null || total < 1) { setError('Укажите сумму чека больше нуля.'); return }
    if (!isDay(draft.date)) { setError('Укажите корректную дату.'); return }
    if (draft.fiscal) {
      const existing = findFiscalDuplicate(draft.fiscal)
      if (existing) { setDuplicate(existing); setError('Этот чек уже добавлен.'); return }
    }
    if (possibleDuplicate && !possibleDuplicateAccepted) { setError('Подтвердите, что это другая покупка.'); return }
    if (!checked?.success) { setError(checked?.error.issues[0]?.message ?? 'Проверьте суммы и количество товаров.'); return }
    const value = checked.data
    if (original && !roundingConfirmed && (original.budgetAmount !== value.budgetAmount ||
        original.roundingDelta !== value.roundingDelta || original.roundingCategoryId !== value.roundingCategoryId)) {
      setConfirmRounding(true)
      return
    }
    busy.current = true
    setWorking(true)
    const success = await mutate(workspace => repository.putReceipt(value, workspace, original))
    busy.current = false
    setWorking(false)
    if (!success) return
    setSaved(value)
    setHasChanges(false)
    setStoredDraft(null)
    setFile(null)
    setOcrText('')
    if (!original) void queueWrite(() => repository.deleteReceiptDraft(scope)).catch(() => undefined)
    if (original) onOpen(value.id)
    else go('success')
  }

  function reviewBody(): ReactNode {
    return <div className="receipt-stack">
      <ReceiptHeader store={draft.store} date={draft.date} time={draft.fiscal?.time} amount={total} refund={refund}/>
      {draft.source === 'qr' && !draft.items.length && <div className="receipt-notice"><p>Из QR-кода получены дата и сумма. Добавьте фото, чтобы распознать товары.</p>
        <button className="text-button" onClick={() => startPhoto(true)}><Camera size={18}/> Сфотографировать чек</button><button className="text-button" onClick={() => startPhoto(false)}>Загрузить фото</button></div>}
      <div className="form-fields inline-fields"><label className="field"><span>Магазин</span><input maxLength={150} placeholder="Необязательно" value={draft.store} onChange={event => change({ ...draft, store: event.target.value })}/></label>
        <label className="field"><span>Дата</span><input type="date" value={draft.date} readOnly={!!draft.fiscal} onChange={event => change({ ...draft, date: event.target.value })}/></label></div>
      <label className="field"><span>Итог чека, ₽</span><input inputMode="decimal" maxLength={16} value={draft.totalText} readOnly={!!draft.fiscal} placeholder="0,00" onChange={event => change({ ...draft, totalText: event.target.value }, true)}/></label>
      <div className="receipt-section-heading"><h3>Как учесть чек</h3><button className="text-button" onClick={() => go('items')}>{draft.items.length ? 'Изменить товары' : 'Добавить товары'}</button></div>
      {refund ? <p className="receipt-notice">Возврат будет учтён как доход.</p> : <div className="receipt-mode" role="group" aria-label="Как учесть чек">
        {([['split', 'По категориям'], ['single', 'Одной операцией']] as const).map(([option, title]) => <button key={option} className="secondary" aria-pressed={mode === option} disabled={option === 'split' ? !draft.items.length : mixedScopes}
          onClick={() => { if (option !== mode) change({ ...draft, mode: option }) }}>{title}</button>)}</div>}
      {mixedScopes && <p className="receipt-notice">Товары с разным учётом распределяются по категориям.</p>}
      {mode === 'single' && !refund && <ReceiptAction icon={category ? <CategoryIcon emoji={category.emoji} size={20}/> : <ReceiptText size={22}/>} title={category?.name ?? 'Выбрать категорию расхода'} onClick={() => chooseCategory({ type: 'single' })}/>}
      {!refund && <Toggle label={draft.items.length ? 'Только в месячном бюджете по умолчанию' : 'Только в месячном бюджете'}
        description={draft.items.length ? 'Для товаров без своего режима учёта' : undefined} checked={defaultScope === 'monthly_only'}
        onChange={value => change({ ...draft, budgetScope: value ? 'monthly_only' : 'weekly_and_monthly' })}/>}
      {draft.items.length > 0 && <div className={`receipt-notice ${difference ? 'receipt-warning' : ''}`}>
        <strong>{total === null ? 'Укажите итог для сверки' : difference ? `Расхождение ${money(Math.abs(difference))}` : 'Суммы совпадают'}</strong>
        <p>Товары {money(linesTotal)} · {draft.items.length} поз.</p>
        {difference !== 0 && <>
          <p>{mode === 'split' && difference < 0 ? mixedScopes
            ? 'Сумма товаров выше итога. Исправьте суммы позиций.'
            : 'Сумма товаров выше итога. Исправьте позиции или учтите чек одной операцией.'
            : mode === 'split' ? 'Выберите, на какую категорию отнести недостающую сумму.' : 'В бюджет будет записан итог чека.'}</p>
          {(mode === 'single' || difference > 0) && <label className="receipt-check"><input type="checkbox" checked={draft.mismatchAccepted} onChange={event => change({ ...draft, mismatchAccepted: event.target.checked })}/> Подтверждаю расхождение</label>}
          {difference > 0 && mode === 'split' && <button className="text-button" onClick={() => chooseCategory({ type: 'adjustment' })}>{adjustment?.name ?? 'Выбрать категорию для разницы'}</button>}
        </>}
      </div>}
      {pending > 0 && <p className="receipt-notice receipt-warning"><CircleAlert size={17}/> Требуют проверки: {pending}</p>}
      {roundingEligible && original && <Toggle label="Округлить этот чек" description="Вверх до целого рубля" checked={roundingEnabled}
        onChange={value => { setConfirmRounding(false); change({ ...draft, roundingEnabled: value }) }}/>}
      {roundingEligible && total !== null && <ReceiptAmounts total={total} fiscal={draft.fiscal} delta={roundingDelta} accounted={budgetAmount}/>}
      {mode === 'split' && !!roundingDelta && <label className="field"><span>Категория округления</span>
        <select value={roundingCategoryId ?? ''} onChange={event => change({ ...draft, roundingCategoryId: event.target.value || undefined })}>
          <option value="" disabled>Выберите категорию</option>
          {data.categories.filter(item => !item.archived || item.id === roundingCategoryId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>}
      {distribution.length > 0 && <><div className="receipt-section-heading"><h3>Распределение</h3><span>{new Set(distribution.flatMap(row => row.categoryId ? [row.categoryId] : [])).size} кат.</span></div><ReceiptDistribution rows={distribution} data={data}/></>}
      <label className="field"><span>{refund ? 'Кто получил' : 'Кто оплатил'}</span><select value={draft.memberId} onChange={event => change({ ...draft, memberId: event.target.value })}>{data.members.filter(member => member.active !== false || member.id === draft.memberId || member.placeholder).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      <label className="field"><span>Комментарий</span><input maxLength={300} placeholder="Необязательно" value={draft.note} onChange={event => change({ ...draft, note: event.target.value })}/></label>
      {possibleDuplicate && <div className="receipt-notice receipt-warning"><strong>Похожий чек уже есть в истории</strong>
        <button className="text-button" onClick={() => onOpen(possibleDuplicate.id)}>Посмотреть чек</button>
        <label className="receipt-check"><input type="checkbox" checked={possibleDuplicateAccepted} onChange={event => setPossibleDuplicateAccepted(event.target.checked)}/> Это другая покупка</label></div>}
    </div>
  }

  const currentItem = picker?.type === 'item' && picker.ids.length === 1 ? draft.items.find(item => item.id === picker.ids[0]) : undefined
  const onRules = () => { setReturnStage(stage); go('rules') }
  let body: ReactNode
  if (stage === 'methods') body = <ReceiptMethods onScan={() => go('scan')} onPhoto={startPhoto} onRules={onRules} hasDraft={!!storedDraft}
    onResume={() => { if (storedDraft) { setDraft(storedDraft); setHasChanges(true); go(storedDraft.items.length ? 'items' : 'review') } }} onManual={() => { if (!hasChanges) setDraft(blankDraft(data, now)); go('review') }}/>
  else if (stage === 'scan') body = <ReceiptScanner onRead={readQr} onImage={image => void readQrImage(image)} error={error} back={goBack}/>
  else if (stage === 'photo') body = <><ReceiptPhoto file={file} options={photoOptions} setOptions={setPhotoOptions} onCapture={() => capture.current?.click()}
    onUpload={() => upload.current?.click()} onProcess={() => void process()} error={error}/>
    {photoStop === 'return' && <button className="secondary full" onClick={() => go('scan')}>Сканировать QR-код</button>}
    {!photoStop && <button className="text-button receipt-centered" onClick={() => go('review')}>Ввести данные вручную</button>}</>
  else if (stage === 'processing') body = <ReceiptProcessing {...progress} cancel={cancelProcess}/>
  else if (stage === 'items') body = <div className="receipt-stack">
    <ReceiptHeader store={draft.store} date={draft.date} time={draft.fiscal?.time} amount={total} refund={refund}/>
    <ReceiptItemList items={draft.items} categories={data.categories} selected={selected} select={id => setSelected(previous => {
      if (id === 'all') return new Set(previous.size === draft.items.length ? [] : draft.items.map(item => item.id))
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })} edit={openEditor} pick={item => chooseCategory({ type: 'item', ids: [item.id] })} add={() => draft.items.length < 200 ? openEditor() : setError('Можно добавить до 200 позиций в чек.')} mass={() => chooseCategory({ type: 'item', ids: [...selected] })} rules={onRules}
      defaultScope={refund ? undefined : defaultScope} massScope={() => go('scope')}/>
    {file && <button className="text-button receipt-centered" onClick={() => go('photo')}>Вернуться к фотографии</button>}
    {ocrText && <details className="receipt-raw"><summary>Распознанный текст</summary><pre className="receipt-ocr-text">{ocrText}</pre></details>}
  </div>
  else if (stage === 'item' && editing) body = <ReceiptItemEditor key={editing.id} item={editing} defaultScope={refund ? undefined : defaultScope} onSave={item => {
    const previous = draft.items.some(row => row.id === item.id)
    const suggestion = !previous && suggestReceiptCategory(item.name, data.categories, data.receiptRules ?? [])
    const next = suggestion ? { ...item, categoryId: suggestion.categoryId, suggestion: suggestion.confidence } : item
    const previousItem = draft.items.find(row => row.id === item.id)
    change({ ...draft, items: previous ? draft.items.map(row => row.id === item.id ? next : row) : [...draft.items, next] }, previousItem?.amountText !== next.amountText)
    go('items')
  }} onDelete={draft.items.some(item => item.id === editing.id) ? () => {
    const items = draft.items.filter(item => item.id !== editing.id)
    change({ ...draft, items, mode: items.length ? draft.mode : 'single' }, true)
    setSelected(previous => new Set([...previous].filter(id => id !== editing.id)))
    go('items')
  } : undefined}/>
  else if (stage === 'category' && picker) body = <CategoryPicker categories={data.categories}
    current={picker.type === 'single' ? draft.categoryId : picker.type === 'adjustment' ? draft.adjustmentCategoryId : currentItem?.categoryId}
    name={currentItem?.name || (picker.type === 'item' && picker.ids.length > 1 ? `Выбрано товаров: ${picker.ids.length}` : undefined)}
    onChoose={applyCategory} onCreate={() => setCreatingCategory(true)} onRemember={currentItem?.name ? remember : undefined}/>
  else if (stage === 'scope') body = <ReceiptBulkScope count={selected.size} defaultScope={defaultScope} onApply={budgetScope => {
    change({ ...draft, items: draft.items.map(item => selected.has(item.id) ? { ...item, budgetScope } : item) })
    setSelected(new Set())
    go('items')
  }}/>
  else if (stage === 'review') body = reviewBody()
  else if (stage === 'rules') body = <ReceiptRules data={data} mutate={mutate}/>
  else if (stage === 'success' && saved) body = <div className="receipt-stack receipt-success">
    <motion.span className="receipt-success-icon" initial={{ scale: .83, opacity: .5 }} animate={{ scale: 1, opacity: 1 }}><Check size={44} strokeWidth={2.4}/></motion.span>
    <h3>{saved.fiscal?.n === 2 ? 'Возврат добавлен' : 'Расходы добавлены'}</h3><strong>{money(saved.budgetAmount ?? saved.total)}</strong>
    {!!saved.roundingDelta && <p>Сумма чека {money(saved.total)}</p>}
    <p>{saved.items.length} поз. · {new Set(receiptOperations(saved).flatMap(row => row.categoryId ? [row.categoryId] : [])).size} кат.</p><p className="receipt-notice">{syncLabel(saved.id, connection)}</p>
    <div className="receipt-stack"><button className="secondary full" onClick={onHistory}>Посмотреть в истории</button><button className="primary full" onClick={() => {
      setDraft(blankDraft(data, now)); setSaved(null); setSelected(new Set()); setPossibleDuplicateAccepted(false); setPhotoStop(null); setOcrText(''); go('methods')
    }}>Добавить ещё чек</button><button className="text-button receipt-centered" onClick={onBudget}>Вернуться в бюджет</button></div>
  </div>

  const footer = !leaving && stage === 'items' ? <button className="primary full" onClick={() => go('review')}>Продолжить</button>
    : !leaving && stage === 'review' ? <div className="receipt-stack">
        {error && <p className="form-error" role="alert">{error}</p>}
        {duplicate && <button className="secondary full" onClick={() => onOpen(duplicate.id)}>Открыть добавленный чек</button>}
        {confirmRounding ? <div className="confirm-box"><strong>Изменить округление чека?</strong>
          <p>В бюджете будет учтено {total === null ? '—' : money(budgetAmount ?? total)}.
            {roundingCategoryId && ` Категория округления: ${data.categories.find(item => item.id === roundingCategoryId)?.name ?? '—'}.`}</p>
          <div className="actions">
            <button className="secondary" disabled={working} onClick={() => setConfirmRounding(false)}>Отмена</button>
            <button className="primary" disabled={working} onClick={() => void save(true)}>Подтвердить изменение</button>
          </div>
        </div> : <button className="primary full" disabled={working} onClick={() => void save()}>{working ? 'Сохраняем…' : original ? 'Сохранить изменения' : 'Сохранить чек'}</button>}
      </div> : undefined

  return <><Sheet title={leaving ? 'Выйти из импорта?' : stage === 'item' && !editing?.originalName ? 'Добавить товар' : titles[stage]} onClose={exit}
    onRequestClose={hasChanges || stage === 'processing' ? exit : undefined}
    dismissible={!working && !leaving} footer={footer} className={`receipt-sheet receipt-stage-${stage}`}>
    <input type="file" accept="image/*" capture="environment" aria-label="Камера для чека" ref={capture} className="sr-only" tabIndex={-1} onChange={event => selectedFile(event, pickPhoto)}/>
    <input type="file" accept="image/*" aria-label="Файл фото чека" ref={upload} className="sr-only" tabIndex={-1} onChange={event => selectedFile(event, pickPhoto)}/>
    <motion.div key={leaving ? 'exit' : stage} ref={bodyRef} className="receipt-stack" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={screenTransition}>
      {leaving ? <div className="receipt-stack"><p className="receipt-notice">{original ? 'Изменения чека ещё не сохранены.' : 'Сохраните черновик, чтобы продолжить позже.'}</p>
        <button className="secondary full" disabled={working} onClick={() => setLeaving(false)}>Продолжить импорт</button>
        {!original && <button className="primary full" disabled={working} onClick={async () => {
          setWorking(true)
          try { await queueWrite(() => repository.saveReceiptDraft(scope, draft)); onClose() }
          catch { setError('Не удалось сохранить черновик.'); setWorking(false) }
        }}>Сохранить черновик и выйти</button>}
        <button className="text-button negative receipt-centered" disabled={working} onClick={async () => {
          setWorking(true)
          try { if (!original) await queueWrite(() => repository.deleteReceiptDraft(scope)); onClose() }
          catch { setError('Не удалось удалить черновик.'); setWorking(false) }
        }}>Выйти без сохранения</button>
      </div> : <>
        {stage !== 'methods' && stage !== 'success' && <div className="receipt-top"><button className="text-button" disabled={working} onClick={goBack}><ChevronLeft size={19}/> Назад</button></div>}
        {body}
      </>}
      {error && (leaving || stage !== 'scan' && stage !== 'photo' && stage !== 'review') && <p className="form-error" role="alert">{error}</p>}
      {duplicate && !leaving && stage !== 'review' && <button className="secondary full" onClick={() => onOpen(duplicate.id)}>Открыть добавленный чек</button>}
    </motion.div>
  </Sheet>{creatingCategory && <CategoryEditor onClose={() => setCreatingCategory(false)} mutate={mutate}/>}</>
}

export function SavedReceipt({ data, receipt, connection, mutate, onClose, onEdit }: {
  data: Snapshot; receipt: Receipt; connection?: Connection | null; mutate: Mutate; onClose: () => void; onEdit: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const member = data.members.find(item => item.id === receipt.memberId)
  const author = data.members.find(item => item.id === receipt.authorId)
  const refund = receipt.fiscal?.n === 2
  const rows = receiptOperations(receipt)
  return <Sheet title="Чек" onClose={onClose} className="receipt-sheet receipt-stage-detail" dismissible={!busy}>
    <div className="receipt-stack">
      <ReceiptHeader store={receipt.store} date={receipt.date} time={receipt.fiscal?.time} amount={receipt.total} refund={refund}/>
      {!refund && receipt.source !== 'manual' && <ReceiptAmounts total={receipt.total} fiscal={receipt.fiscal} delta={receipt.roundingDelta} accounted={receipt.budgetAmount}/>}
      <dl className="panel meta-list">{member && <div><dt>{refund ? 'Получил' : 'Оплатил'}</dt><dd><Avatar member={member}/> {member.name}</dd></div>}
        {author && <div><dt>Добавил</dt><dd>{author.name}</dd></div>}{receipt.note && <div><dt>Комментарий</dt><dd>{receipt.note}</dd></div>}
        {rows.every(row => row.budgetScope === 'monthly_only') && <div><dt>Бюджет</dt><dd><MonthlyOnlyBadge/></dd></div>}
        <div><dt>Синхронизация</dt><dd>{syncLabel(receipt.id, connection)}</dd></div>
        {receipt.mismatchAccepted && <div><dt>Сверка</dt><dd>Расхождение подтверждено</dd></div>}</dl>
      <div className="receipt-section-heading"><h3>Распределение</h3></div><ReceiptDistribution data={data} rows={rows}/>
      {!!receipt.items.length && <><div className="receipt-section-heading"><h3>Товары <span>{receipt.items.length}</span></h3></div>
        <div className="panel receipt-distribution">{receipt.items.map(item => {
          const category = data.categories.find(entry => entry.id === item.categoryId)
          return <div key={item.id}><CategoryIcon emoji={category?.emoji} size={20}/><span><strong>{item.name}</strong><small>{item.quantity}{item.unit && ' ' + item.unit} · {category?.name || 'Без категории'}{item.needsReview && ' · Проверить'}</small>
            {!refund && <ReceiptScopeBadge scope={receiptItemBudgetScope(item, receipt.budgetScope)}/>}</span><strong>{money(item.amount)}</strong></div>
        })}</div></>}
      {confirm ? <div className="confirm-box"><strong>Удалить чек?</strong><p>Связанные операции будут удалены, бюджет пересчитается.</p><div className="actions"><button className="secondary" onClick={() => setConfirm(false)} disabled={busy}>Отмена</button>
        <button className="danger-button" disabled={busy} onClick={async () => {
          setBusy(true)
          if (await mutate(scope => repository.deleteReceipt(receipt.id, scope, receipt), 'Чек удалён')) onClose()
          else setBusy(false)
        }}>Удалить чек</button></div></div> : <div className="actions"><button className="secondary" onClick={() => setConfirm(true)}><Trash2 size={17}/> Удалить</button>
        <button className="primary" onClick={onEdit}><SquarePen size={17}/> Редактировать</button></div>}
    </div>
  </Sheet>
}
