import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseEther,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { explorerAddressUrl, explorerTxUrl, resolveChain } from '../lib/chain'
import { decodeDesignator, ERC1271_MAGIC } from '../lib/eip7702'
import { formatDelta, formatEth, shortAddress, shortHex } from '../lib/format'
import { batchExecutorAbi } from '../lib/generated/batchExecutor'
import { buildDelegatedBatchTx, buildPlainTx } from '../lib/tx'

type Status = 'idle' | 'ready' | 'running' | 'done' | 'error'

type AppConfig = {
  chainId: number
  chainName: string
  implementation: Address | null
  recipient: Address
  recipient2: Address
  explorer: string | null
  funding: {
    enabled: boolean
    faucet: Address | null
    faucetBalanceWei: string | null
    amountWei: string
  }
  limits: { maxFundWei: string; faucetFloorWei: string }
}

type AccountState = {
  address: Address
  balance: string
  nonce: number
  code: Hex | null
  delegated: boolean
  implementation: Address | null
}

type Balances = { aa: bigint; a: bigint; b: bigint }

const CALL_A = parseEther('0.001')
const CALL_B = parseEther('0.0005')
const SECOND_TX = parseEther('0.0002')
const ERC1271_MESSAGE = 'EIP-7702 demo: is this account smart?'

const state: {
  cfg: AppConfig | null
  account: PrivateKeyAccount | null
  publicClient: PublicClient | null
  wallet: WalletClient | null
  before: Balances | null
  after: Balances | null
  steps: Record<1 | 2 | 3 | 4, Status>
  secondSent: boolean
  busy: boolean
} = {
  cfg: null,
  account: null,
  publicClient: null,
  wallet: null,
  before: null,
  after: null,
  steps: { 1: 'idle', 2: 'idle', 3: 'idle', 4: 'idle' },
  secondSent: false,
  busy: false,
}

/* ---------------- DOM helpers ---------------- */

function node<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`missing #${id}`)
  return element as T
}

function setText(id: string, text: string) {
  const element = document.getElementById(id)
  if (element) element.textContent = text
}

function setLink(id: string, href: string | null, text: string) {
  const element = node<HTMLAnchorElement>(id)
  element.textContent = text
  if (href) {
    element.href = href
    element.target = '_blank'
    element.rel = 'noreferrer'
  } else {
    element.removeAttribute('href')
  }
}

function setStatus(step: 1 | 2 | 3 | 4, status: Status, label?: string) {
  state.steps[step] = status
  const element = document.querySelector(`[data-testid="step${step}-status"]`) as HTMLElement | null
  if (!element) return
  element.dataset.status = status
  element.textContent = label ?? status
}

function mark(testId: string, ok: boolean) {
  const element = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
  if (element) element.dataset.ok = String(ok)
}

let logNode: HTMLElement

function log(message: string, kind: 'info' | 'ok' | 'err' | 'dim' = 'info') {
  const line = document.createElement('div')
  line.className = `log-line ${kind}`
  const time = new Date().toLocaleTimeString([], { hour12: false })
  line.textContent = `${time}  ${message}`
  logNode.appendChild(line)
  logNode.scrollTop = logNode.scrollHeight
}

function render() {
  const { cfg, account, steps, busy } = state

  node<HTMLButtonElement>('btn-create').disabled = busy
  node<HTMLButtonElement>('btn-fund').disabled = busy || !account || !cfg?.funding.enabled || steps[2] === 'done'
  node<HTMLButtonElement>('btn-execute').disabled =
    busy || !account || !cfg?.implementation || steps[3] === 'done' || steps[2] !== 'done'
  node<HTMLButtonElement>('btn-second').disabled = busy || steps[4] !== 'done' || state.secondSent
}

function renderBalances() {
  const rows: Array<[string, bigint | undefined, bigint | undefined]> = [
    ['balance-aa', state.before?.aa, state.after?.aa],
    ['balance-ra', state.before?.a, state.after?.a],
    ['balance-rb', state.before?.b, state.after?.b],
  ]

  for (const [prefix, before, after] of rows) {
    setText(`${prefix}-before`, before === undefined ? '—' : formatEth(before))
    setText(`${prefix}-after`, after === undefined ? '—' : formatEth(after))

    const deltaNode = document.getElementById(`${prefix}-delta`)
    if (!deltaNode) continue
    deltaNode.textContent = formatDelta(before, after)
    deltaNode.dataset.empty = String(before === undefined || after === undefined)
    deltaNode.classList.remove('pos', 'neg')
    if (before !== undefined && after !== undefined) {
      if (after > before) deltaNode.classList.add('pos')
      if (after < before) deltaNode.classList.add('neg')
    }
  }
}

/* ---------------- API helpers ---------------- */

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string }
  if (!response.ok) throw new Error(data.error ?? `request failed (${response.status})`)
  return data
}

async function readAccount(): Promise<AccountState> {
  if (!state.account) throw new Error('no account')
  const response = await fetch(`/api/state?address=${state.account.address}`)
  const data = (await response.json()) as AccountState & { error?: string }
  if (!response.ok) throw new Error(data.error ?? 'failed to read account state')
  return data
}

