import { receiptOcrDirectory } from './ocr-assets'

const maxPhotoBytes = 25 * 1024 * 1024
const maxPhotoPixels = 52_000_000
const maxPreparedPixels = 4_000_000
const maxPreparedEdge = 3_600

type Crop = { left: number; top: number; right: number; bottom: number }
export type ReceiptImageOptions = { rotation?: number; contrast?: number; crop?: Crop }
type OcrProgress = (status: string, progress?: number) => void

function checkPhoto(blob: Blob): void {
  if (!blob.size) throw new Error('Файл изображения пуст.')
  if (blob.size > maxPhotoBytes) throw new Error('Выберите изображение размером до 25 МБ.')
}

function imageContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!context) throw new Error('Браузер не смог обработать изображение.')
  return context
}

function cropBounds(crop: Crop | undefined, width: number, height: number) {
  const { left, top, right, bottom } = crop ?? { left: 0, top: 0, right: 1, bottom: 1 }
  if (![left, top, right, bottom].every((value) => Number.isFinite(value) && value >= 0 && value <= 1) || left >= right || top >= bottom) {
    throw new Error('Границы обрезки выходят за пределы фотографии.')
  }
  const x = Math.floor(width * left)
  const y = Math.floor(height * top)
  return { x, y, width: Math.ceil(width * right) - x, height: Math.ceil(height * bottom) - y }
}

function adjustContrast(context: CanvasRenderingContext2D, width: number, height: number, contrast: number): void {
  if (contrast === 1) return
  const image = context.getImageData(0, 0, width, height)
  const factor = Math.min(3, Math.max(0.5, contrast))
  const levels = Uint8ClampedArray.from({ length: 256 }, (_, value) => (value - 128) * factor + 128)
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = levels[image.data[index]]
    image.data[index + 1] = levels[image.data[index + 1]]
    image.data[index + 2] = levels[image.data[index + 2]]
  }
  context.putImageData(image, 0, 0)
}

async function withImageCanvas<T>(blob: Blob, options: ReceiptImageOptions, use: (canvas: HTMLCanvasElement) => T | Promise<T>): Promise<T> {
  checkPhoto(blob)
  const rotation = options.rotation ?? 0
  const contrast = options.contrast ?? 1
  if (!Number.isFinite(rotation) || rotation % 90 || !Number.isFinite(contrast)) throw new Error('Проверьте настройки обработки изображения.')

  const url = URL.createObjectURL(blob)
  const image = new Image()
  const canvas = document.createElement('canvas')
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Браузер не открыл фото. Попробуйте выбрать изображение JPEG или PNG.'))
      image.src = url
    })
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > maxPhotoPixels) {
      throw new Error('Разрешение фотографии слишком велико. Выберите изображение меньшего размера.')
    }
    const crop = cropBounds(options.crop, image.naturalWidth, image.naturalHeight)
    const scale = Math.min(1, maxPreparedEdge / Math.max(crop.width, crop.height), Math.sqrt(maxPreparedPixels / (crop.width * crop.height)))
    const width = Math.max(1, Math.floor(crop.width * scale))
    const height = Math.max(1, Math.floor(crop.height * scale))
    const swapped = Math.abs(rotation % 180) === 90
    canvas.width = swapped ? height : width
    canvas.height = swapped ? width : height

    const context = imageContext(canvas)
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.imageSmoothingQuality = 'high'
    context.save()
    context.translate(canvas.width / 2, canvas.height / 2)
    context.rotate((rotation % 360) * Math.PI / 180)
    context.drawImage(image, crop.x, crop.y, crop.width, crop.height, -width / 2, -height / 2, width, height)
    context.restore()
    image.removeAttribute('src')
    adjustContrast(context, canvas.width, canvas.height, contrast)
    return await use(canvas)
  } finally {
    URL.revokeObjectURL(url)
    canvas.width = 0
    canvas.height = 0
  }
}

export async function prepareReceiptImage(file: Blob, options: ReceiptImageOptions = {}): Promise<Blob> {
  return withImageCanvas(file, options, (canvas) => new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Не удалось подготовить изображение.')), 'image/jpeg', 0.92)
  }))
}

