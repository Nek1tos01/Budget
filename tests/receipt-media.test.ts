import { describe, expect, it } from 'vitest'
import { prepareReceiptImage, recognizeReceipt, scanReceiptCamera } from '../src/receipts/media'

describe('receipt media', () => {
  it('does not open the camera after the scan has been cancelled', async () => {
    const signal = AbortSignal.abort()
    await expect(scanReceiptCamera({} as HTMLVideoElement, () => undefined, signal)).resolves.toBeUndefined()
  })

  it('rejects an empty image before trying to decode it', async () => {
    await expect(prepareReceiptImage(new Blob(), {})).rejects.toThrow('Файл изображения пуст.')
  })

  it('does not start an OCR worker after processing has been cancelled', async () => {
    const signal = AbortSignal.abort()
    await expect(recognizeReceipt(new Blob(), signal, () => undefined)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