async function snapshot(): Promise<Balances> {
  const cfg = state.cfg
  const client = state.publicClient
  if (!cfg || !client || !state.account) throw new Error('not ready')

  const [aa, a, b] = await Promise.all([
    client.getBalance({ address: state.account.address }),
    client.getBalance({ address: cfg.recipient }),
    client.getBalance({ address: cfg.recipient2 }),
  ])
  return { aa, a, b }
}

async function refreshAccount() {
  const info = await readAccount()
  setText('aa-nonce', String(info.nonce))
  setText('aa-code', info.code ? shortHex(info.code, 10, 6) : '0x')
  if (info.delegated) mark('verify-code', true)
  return info
}

function txLink(hash: string, text?: string): { href: string | null; label: string } {
  const explorer = state.cfg?.explorer
  return {
    href: explorer ? `${explorer}/tx/${hash}` : null,
    label: text ?? shortHex(hash),
  }
}

/* ---------------- actions ---------------- */

async function createAccount() {
  if (!state.cfg) throw new Error('configuration not loaded')
  setStatus(1, 'running')

  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)
  const chain = resolveChain(state.cfg.chainId)
  const transport = http(`${window.location.origin}/api/rpc`, { timeout: 30_000 })

  state.account = account
  state.publicClient = createPublicClient({ chain, transport })
  state.wallet = createWalletClient({ account, chain, transport })

  setText('aa-address', account.address)
  setText('aa-key', privateKey)
  setText('aa-code', '0x')
  log(`generated ephemeral keypair ${shortAddress(account.address)}`, 'dim')

  const info = await refreshAccount()
  log(`eth_getCode → ${info.code ?? '0x'} (plain EOA)`)
  setStatus(1, 'done')
  setStatus(2, 'ready')
}

async function fundAccount() {
  if (!state.cfg || !state.account) throw new Error('create an account first')
  setStatus(2, 'running', 'waiting for faucet tx…')

  const result = await post<{
    ok: boolean
    hash: string | null
    amountWei: string
    balanceWei: string
    skipped: boolean
    reason: string | null
  }>('/api/fund', { address: state.account.address })

  if (result.skipped) {
    log('address already funded — faucet skipped', 'dim')
  } else if (result.hash) {
    const link = txLink(result.hash)
    setLink('fund-tx', link.href, link.label)
    log(`faucet sent ${formatEth(BigInt(result.amountWei))} ETH — tx ${shortHex(result.hash)}`, 'ok')
  }

  setText('funded-balance', `${formatEth(BigInt(result.balanceWei))} ETH`)
  await refreshAccount()
  setStatus(2, 'done')
  setStatus(3, 'ready')
}

async function executeBatch() {
  const cfg = state.cfg
  const account = state.account
  const wallet = state.wallet
  const publicClient = state.publicClient
  if (!cfg || !account || !wallet || !publicClient) throw new Error('not ready')
  if (!cfg.implementation) throw new Error('delegation target is not configured')

  setStatus(3, 'running', 'signing…')

  state.before = await snapshot()
  renderBalances()
  log(`snapshot before batch: AA ${formatEth(state.before.aa)} ETH`)

  const built = await buildDelegatedBatchTx({
    publicClient,
    wallet,
    account,
    implementation: cfg.implementation,
    chainId: cfg.chainId,
    calls: [
      { to: cfg.recipient, value: CALL_A, data: '0x' },
      { to: cfg.recipient2, value: CALL_B, data: '0x' },
    ],
  })

  log(
    `signed authorization → ${shortAddress(cfg.implementation)} @ nonce ${built.authorization?.nonce}`,
    'dim',
  )
  log(`signed type-4 transaction locally (${(built.raw.length - 2) / 2} bytes)`, 'dim')

  setStatus(3, 'running', 'broadcasting…')
  const { hash } = await post<{ hash: Hex }>('/api/broadcast', { raw: built.raw })
  const link = txLink(hash)
  setLink('exec-tx', link.href, link.label)
  log(`broadcast ${hash}`)

  setStatus(3, 'running', 'mining…')
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error(`transaction reverted: ${hash}`)

  const fee = receipt.gasUsed * receipt.effectiveGasPrice
  setText('exec-type', receipt.type)
  setText('exec-gas', receipt.gasUsed.toString())
  setText('exec-fee', `${formatEth(fee)} ETH`)
  log(`mined in block ${receipt.blockNumber} · gas ${receipt.gasUsed} · fee ${formatEth(fee)} ETH`, 'ok')

  /* -------- verification: read everything back from the chain -------- */

  setStatus(4, 'running', 'verifying…')
  const code = await publicClient.getCode({ address: account.address })
  const designator = decodeDesignator(code)
  const delegatedToImpl =
    designator.delegated &&
    designator.implementation.toLowerCase() === cfg.implementation.toLowerCase()

  setText('aa-code', code ? shortHex(code, 10, 6) : '0x')
  mark('verify-code', delegatedToImpl)
  log(`eth_getCode → ${shortHex(code ?? '0x', 10, 6)}`, delegatedToImpl ? 'ok' : 'err')

  mark('verify-type', receipt.type === 'eip7702')

  const messageHash = keccak256(toBytes(ERC1271_MESSAGE))
  const signature = await account.sign({ hash: messageHash })
  const magic = await publicClient.readContract({
    address: account.address,
    abi: batchExecutorAbi,
    functionName: 'isValidSignature',
    args: [messageHash, signature],
  })
  mark('verify-erc1271', magic === ERC1271_MAGIC)
  log(`ERC-1271(valid sig) → ${magic}`, magic === ERC1271_MAGIC ? 'ok' : 'err')

  const forgedSignature = await privateKeyToAccount(generatePrivateKey()).sign({ hash: messageHash })
  const forgedMagic = await publicClient.readContract({
    address: account.address,
    abi: batchExecutorAbi,
    functionName: 'isValidSignature',
    args: [messageHash, forgedSignature],
  })
  mark('verify-erc1271-bad', forgedMagic !== ERC1271_MAGIC)
  log(`ERC-1271(forged sig) → ${forgedMagic}`, forgedMagic !== ERC1271_MAGIC ? 'ok' : 'err')

  state.after = await snapshot()
  renderBalances()
  log(
    `balances: AA ${formatEth(state.after.aa)} · A ${formatEth(state.after.a)} · B ${formatEth(state.after.b)}`,
  )

  await refreshAccount()
  setStatus(3, 'done')
  setStatus(4, 'done')
}

