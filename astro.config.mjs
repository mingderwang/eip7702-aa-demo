import { defineConfig } from 'astro/config'
import vercel from '@astrojs/vercel'

export default defineConfig({
  output: 'server',
  adapter: vercel({
    maxDuration: 60,
  }),
  server: {
    port: 4321,
    host: true,
  },
  vite: {
    build: {
      // viem is large; keep the demo bundle in a single readable chunk
      chunkSizeWarningLimit: 1200,
    },
  },
})