function didNotReadQr(error: unknown): boolean {
  const kind = (error as { getKind?: () => string } | null)?.getKind?.()
  return kind === 'NotFoundException' || kind === 'ChecksumException' || kind === 'FormatException'
}

export async function readReceiptQr(blob: Blob): Promise<string | null> {
  const { BrowserQRCodeReader } = await import('@zxing/browser')
  const reader = new BrowserQRCodeReader()
  const decode = (canvas: HTMLCanvasElement) => {
    try {
      return reader.decodeFromCanvas(canvas).getText()
    } catch (error) {
      if (didNotReadQr(error)) return null
      throw error
    }
  }

  return withImageCanvas(blob, {}, (canvas) => {
    const fullQr = decode(canvas)
    if (fullQr || Math.min(canvas.width, canvas.height) < 320) return fullQr

    // Fiscal codes printed near a receipt's edge can be small compared to the full photo.
    const regions: Crop[] = [
      { left: .44, top: .58, right: 1, bottom: 1 },
      { left: 0, top: .58, right: .56, bottom: 1 },
      { left: .22, top: .58, right: .78, bottom: 1 },
      { left: .44, top: 0, right: 1, bottom: .62 },
      { left: 0, top: 0, right: .56, bottom: .62 },
    ]
    const zoom = document.createElement('canvas')
    try {
      const context = imageContext(zoom)
      const border = 20
      for (const region of regions) {
        const crop = cropBounds(region, canvas.width, canvas.height)
        const scale = Math.min(2, Math.sqrt(1_500_000 / (crop.width * crop.height)))
        const width = Math.floor(crop.width * scale)
        const height = Math.floor(crop.height * scale)
        zoom.width = width + border * 2
        zoom.height = height + border * 2
        context.fillStyle = '#fff'
        context.fillRect(0, 0, zoom.width, zoom.height)
        context.drawImage(canvas, crop.x, crop.y, crop.width, crop.height, border, border, width, height)
        const qr = decode(zoom)
        if (qr) return qr
      }
      return null
    } finally {
      zoom.width = 0
      zoom.height = 0
    }
  })
}

export async function scanReceiptCamera(video: HTMLVideoElement, onRead: (raw: string) => void, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Камера недоступна. Откройте бюджет по HTTPS или выберите фотографию.')
  const { BrowserQRCodeReader } = await import('@zxing/browser')
  if (signal.aborted) return
  const reader = new BrowserQRCodeReader()

  return new Promise<void>((resolve, reject) => {
    const canvas = document.createElement('canvas')
    const context = imageContext(canvas)
    let stream: MediaStream | undefined
    let finished = false
    let nextFrame: ReturnType<typeof setTimeout> | undefined
    let startTimeout: ReturnType<typeof setTimeout> | undefined

    const finish = (error?: unknown, raw?: string) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abort)
      window.removeEventListener('pagehide', abort)
      clearTimeout(nextFrame)
      clearTimeout(startTimeout)
      for (const track of stream?.getTracks() ?? []) {
        track.removeEventListener('ended', cameraLost)
        track.stop()
      }
      if (stream && video.srcObject === stream) {
        video.pause()
        video.srcObject = null
      }
      canvas.width = 0
      canvas.height = 0
      if (error !== undefined) {
        reject(error)
        return
      }
      try {
        if (raw) onRead(raw)
        resolve()
      } catch (callbackError) {
        reject(callbackError)
      }
    }
    const abort = () => finish()
    const cameraLost = () => finish(new Error('Доступ к камере прерван. Попробуйте снова или выберите фото.'))

    const scanFrame = () => {
      if (finished) return
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight))
        const width = Math.max(1, Math.floor(video.videoWidth * scale))
        const height = Math.max(1, Math.floor(video.videoHeight * scale))
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }
        try {
          context.drawImage(video, 0, 0, width, height)
          const raw = reader.decodeFromCanvas(canvas).getText()
          finish(undefined, raw)
          return
        } catch (error) {
          if (!didNotReadQr(error)) { finish(error); return }
        }
      }
      nextFrame = setTimeout(scanFrame, 200)
    }

    signal.addEventListener('abort', abort, { once: true })
    window.addEventListener('pagehide', abort, { once: true })
    void navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    }).then(async (result) => {
      if (finished) {
        for (const track of result.getTracks()) track.stop()
        return
      }
      stream = result
      for (const track of result.getVideoTracks()) track.addEventListener('ended', cameraLost, { once: true })
      video.playsInline = true
      video.muted = true
      video.srcObject = result
      startTimeout = setTimeout(cameraLost, 12_000)
      await video.play()
      clearTimeout(startTimeout)
      scanFrame()
    }).catch(finish)
  })
}

