/**
 * Production smoke test: loads the deployed demo in a real browser, generates an account and
 * checks that the page talks to the chain without console errors.
 *
 *   PROD_URL=https://eip7702-aa-demo.vercel.app bun run smoke:prod
 */
import { chromium } from '@playwright/test'

const url = process.env.PROD_URL ?? process.argv[2]

if (!url) {
  console.error('usage: PROD_URL=https://your-deployment bun run smoke:prod')
  process.exit(1)
}

const browser = await chromium.launch()
const page = await browser.newPage()

const errors: string[] = []
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(error.message))

try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })

  const chain = (await page.getByTestId('chain-badge').textContent())?.trim()
  const implementation = (await page.getByTestId('impl-address').textContent())?.trim()
  const faucet = (await page.getByTestId('faucet-address').textContent())?.trim()

  console.log(`url             ${url}`)
  console.log(`chain           ${chain}`)
  console.log(`delegation      ${implementation}`)
  console.log(`faucet          ${faucet}`)

  await page.getByTestId('btn-create').click()
  await page.waitForSelector('[data-testid="step1-status"][data-status="done"]', { timeout: 90_000 })

  const address = (await page.getByTestId('aa-address').textContent())?.trim()
  const code = (await page.getByTestId('aa-code').textContent())?.trim()
  const nonce = (await page.getByTestId('aa-nonce').textContent())?.trim()

  console.log(`new account     ${address}`)
  console.log(`code            ${code}`)
  console.log(`nonce           ${nonce}`)

  const failures: string[] = []
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) failures.push('invalid account address')
  if (code !== '0x') failures.push(`expected plain EOA code 0x, got ${code}`)
  if (implementation === 'not deployed') failures.push('IMPLEMENTATION_ADDRESS is not configured')
  if (errors.length > 0) failures.push(...errors)

  if (failures.length > 0) {
    console.error('\nsmoke failed:')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }

  console.log('\nsmoke passed')
} finally {
  await browser.close()
}
