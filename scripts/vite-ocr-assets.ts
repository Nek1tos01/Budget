import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { Plugin } from 'vite'
import { receiptOcrDirectory } from '../src/receipts/ocr-assets.ts'

const resolve = createRequire(import.meta.url).resolve
const assets = new Map([
  ['worker.min.js', 'tesseract.js/dist/worker.min.js'],
  ['tesseract-core-lstm.wasm.js', 'tesseract.js-core/tesseract-core-lstm.wasm.js'],
  ['tesseract-core-simd-lstm.wasm.js', 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js'],
  ['tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['rus.traineddata.gz', '@tesseract.js-data/rus/4.0.0_best_int/rus.traineddata.gz'],
  ['eng.traineddata.gz', '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'],
].map(([name, asset]) => [name, resolve(asset)]))

export function receiptOcrAssets(): Plugin {
  return {
    name: 'budget-receipt-ocr-assets',
    configureServer(server) {
      const prefix = new URL(receiptOcrDirectory, `http://localhost${server.config.base}`).pathname
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0]
        const fileName = path?.startsWith(prefix) && path.slice(prefix.length)
        const asset = fileName && assets.get(fileName)
        if (!asset) return next()
        void readFile(asset).then((data) => {
          response.setHeader('Content-Type', asset.endsWith('.js') ? 'application/javascript' : 'application/gzip')
          response.end(data)
        }).catch(next)
      })
    },
    async generateBundle() {
      const files = await Promise.all(Array.from(assets, async ([fileName, path]) => ({ fileName, source: await readFile(path) })))
      for (const { fileName, source } of files) this.emitFile({ type: 'asset', fileName: receiptOcrDirectory + fileName, source })
    },
  }
}
