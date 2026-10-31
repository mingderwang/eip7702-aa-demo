/**
 * Deploys the BatchExecutor delegation target to the configured chain and records its address
 * in .env (IMPLEMENTATION_ADDRESS).
 *
 * Run: CHAIN_ID=11155111 bun run deploy:impl
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPublicClient, createWalletClient, formatEther, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { resolveChain } from '../src/lib/chain'
import { batchExecutorAbi, batchExecutorBytecode } from '../src/lib/generated/batchExecutor'
import { getConfig } from '../src/lib/server/env'

const root = resolve(import.meta.dir, '..')

function upsertEnv(key: string, value: string) {
  const path = resolve(root, '.env')
  const current = readFileSync(path, 'utf8')
  const line = `${key}=${value}`
  const pattern = new RegExp(`^${key}=.*$`, 'm')
  const next = pattern.test(current) ? current.replace(pattern, line) : `${current.trimEnd()}\n${line}\n`
  writeFileSync(path, next)
}

async function main() {
  const config = getConfig()
  if (!config.funderKey) throw new Error('FUNDER_PRIVATE_KEY is not set in .env')

  const account = privateKeyToAccount(config.funderKey)
  const chain = resolveChain(config.chainId)
  const transport = http(config.rpcUrl, { timeout: 60_000, retryCount: 3 })
  const publicClient = createPublicClient({ chain, transport })
  const wallet = createWalletClient({ account, chain, transport })

  const balance = await publicClient.getBalance({ address: account.address })
  console.log(`chain      ${chain.name} (${chain.id})`)
  console.log(`rpc        ${config.rpcUrl}`)
  console.log(`deployer   ${account.address} (${formatEther(balance)} ETH)`)
  if (balance === 0n) {
    throw new Error(
      `deployer has no funds — send testnet ETH to ${account.address} and retry`,
    )
  }

  console.log('deploying BatchExecutor…')
  const hash = await wallet.deployContract({
    abi: batchExecutorAbi,
    bytecode: batchExecutorBytecode,
    chain,
  })
  console.log(`tx         ${hash}`)

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`deployment failed: ${hash}`)
  }

  const code = await publicClient.getCode({ address: receipt.contractAddress })
  console.log(`address    ${receipt.contractAddress}`)
  console.log(`code size  ${(code.length - 2) / 2} bytes`)
  console.log(`gas used   ${receipt.gasUsed}`)

  if (config.chainId === 11155111) {
    upsertEnv('IMPLEMENTATION_ADDRESS', receipt.contractAddress)
    console.log('wrote IMPLEMENTATION_ADDRESS to .env')
    console.log(`explorer   https://sepolia.etherscan.io/address/${receipt.contractAddress}`)
  } else {
    console.log('(local chain: .env not modified)')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
