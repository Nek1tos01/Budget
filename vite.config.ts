import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'], navigateFallback: '/index.html', cleanupOutdatedCaches: true, clientsClaim: true },
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
  test: { include: ['tests/**/*.test.ts'] },
})