type WorkerStage = 'load' | 'loadLanguage' | 'initialize' | 'recognize'
type WorkerMessage = {
  jobId: string
  status: 'progress' | 'resolve' | 'reject'
  data?: { status?: string; progress?: number; text?: string }
}

const ocrStatuses: Record<string, string> = {
  'loading tesseract core': 'Загружаем модуль распознавания',
  'initializing tesseract': 'Запускаем модуль распознавания',
  'loading language traineddata': 'Загружаем русский и английский словари',
  'initializing api': 'Подготавливаем распознавание',
  'recognizing text': 'Распознаём текст чека',
}

function cancelled(): DOMException {
  return new DOMException('Обработка отменена.', 'AbortError')
}

function runOcrJob(worker: Worker, action: WorkerStage, payload: object, signal: AbortSignal, progress: OcrProgress, transfer: Transferable[] = []): Promise<WorkerMessage['data']> {
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', abort)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.removeEventListener('messageerror', onError)
    }
    const abort = () => { cleanup(); reject(cancelled()) }
    const onError = (event: Event) => {
      event.preventDefault()
      cleanup()
      reject(new Error('Модуль распознавания недоступен. Для первой загрузки подключитесь к интернету или введите данные вручную.'))
    }
    const onMessage = ({ data }: MessageEvent<WorkerMessage>) => {
      if (data.jobId !== action) return
      if (data.status === 'progress') {
        const status = data.data?.status && ocrStatuses[data.data.status]
        if (status) progress(status, data.data?.progress)
        return
      }
      cleanup()
      if (data.status === 'resolve') resolve(data.data)
      else reject(new Error(action === 'recognize'
        ? 'Не удалось прочитать изображение. Попробуйте другое фото или введите данные вручную.'
        : 'Не удалось загрузить модуль и словари. Для первой загрузки подключитесь к интернету.'))
    }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.addEventListener('messageerror', onError)
    signal.addEventListener('abort', abort, { once: true })
    try {
      worker.postMessage({ workerId: 'receipt-ocr', jobId: action, action, payload }, transfer)
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

export async function recognizeReceipt(blob: Blob, signal: AbortSignal, progress: OcrProgress): Promise<string> {
  if (signal.aborted) throw cancelled()
  checkPhoto(blob)
  const base = new URL(receiptOcrDirectory, new URL(import.meta.env.BASE_URL, window.location.origin))
  // Own the worker from startup so cancellation also stops loading WASM or dictionaries.
  // The RPC below follows Tesseract.js 7's worker protocol; its version is pinned in package.json.
  const worker = new Worker(new URL('worker.min.js', base))
  const langs = ['rus', 'eng']
  try {
    progress('Загружаем модуль распознавания')
    await runOcrJob(worker, 'load', { options: { corePath: base.href, lstmOnly: true, logging: false } }, signal, progress)
    await runOcrJob(worker, 'loadLanguage', { langs, options: { langPath: base.href, gzip: true, cacheMethod: 'none', lstmOnly: true } }, signal, progress)
    await runOcrJob(worker, 'initialize', { langs, oem: 1 }, signal, progress)
    const buffer = await blob.arrayBuffer()
    const data = await runOcrJob(worker, 'recognize', {
      image: new Uint8Array(buffer),
      options: { tessedit_pageseg_mode: '6', preserve_interword_spaces: '1', user_defined_dpi: '240' },
      output: { text: true },
    }, signal, progress, [buffer])
    return data?.text?.trim() ?? ''
  } finally {
    worker.terminate()
  }
}
