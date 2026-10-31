/**
 * Live Sepolia proof of the full demo flow, with assertions.
 *
 *   bun run proof:sepolia
 *
 * Requires: CHAIN_ID=11155111, SEPOLIA_RPC_URL, FUNDER_PRIVATE_KEY (funded),
 *           IMPLEMENTATION_ADDRESS (from `bun run deploy:impl`).
 *
 * Writes docs/PROOF.md and artifacts/proof-sepolia.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseEther,
  toBytes,
  type Address,
  type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { explorerAddressUrl, explorerTxUrl, resolveChain } from '../src/lib/chain'
import { decodeDesignator, ERC1271_MAGIC } from '../src/lib/eip7702'
import { formatDelta, formatEth, shortAddress } from '../src/lib/format'
import { batchExecutorAbi } from '../src/lib/generated/batchExecutor'
import { buildDelegatedBatchTx, buildPlainTx } from '../src/lib/tx'
import { getConfig } from '../src/lib/server/env'
import { fundAccount } from '../src/lib/server/funder'

const root = resolve(import.meta.dir, '..')
const CALL_A = parseEther('0.001')
const CALL_B = parseEther('0.0005')
const SECOND = parseEther('0.0002')
const ERC1271_MESSAGE = 'EIP-7702 demo: is this account smart?'

type Check = { name: string; ok: boolean; detail: string }
const checks: Check[] = []

function check(name: string, ok: boolean, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function txLink(chainId: number, hash: string) {
  const url = explorerTxUrl(chainId, hash)
  return url ? `[${hash}](${url})` : hash
}

function addrLink(chainId: number, address: string) {
  const url = explorerAddressUrl(chainId, address)
  return url ? `[${address}](${url})` : address
}

async function main() {
  const config = getConfig()
  if (config.chainId !== 11155111) {
    throw new Error(`proof:sepolia needs CHAIN_ID=11155111 (got ${config.chainId})`)
  }
  if (!config.implementation) {
    throw new Error('IMPLEMENTATION_ADDRESS is not set — run `bun run deploy:impl` first')
  }

  const chain = resolveChain(config.chainId)
  const transport = http(config.rpcUrl, { timeout: 60_000, retryCount: 3 })
  const publicClient = createPublicClient({ chain, transport })

  const account = privateKeyToAccount(generatePrivateKey())
  const wallet = createWalletClient({ account, chain, transport })

  console.log(`\nchain        ${chain.name} (${chain.id})`)
  console.log(`rpc          ${config.rpcUrl}`)
  console.log(`implementation ${config.implementation}`)
  console.log(`new account  ${account.address}\n`)

  // 1. fund the brand-new account from the demo faucet
  console.log('funding from the demo faucet…')
  const funding = await fundAccount(account.address)
  const fundedBalance = funding.balance
  console.log(
    `funded       ${formatEth(fundedBalance)} ETH${funding.hash ? ` (tx ${funding.hash})` : ' (already funded)'}\n`,
  )
  check('account received testnet ETH', fundedBalance >= config.maxFundWei, `${formatEth(fundedBalance)} ETH`)

  // 2. one type-4 transaction: delegate + batch
  console.log('signing authorization + type-4 batch…')
  const batch = await buildDelegatedBatchTx({
    publicClient,
    wallet,
    account,
    implementation: config.implementation,
    chainId: config.chainId,
    calls: [
      { to: config.recipient, value: CALL_A, data: '0x' },
      { to: config.recipient2, value: CALL_B, data: '0x' },
    ],
  })

  const batchHash = await publicClient.request({
    method: 'eth_sendRawTransaction',
    params: [batch.raw as Hex],
  })
  console.log(`broadcast    ${batchHash}`)

  const batchReceipt = await publicClient.waitForTransactionReceipt({ hash: batchHash, timeout: 180_000 })
  if (batchReceipt.status !== 'success') throw new Error(`batch transaction reverted: ${batchHash}`)
  console.log(`mined        block ${batchReceipt.blockNumber}, gas ${batchReceipt.gasUsed}\n`)

  // 3. verify everything from chain state
  const code = await publicClient.getCode({ address: account.address })
  const designator = decodeDesignator(code)
  check(
    'eth_getCode is 0xef0100 || implementation',
    designator.delegated &&
      designator.implementation.toLowerCase() === config.implementation.toLowerCase(),
    code ?? '0x',
  )
  check('transaction type is 0x04 (EIP-7702)', batchReceipt.type === 'eip7702', batchReceipt.type)

  const recipientABalance = await publicClient.getBalance({ address: config.recipient })
  const recipientBBalance = await publicClient.getBalance({ address: config.recipient2 })
  check('call 1 executed (recipient A)', recipientABalance >= CALL_A, `${formatEth(recipientABalance)} ETH`)
  check('call 2 executed (recipient B)', recipientBBalance >= CALL_B, `${formatEth(recipientBBalance)} ETH`)

  const gasCost = batchReceipt.gasUsed * batchReceipt.effectiveGasPrice
  const accountBalance = await publicClient.getBalance({ address: account.address })
  check(
    'account paid value + gas from its own balance',
    accountBalance === fundedBalance - CALL_A - CALL_B - gasCost,
    `${formatEth(fundedBalance)} − ${formatEth(CALL_A + CALL_B)} − ${formatEth(gasCost)} = ${formatEth(accountBalance)} ETH`,
  )

  const messageHash = keccak256(toBytes(ERC1271_MESSAGE))
  const signature = await account.sign({ hash: messageHash })
  const magic = await publicClient.readContract({
    address: account.address,
    abi: batchExecutorAbi,
    functionName: 'isValidSignature',
    args: [messageHash, signature],
  })
  check('ERC-1271 validates the account signature', magic === ERC1271_MAGIC, magic)

  // 4. a plain type-2 transaction from the now-delegated account
  console.log('\nsending a second transaction without re-delegating…')
  const second = await buildPlainTx({
    publicClient,
    wallet,
    account,
    to: config.recipient,
    value: SECOND,
    chainId: config.chainId,
  })
  const secondHash = await publicClient.request({
    method: 'eth_sendRawTransaction',
    params: [second.raw as Hex],
  })
  const secondReceipt = await publicClient.waitForTransactionReceipt({ hash: secondHash, timeout: 180_000 })
  check('second transaction confirmed', secondReceipt.status === 'success', secondHash)
  check(
    'second transaction is a plain type-2 tx',
    secondReceipt.type === 'eip1559',
    secondReceipt.type,
  )

  const recipientAAfter = await publicClient.getBalance({ address: config.recipient })
  check('recipient A received the second transfer', recipientAAfter >= CALL_A + SECOND, formatEth(recipientAAfter))

  const codeAfter = await publicClient.getCode({ address: account.address })
  check(
    'account is still delegated after the second transaction',
    decodeDesignator(codeAfter).delegated,
    codeAfter ?? '0x',
  )

  // 5. write the report
  const now = new Date().toISOString()
  const passed = checks.filter((c) => c.ok).length
  const failed = checks.length - passed

  const rows = [
    ['AA account', fundedBalance, accountBalance],
    ['recipient A', recipientABalance - CALL_A, recipientAAfter],
    ['recipient B', recipientBBalance - CALL_B, recipientBBalance],
  ] as const

  const markdown = `# Sepolia proof — EIP-7702 smart account

Generated **${now}** by \`bun run proof:sepolia\`.

**${passed}/${checks.length} checks passed${failed > 0 ? `, ${failed} failed` : ''}.**

| item | value |
| --- | --- |
| chain | Sepolia (${config.chainId}) |
| delegation target | ${addrLink(config.chainId, config.implementation)} |
| new AA account | ${addrLink(config.chainId, account.address)} |
| faucet | ${addrLink(config.chainId, funding.faucet)} |
| delegation + batch (type 0x04) | ${txLink(config.chainId, batchHash)} |
| second transaction (type 0x02) | ${txLink(config.chainId, secondHash)} |
| gas used (batch) | ${batchReceipt.gasUsed} |
| fee paid by AA account | ${formatEth(gasCost)} ETH |

## Balances

| account | before batch (ETH) | after batch (ETH) | Δ (ETH) |
| --- | --- | --- | --- |
${rows
  .map(
    ([name, before, after]) =>
      `| ${name} | ${formatEth(before)} | ${formatEth(after)} | ${formatDelta(before, after)} |`,
  )
  .join('\n')}

> \`recipient A\` "after" includes the second transaction; \`recipient B\` only receives the batch call.

## Checks

${checks.map((c) => `- [${c.ok ? 'x' : ' '}] ${c.name}${c.detail ? ` — \`${c.detail}\`` : ''}`).join('\n')}

## Reproduce

\`\`\`bash
bun install
cp .env.example .env   # add FUNDER_PRIVATE_KEY
bun run deploy:impl
bun run proof:sepolia
\`\`\`
`

  mkdirSync(resolve(root, 'docs'), { recursive: true })
  writeFileSync(resolve(root, 'docs/PROOF.md'), markdown)

  mkdirSync(resolve(root, 'artifacts'), { recursive: true })
  writeFileSync(
    resolve(root, 'artifacts/proof-sepolia.json'),
    JSON.stringify(
      {
        generatedAt: now,
        chainId: config.chainId,
        implementation: config.implementation,
        account: account.address,
        faucet: funding.faucet,
        transactions: { batch: batchHash, second: secondHash },
        balances: rows.map(([name, before, after]) => ({
          name,
          beforeWei: before.toString(),
          afterWei: after.toString(),
        })),
        gas: { used: batchReceipt.gasUsed.toString(), costWei: gasCost.toString() },
        checks,
        passed,
        failed,
      },
      null,
      2,
    ),
  )

  console.log(`\nwrote docs/PROOF.md and artifacts/proof-sepolia.json`)
  console.log(`${passed}/${checks.length} checks passed`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(`\nproof failed: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
