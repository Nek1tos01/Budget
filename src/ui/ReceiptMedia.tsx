import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { Camera, Check, ChevronRight, Crop, ImageUp, PenLine, QrCode, ReceiptText, RotateCw, ScanLine } from 'lucide-react'
import { prepareReceiptImage, scanReceiptCamera } from '../receipts/media'
import { spring } from './shared'

export type PhotoOptions = NonNullable<Parameters<typeof prepareReceiptImage>[1]>

export function ReceiptAction({ icon, title, description, onClick, highlighted }: {
  icon: ReactNode; title: string; description?: string; onClick: () => void; highlighted?: boolean
}) {
  return <motion.button type="button" aria-label={title} className={`receipt-action${highlighted ? ' receipt-action-highlight' : ''}`}
    whileTap={{ scale: .975 }} transition={spring} onClick={onClick}>
    <span className="receipt-action-icon">{icon}</span><span className="receipt-action-label"><strong>{title}</strong>{description && <small>{description}</small>}</span><ChevronRight size={18} className="receipt-action-arrow"/>
  </motion.button>
}

export function ReceiptMethods({ onScan, onPhoto, onManual, onRules, hasDraft, onResume }: {
  onScan: () => void; onPhoto: (camera: boolean) => void; onManual: () => void; onRules: () => void; hasDraft: boolean; onResume: () => void
}) {
  return <div className="receipt-stack">
    <div className="receipt-intro"><div className="receipt-paper" aria-hidden="true"><ReceiptText size={56} strokeWidth={1.5}/><QrCode size={23}/></div>
      <h3>Добавьте чек из магазина</h3><p>QR-код даст дату и сумму покупки. С фото можно распознать товары и распределить их по категориям.</p></div>
    {hasDraft && <button className="secondary full" onClick={onResume}>Продолжить черновик</button>}
    <ReceiptAction icon={<ScanLine size={22}/>} title="Сканировать QR-код" onClick={onScan} highlighted/>
    <ReceiptAction icon={<Camera size={22}/>} title="Сфотографировать чек" onClick={() => onPhoto(true)}/>
    <ReceiptAction icon={<ImageUp size={22}/>} title="Загрузить фото" onClick={() => onPhoto(false)}/>
    <ReceiptAction icon={<PenLine size={21}/>} title="Ввести данные вручную" onClick={onManual}/>
    <button className="text-button receipt-centered" onClick={onRules}>Правила категорий</button>
  </div>
}

export function selectedFile(event: ChangeEvent<HTMLInputElement>, onSelect: (file: File) => void) {
  const file = event.currentTarget.files?.[0]
  event.currentTarget.value = ''
  if (file) onSelect(file)
}

export function ReceiptScanner({ onRead, onImage, error, back }: {
  onRead: (raw: string) => void; onImage: (file: File) => void; error: string; back: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listener = useRef(onRead)
  const [attempt, setAttempt] = useState(0)
  const [cameraError, setCameraError] = useState('')
  const [raw, setRaw] = useState('')
  useEffect(() => { listener.current = onRead }, [onRead])
  useEffect(() => {
    if (!video.current) return
    const controller = new AbortController()
    void Promise.resolve(scanReceiptCamera(video.current, value => listener.current(value), controller.signal)).catch((cause: unknown) => {
      if (controller.signal.aborted) return
      setCameraError(cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'SecurityError')
        ? 'Нет разрешения на камеру. Проверьте настройки браузера или загрузите фото QR-кода.'
        : 'Камера недоступна. Можно загрузить фото QR-кода.')
    })
    return () => controller.abort()
  }, [attempt])

  return <div className="receipt-stack">
    <div className="receipt-scanner"><video ref={video} muted autoPlay playsInline aria-hidden="true"/>
      <div className="receipt-scan-frame" aria-hidden="true"><i/><i/><i/><i/></div><span><ScanLine size={16}/> Наведите камеру на QR-код чека</span></div>
    {(error || cameraError) && <p className="form-error" role="alert">{error || cameraError}</p>}
    <button className="secondary full" onClick={() => { setCameraError(''); setAttempt(value => value + 1) }}>Повторить сканирование</button>
    <button className="secondary full" onClick={() => input.current?.click()}><ImageUp size={19}/> Загрузить фото QR-кода</button>
    <input ref={input} type="file" accept="image/*" aria-label="Файл QR-кода" className="sr-only" tabIndex={-1} onChange={event => selectedFile(event, onImage)}/>
    <details className="receipt-raw"><summary>Вставить строку QR-кода</summary><form className="receipt-stack" onSubmit={event => { event.preventDefault(); onRead(raw) }}>
      <label className="field"><span>Строка QR-кода</span><input value={raw} onChange={event => setRaw(event.target.value)} spellCheck={false} autoCapitalize="none" maxLength={600}/></label>
      <button className="secondary" disabled={!raw.trim()}>Прочитать QR-код</button>
    </form></details>
    <button className="text-button receipt-centered" onClick={back}>Остановить сканирование</button>
  </div>
}

