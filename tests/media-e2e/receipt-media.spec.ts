import { expect, test } from '@playwright/test'
import { BarcodeFormat, QRCodeWriter } from '@zxing/library'
import { syntheticReceiptPhoto } from '../fixtures/receipt-photo'

const rawQr = 't=20261120T1742&s=189.90&fn=000110000105&i=12345678&fp=123456&n=1'
const mediaPath = '/src/receipts/media.ts'
const parserPath = '/src/receipts/ocr-parser.ts'

function receiptQrPixels(): boolean[] {
  const matrix = new QRCodeWriter().encode(rawQr, BarcodeFormat.QR_CODE, 220, 220, new Map())
  return Array.from({ length: 220 * 220 }, (_, index) => matrix.get(index % 220, Math.floor(index / 220)))
}

test.beforeEach(async ({ page }) => {
  await page.route('**/receipt-media-test', (route) => route.fulfill({ body: '<!doctype html><title>Receipt media test</title>', contentType: 'text/html' }))
  await page.goto('/receipt-media-test')
})

test('recognizes a synthetic Russian receipt in a local browser worker', async ({ page, context }) => {
  const requests: string[] = []
  context.on('request', (request) => requests.push(request.url()))
  const image = (await syntheticReceiptPhoto(page)).toString('base64')
  const result = await page.evaluate(async ({ image, mediaPath, parserPath }) => {
    const { prepareReceiptImage, recognizeReceipt } = await import(mediaPath) as typeof import('../../src/receipts/media')
    const { parseReceiptText } = await import(parserPath) as typeof import('../../src/receipts/ocr-parser')
    const blob = new Blob([Uint8Array.from(atob(image), (char) => char.charCodeAt(0))], { type: 'image/jpeg' })
    const prepared = await prepareReceiptImage(blob, { rotation: 0, contrast: 1.15 })
    const progress: string[] = []
    const text = await recognizeReceipt(prepared, new AbortController().signal, (status) => progress.push(status))
    return { parsed: parseReceiptText(text), progress, text }
  }, { image, mediaPath, parserPath })

  expect(result.parsed, result.text).toMatchObject({
    date: '2026-11-20', total: 18990,
    items: [{ name: 'Молоко пастеризованное', amount: 8990 }, { name: 'Хлеб ржаной', amount: 10000 }],
  })
  expect(result.progress).toContain('Загружаем русский и английский словари')
  expect(requests).toContain(`${new URL(page.url()).origin}/ocr/tesseract-7.0.0/worker.min.js`)
  expect(requests.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true)
})

test('reads a fiscal QR from an image after cropping and rotating', async ({ page }) => {
  const pixels = receiptQrPixels()

  const result = await page.evaluate(async ({ pixels, mediaPath }) => {
    const { prepareReceiptImage, readReceiptQr } = await import(mediaPath) as typeof import('../../src/receipts/media')
    const canvas = document.createElement('canvas')
    canvas.width = 420
    canvas.height = 320
    const context = canvas.getContext('2d')!
    context.fillStyle = '#fff'
    context.fillRect(0, 0, 420, 320)
    context.fillStyle = '#000'
    for (const [index, pixel] of pixels.entries()) if (pixel) context.fillRect(120 + index % 220, 60 + Math.floor(index / 220), 1, 1)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((image) => resolve(image!), 'image/png'))
    const prepared = await prepareReceiptImage(blob, { rotation: 90, crop: { left: .2, top: .1, right: .9, bottom: .9 } })
    return readReceiptQr(prepared)
  }, { pixels, mediaPath })

  expect(result).toBe(rawQr)
})

