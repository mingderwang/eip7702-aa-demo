import { defineConfig } from '@playwright/test'

const baseURL = process.env.BASE_URL

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 60_000 },
  reporter: [['list']],
  use: {
    baseURL: baseURL ?? 'http://127.0.0.1:4322',
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  // When BASE_URL points at a deployment (e.g. Vercel), test it as-is.
  webServer: baseURL
    ? undefined
    : {
        command: 'bun run tests/e2e/serve.ts',
        url: 'http://127.0.0.1:4322/api/config',
        reuseExistingServer: false,
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
})