async function sendSecondTransaction() {
  const cfg = state.cfg
  const account = state.account
  const wallet = state.wallet
  const publicClient = state.publicClient
  if (!cfg || !account || !wallet || !publicClient) throw new Error('not ready')

  setStatus(4, 'running', 'signing second tx…')

  const built = await buildPlainTx({
    publicClient,
    wallet,
    account,
    to: cfg.recipient,
    value: SECOND_TX,
    chainId: cfg.chainId,
  })
  log('signed a plain type-2 transaction from the delegated account (no authorization list)', 'dim')

  const { hash } = await post<{ hash: Hex }>('/api/broadcast', { raw: built.raw })
  const link = txLink(hash)
  setLink('second-tx', link.href, link.label)

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error(`second transaction reverted: ${hash}`)

  log(`second tx mined · gas ${receipt.gasUsed}`, 'ok')

  state.after = await snapshot()
  renderBalances()
  await refreshAccount()

  state.secondSent = true
  setStatus(4, 'done', 'done · account stays abstracted')
}

async function run(step: 1 | 2 | 3 | 4, action: () => Promise<void>) {
  if (state.busy) return
  state.busy = true
  render()
  try {
    await action()
  } catch (error) {
    setStatus(step, 'error')
    log(error instanceof Error ? error.message : String(error), 'err')
    console.error(error)
  } finally {
    state.busy = false
    render()
  }
}

/* ---------------- boot ---------------- */

async function init() {
  logNode = node('log')

  node('btn-create').addEventListener('click', () => run(1, createAccount))
  node('btn-fund').addEventListener('click', () => run(2, fundAccount))
  node('btn-execute').addEventListener('click', () => run(3, executeBatch))
  node('btn-second').addEventListener('click', () => run(4, sendSecondTransaction))
  node('btn-reset').addEventListener('click', () => window.location.reload())

  try {
    const response = await fetch('/api/config')
    const cfg = (await response.json()) as AppConfig & { error?: string }
    if (!response.ok) throw new Error(cfg.error ?? 'failed to load configuration')
    state.cfg = cfg

    setText('chain-badge', `${cfg.chainName} · ${cfg.chainId}`)
    setText('chain-id', String(cfg.chainId))
    setText('faucet-amount', formatEth(BigInt(cfg.funding.amountWei)))
    setText('faucet-address', cfg.funding.faucet ? shortAddress(cfg.funding.faucet) : 'disabled')
    setText('call-a-to', shortAddress(cfg.recipient))
    setText('call-b-to', shortAddress(cfg.recipient2))

    const implLink = node<HTMLAnchorElement>('impl-address')
    if (cfg.implementation) {
      implLink.textContent = shortAddress(cfg.implementation)
      const href = explorerAddressUrl(cfg.chainId, cfg.implementation)
      if (href) {
        implLink.href = href
        implLink.target = '_blank'
        implLink.rel = 'noreferrer'
      }
    } else {
      implLink.textContent = 'not deployed'
    }

    log(`connected to ${cfg.chainName} (chain ${cfg.chainId})`, 'dim')
    if (!cfg.funding.enabled) log('faucet is not configured — funding disabled', 'err')
    if (!cfg.implementation) log('IMPLEMENTATION_ADDRESS is not configured', 'err')

    setStatus(1, 'ready')
  } catch (error) {
    log(error instanceof Error ? error.message : String(error), 'err')
  }

  render()
}

void init()