export function ReceiptPhoto({ file, options, setOptions, onCapture, onUpload, onProcess, error }: {
  file: File | null; options: PhotoOptions; setOptions: (value: PhotoOptions) => void; onCapture: () => void; onUpload: () => void;
  onProcess: () => void; error: string
}) {
  const [preview, setPreview] = useState('')
  const [previewError, setPreviewError] = useState(false)
  useEffect(() => {
    if (!file) return
    let active = true
    let url = ''
    const timer = setTimeout(() => {
      void prepareReceiptImage(file, options).then(blob => {
        if (!active) return
        url = URL.createObjectURL(blob)
        setPreview(url)
        setPreviewError(false)
      }).catch(() => { if (active) setPreviewError(true) })
    }, 120)
    return () => { active = false; clearTimeout(timer); if (url) URL.revokeObjectURL(url) }
  }, [file, options])

  return <div className="receipt-stack">
    <div className="receipt-photo-preview">
      {file && preview && !previewError ? <img src={preview} alt="Предпросмотр подготовленного чека"/> : <div><Camera size={40} strokeWidth={1.5}/><p>{file && !previewError ? 'Подготавливаем предпросмотр…' : 'Уместите чек целиком и убедитесь, что итог читается.'}</p></div>}
    </div>
    {file && <div className="receipt-photo-tools">
      <button className="secondary" onClick={() => setOptions({ ...options, rotation: ((options.rotation ?? 0) + 90) % 360 })}><RotateCw size={17}/> Повернуть</button>
      <label className="receipt-range"><span>Контраст</span><input type="range" min="0.8" max="2" step="0.1" value={options.contrast ?? 1} onChange={event => setOptions({ ...options, contrast: Number(event.target.value) })}/></label>
      <details className="receipt-raw"><summary><Crop size={16}/> Обрезать края</summary><div className="receipt-crop-tools">
        {([{ label: 'Слева', edge: 'left' }, { label: 'Справа', edge: 'right' }, { label: 'Сверху', edge: 'top' }, { label: 'Снизу', edge: 'bottom' }] as const).map(({ label, edge }) => {
          const fromFarEdge = edge === 'right' || edge === 'bottom'
          const crop = options.crop ?? { left: 0, top: 0, right: 1, bottom: 1 }
          return <label key={edge} className="receipt-range"><span>{label}</span><input type="range" min="0" max="0.4" step="0.02" value={fromFarEdge ? 1 - crop[edge] : crop[edge]}
            onChange={event => setOptions({ ...options, crop: { ...crop, [edge]: fromFarEdge ? 1 - Number(event.target.value) : Number(event.target.value) } })}/></label>
        })}
      </div></details>
    </div>}
    {(error || previewError) && <p className="form-error" role="alert">{error || 'Не удалось открыть изображение. Попробуйте другую фотографию.'}</p>}
    <div className="receipt-photo-select"><button className="secondary" onClick={onCapture}><Camera size={18}/> {file ? 'Переснять' : 'Снять чек'}</button>
      <button className="secondary" onClick={onUpload}><ImageUp size={18}/> Выбрать фото</button></div>
    {file && <button className="primary full" disabled={previewError || !preview} onClick={onProcess}>Распознать чек</button>}
  </div>
}

const stages = ['Подготавливаем изображение', 'Проверяем QR-код', 'Распознаём текст', 'Извлекаем товары', 'Сверяем суммы и подбираем категории']

export function ReceiptProcessing({ stage, message, fraction, cancel }: { stage: number; message: string; fraction?: number; cancel: () => void }) {
  return <div className="receipt-stack receipt-processing" aria-busy="true">
    <div className="receipt-spinner" aria-hidden="true"><ReceiptText size={43} strokeWidth={1.5}/></div>
    <p role="status">{message || stages[stage]}</p>
    {fraction !== undefined && <progress aria-label="Ход текущего этапа" value={fraction} max={1}/>}
    <ol>{stages.map((label, index) => <li key={label} aria-current={stage === index ? 'step' : undefined}><span>{index < stage ? <Check size={14}/> : index === stage ? <i className="receipt-mini-spinner"/> : <i/>}</span>{label}</li>)}</ol>
    <button className="secondary full" onClick={cancel}>Отменить обработку</button>
  </div>
}
