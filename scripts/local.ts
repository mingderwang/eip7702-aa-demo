/**
 * One-command local demo: starts anvil (prague), deploys the delegation target, then runs the
 * Astro dev server wired to that chain.
 *
 *   bun run demo:local
 */
import { spawn } from 'node:child_process'
import { createPublicClient, createWalletClient, http } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'
import { batchExecutorAbi, batchExecutorBytecode } from '../src/lib/generated/batchExecutor'
import { ANVIL_MNEMONIC, startAnvil } from './lib/anvil'

export const ANVIL_PK_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
export const DEMO_RECIPIENT_A = '0x12B3e04Bb1c94F41760cfbdad41F8dE1991E85Df'
export const DEMO_RECIPIENT_B = '0xAD5947cfEDB62141b745aFC791434F7Ce1BA1465'

async function main() {
  const port = Number(process.env.ANVIL_PORT ?? 8545)
  const instance = await startAnvil({ port })

  const funder = mnemonicToAccount(ANVIL_MNEMONIC)
  const transport = http(instance.rpcUrl)
  const publicClient = createPublicClient({ chain: anvil, transport })
  const wallet = createWalletClient({ account: funder, chain: anvil, transport })

  const hash = await wallet.deployContract({ abi: batchExecutorAbi, bytecode: batchExecutorBytecode, chain: anvil })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (!receipt.contractAddress) throw new Error('deployment failed')

  console.log(`\n  anvil        ${instance.rpcUrl}`)
  console.log(`  delegation   ${receipt.contractAddress}`)
  console.log(`  faucet       ${funder.address}\n`)

  const child = spawn('bun', ['run', 'dev'], {
    env: {
      ...process.env,
      CHAIN_ID: '31337',
      SEPOLIA_RPC_URL: instance.rpcUrl,
      FUNDER_PRIVATE_KEY: ANVIL_PK_0,
      IMPLEMENTATION_ADDRESS: receipt.contractAddress,
      RECIPIENT_ADDRESS: DEMO_RECIPIENT_A,
      RECIPIENT2_ADDRESS: DEMO_RECIPIENT_B,
    },
    stdio: 'inherit',
  })

  const shutdown = async (code = 0) => {
    child.kill('SIGTERM')
    await instance.stop()
    process.exit(code)
  }

  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))
  child.on('exit', (code) => void shutdown(code ?? 0))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
