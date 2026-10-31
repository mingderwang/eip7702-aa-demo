import { expect, test } from '@playwright/test'
import { createWalletClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'

/**
 * End-to-end proof of the demo on a real EVM node (anvil, Prague hardfork):
 * the page creates a key, funds it, signs an EIP-7702 authorization + type-4 batch,
 * and the balances shown on screen are read back from the chain.
 */
test('create → fund → delegate + batch → verify balances', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))

  await page.goto('/')

  // chain + deployment are wired up
  await expect(page.getByTestId('chain-badge')).toContainText('Anvil')
  await expect(page.getByTestId('chain-badge')).toContainText('31337')
  await expect(page.getByTestId('impl-address')).not.toHaveText('not deployed')
  await expect(page.getByTestId('faucet-badge')).toContainText('0.01')

  // 1. create
  await expect(page.getByTestId('step1-status')).toHaveAttribute('data-status', 'ready')
  await page.getByTestId('btn-create').click()
  await expect(page.getByTestId('step1-status')).toHaveAttribute('data-status', 'done')

  const address = (await page.getByTestId('aa-address').textContent())?.trim() ?? ''
  expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  await expect(page.getByTestId('aa-code')).toHaveText('0x')
  await expect(page.getByTestId('aa-nonce')).toHaveText('0')

  // 2. fund
  await page.getByTestId('btn-fund').click()
  await expect(page.getByTestId('step2-status')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('funded-balance')).toHaveText('0.01 ETH')
  await expect(page.getByTestId('fund-tx')).not.toHaveText('—')

  // 3. delegate + batch
  await page.getByTestId('btn-execute').click()
  await expect(page.getByTestId('step3-status')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('step4-status')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('exec-tx')).not.toHaveText('—')
  await expect(page.getByTestId('exec-type')).toHaveText('eip7702')
  await expect(page.getByTestId('exec-gas')).not.toHaveText('—')

  // 4. verification badges
  await expect(page.getByTestId('verify-code')).toHaveAttribute('data-ok', 'true')
  await expect(page.getByTestId('verify-type')).toHaveAttribute('data-ok', 'true')
  await expect(page.getByTestId('verify-erc1271')).toHaveAttribute('data-ok', 'true')
  await expect(page.getByTestId('verify-erc1271-bad')).toHaveAttribute('data-ok', 'true')

  // balances: before / after / delta, read from the chain
  await expect(page.getByTestId('balance-aa-before')).toHaveText('0.01')
  const aaAfter = Number(await page.getByTestId('balance-aa-after').textContent())
  expect(aaAfter).toBeGreaterThan(0)
  expect(aaAfter).toBeLessThan(0.01 - 0.0015)

  await expect(page.getByTestId('balance-ra-before')).toHaveText('0')
  await expect(page.getByTestId('balance-ra-after')).toHaveText('0.001')
  await expect(page.getByTestId('balance-ra-delta')).toHaveText('+0.001')

  await expect(page.getByTestId('balance-rb-before')).toHaveText('0')
  await expect(page.getByTestId('balance-rb-after')).toHaveText('0.0005')
  await expect(page.getByTestId('balance-rb-delta')).toHaveText('+0.0005')

  // value sent (0.0015) plus gas paid by the account itself
  const aaDelta = Number(await page.getByTestId('balance-aa-delta').textContent())
  expect(aaDelta).toBeLessThan(-0.0015)
  expect(aaDelta).toBeGreaterThan(-0.002)

  // the account really is delegated, as reported by the server's eth_getCode
  const stateResponse = await page.request.get(`/api/state?address=${address}`)
  expect(stateResponse.ok()).toBe(true)
  const accountState = (await stateResponse.json()) as {
    delegated: boolean
    implementation: string
    code: string
  }
  expect(accountState.delegated).toBe(true)
  expect(accountState.code.toLowerCase().startsWith('0xef0100')).toBe(true)

  // 5. a second transaction, without re-delegating
  await page.getByTestId('btn-second').click()
  await expect(page.getByTestId('second-tx')).not.toHaveText('—')
  await expect(page.getByTestId('balance-ra-after')).toHaveText('0.0012')
  await expect(page.getByTestId('balance-ra-delta')).toHaveText('+0.0012')
  await expect(page.getByTestId('btn-second')).toBeDisabled()

  // the activity log records the full flow
  const logText = (await page.getByTestId('log').textContent()) ?? ''
  expect(logText).toContain('generated ephemeral keypair')
  expect(logText).toContain('signed authorization')
  expect(logText).toContain('ERC-1271(valid sig) → 0x1626ba7e')

  expect(consoleErrors).toEqual([])

  await page.screenshot({ path: 'test-results/demo.png', fullPage: true })
})

test('the relay refuses unsupported transaction types', async ({ request }) => {
  const response = await request.post('/api/broadcast', { data: { raw: '0x01f86b0180' } })
  expect(response.status()).toBe(400)
  const body = (await response.json()) as { code: string }
  expect(body.code).toBe('UNSUPPORTED_TX_TYPE')
})

test('the relay refuses type-2 transactions from non-delegated accounts', async ({ request }) => {
  const account = privateKeyToAccount(generatePrivateKey())
  const wallet = createWalletClient({
    account,
    chain: anvil,
    transport: http('http://127.0.0.1:4322/api/rpc'),
  })

  const raw = await wallet.signTransaction({
    to: account.address,
    value: 1n,
    nonce: 0,
    gas: 21_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    chainId: anvil.id,
  })

  const response = await request.post('/api/broadcast', { data: { raw } })
  expect(response.status()).toBe(403)
  const body = (await response.json()) as { code: string }
  expect(body.code).toBe('NOT_DELEGATED')
})

test('the state endpoint validates addresses', async ({ request }) => {
  const response = await request.get('/api/state?address=not-an-address')
  expect(response.status()).toBe(400)
})
