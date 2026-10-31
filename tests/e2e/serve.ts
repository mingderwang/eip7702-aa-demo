/**
 * Playwright web server: boots a deterministic anvil chain, deploys the delegation target, then
 * starts the Astro dev server pointed at it. Everything is torn down when Playwright exits.
 */
import { spawn } from 'node:child_process'
import { createPublicClient, createWalletClient, http } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'
import { batchExecutorAbi, batchExecutorBytecode } from '../../src/lib/generated/batchExecutor'
import { ANVIL_MNEMONIC, startAnvil } from '../../scripts/lib/anvil'

const PORT = 4322
const ANVIL_PK_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

async function main() {
  const instance = await startAnvil()

  const funder = mnemonicToAccount(ANVIL_MNEMONIC)
  const transport = http(instance.rpcUrl)
  const publicClient = createPublicClient({ chain: anvil, transport })
  const wallet = createWalletClient({ account: funder, chain: anvil, transport })

  const hash = await wallet.deployContract({ abi: batchExecutorAbi, bytecode: batchExecutorBytecode, chain: anvil })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (!receipt.contractAddress) throw new Error('deployment failed')

  const child = spawn('bun', ['run', 'dev', '--', '--port', String(PORT)], {
    env: {
      ...process.env,
      CHAIN_ID: '31337',
      SEPOLIA_RPC_URL: instance.rpcUrl,
      FUNDER_PRIVATE_KEY: ANVIL_PK_0,
      IMPLEMENTATION_ADDRESS: receipt.contractAddress,
      RECIPIENT_ADDRESS: '0x12B3e04Bb1c94F41760cfbdad41F8dE1991E85Df',
      RECIPIENT2_ADDRESS: '0xAD5947cfEDB62141b745aFC791434F7Ce1BA1465',
    },
    stdio: 'inherit',
  })

  let shuttingDown = false
  const shutdown = async (code = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    child.kill('SIGTERM')
    await instance.stop()
    process.exit(code)
  }

  process.on('SIGTERM', () => void shutdown(0))
  process.on('SIGINT', () => void shutdown(0))
  child.on('exit', (code) => void shutdown(code ?? 0))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
