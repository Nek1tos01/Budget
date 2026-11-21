import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { receiptOcrAssets } from './scripts/vite-ocr-assets.ts'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    receiptOcrAssets(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      workbox: {
        globPatterns: ['**/*.{js,mjs,wasm,css,html,svg,png,webmanifest}'],
        globIgnores: ['**/node_modules/**/*', 'ocr/**'],
        runtimeCaching: [{
          urlPattern: ({ url, sameOrigin }) => sameOrigin && /\/ocr\/tesseract-[\d.]+\/(?:worker\.min\.js|tesseract-core-[\w-]+\.wasm\.js|(?:rus|eng)\.traineddata\.gz)$/.test(url.pathname),
          handler: 'CacheFirst',
          options: { cacheName: 'budget-receipt-ocr', cacheableResponse: { statuses: [200] }, expiration: { maxEntries: 8 } },
        }],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/(?:api|ocr)(?:\/|$)/],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
      },
      manifest: {
        id: '/', name: 'Бюджет — общий бюджет', short_name: 'Бюджет', lang: 'ru',
        description: 'Личный бюджет для двоих', start_url: '/', scope: '/',
        display: 'standalone', orientation: 'portrait', theme_color: '#15161f', background_color: '#15161f',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  build: {
    rolldownOptions: { output: { codeSplitting: { groups: [
      { name: 'react', test: /node_modules\/(react|react-dom|scheduler)\// },
      { name: 'motion', test: /node_modules\/(motion|framer-motion|motion-dom|motion-utils)\// },
      { name: 'local-data', test: /node_modules\/(dexie|dexie-react-hooks|zod|@js-temporal|jsbi)\// },
    ] } } },
  },
  test: { include: ['tests/**/*.test.ts'], setupFiles: ['./tests/setup-wasm.ts'] },
})