test('finds a small fiscal QR in the bottom of a busy receipt photo', async ({ page }) => {
  const pixels = receiptQrPixels()
  const result = await page.evaluate(async ({ pixels, mediaPath }) => {
    const { readReceiptQr } = await import(mediaPath) as typeof import('../../src/receipts/media')
    const qr = document.createElement('canvas')
    qr.width = qr.height = 220
    const qrContext = qr.getContext('2d')!
    qrContext.fillStyle = '#eaeaea'
    qrContext.fillRect(0, 0, 220, 220)
    qrContext.fillStyle = '#303030'
    for (const [index, pixel] of pixels.entries()) if (pixel) qrContext.fillRect(index % 220, Math.floor(index / 220), 1, 1)

    const photo = document.createElement('canvas')
    photo.width = 960
    photo.height = 1280
    const context = photo.getContext('2d')!
    context.fillStyle = '#5c5751'
    context.fillRect(0, 0, 960, 1280)
    context.fillStyle = '#ece9e2'
    context.fillRect(100, 100, 760, 1100)
    context.fillStyle = '#222'
    context.font = '14px Arial'
    for (let y = 180; y < 1100; y += 27) context.fillText('Товар розничной торговли                        1 x 44.50 = 44.50 НДС 10%', 130, y)
    context.drawImage(qr, 645, 945, 90, 90)
    const blob = await new Promise<Blob>((resolve) => photo.toBlob((image) => resolve(image!), 'image/png'))
    return readReceiptQr(blob)
  }, { pixels, mediaPath })
  expect(result).toBe(rawQr)
})

test('scans one QR from a video stream and releases the camera track', async ({ page }) => {
  test.skip(!await page.evaluate(() => typeof HTMLCanvasElement.prototype.captureStream === 'function'), 'This browser build cannot supply video from a canvas.')
  const result = await page.evaluate(async ({ pixels, mediaPath }) => {
    const { scanReceiptCamera } = await import(mediaPath) as typeof import('../../src/receipts/media')
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 220
    const context = canvas.getContext('2d')!
    function drawFrame() {
      context.fillStyle = '#fff'
      context.fillRect(0, 0, 220, 220)
      context.fillStyle = '#000'
      for (const [index, pixel] of pixels.entries()) if (pixel) context.fillRect(index % 220, Math.floor(index / 220), 1, 1)
    }
    drawFrame()
    const stream = canvas.captureStream(15)
    const [track] = stream.getVideoTracks()
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => stream })
    const video = document.createElement('video')
    document.body.append(video)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const refresh = setInterval(drawFrame, 120)
    const codes: string[] = []
    try {
      await scanReceiptCamera(video, (code) => codes.push(code), controller.signal)
      return { codes, released: track.readyState === 'ended' && video.srcObject == null }
    } finally {
      clearTimeout(timeout)
      clearInterval(refresh)
      track.stop()
      video.remove()
    }
  }, { pixels: receiptQrPixels(), mediaPath })

  expect(result).toEqual({ codes: [rawQr], released: true })
})

test('releases a video stream granted after the scanner was cancelled', async ({ page }) => {
  const released = await page.evaluate(async (mediaPath) => {
    const { scanReceiptCamera } = await import(mediaPath) as typeof import('../../src/receipts/media')
    const track = { running: true, stop() { this.running = false } }
    const stream = { getTracks: () => [track] }
    let grantPermission: (value: typeof stream) => void = () => undefined
    const pending = new Promise<typeof stream>((resolve) => { grantPermission = resolve })
    let requestedPermission: () => void = () => undefined
    const cameraRequested = new Promise<void>((resolve) => { requestedPermission = resolve })
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => { requestedPermission(); return pending } } })
    const controller = new AbortController()
    const video = document.createElement('video')
    const scanning = scanReceiptCamera(video, () => { throw new Error('The scan was cancelled before the track arrived') }, controller.signal)
    await cameraRequested
    controller.abort()
    await scanning
    grantPermission(stream)
    await pending
    return !track.running && video.srcObject == null
  }, mediaPath)

  expect(released).toBe(true)
})

test('cancels OCR promptly while the local worker is still loading', async ({ page }) => {
  let finishWorkerRequest: () => void = () => undefined
  const workerHeld = new Promise<void>((resolve) => { finishWorkerRequest = resolve })
  await page.route('**/ocr/*/worker.min.js', async (route) => {
    await workerHeld
    await route.abort().catch(() => undefined)
  })

  try {
    const error = await page.evaluate(async (mediaPath) => {
      const { recognizeReceipt } = await import(mediaPath) as typeof import('../../src/receipts/media')
      const controller = new AbortController()
      const start = performance.now()
      try {
        await recognizeReceipt(new Blob(['image']), controller.signal, () => controller.abort())
        return { name: null, elapsed: performance.now() - start }
      } catch (error) {
        return { name: (error as Error).name, elapsed: performance.now() - start }
      }
    }, mediaPath)
    expect(error.name).toBe('AbortError')
    expect(error.elapsed).toBeLessThan(1000)
  } finally {
    finishWorkerRequest()
  }
})
