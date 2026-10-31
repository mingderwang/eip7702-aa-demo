import { isAddress, parseEther, type Address, type Hex } from 'viem'
import { ANVIL_CHAIN_ID, SEPOLIA_CHAIN_ID } from '../chain'

/**
 * Read an environment variable.
 *
 * `process.env` wins because that is what Vercel injects at runtime; `import.meta.env`
 * covers `astro dev`, where Vite loads `.env` files.
 */
function read(name: string): string | undefined {
  const fromProcess = typeof process !== 'undefined' ? process.env?.[name] : undefined
  if (fromProcess && fromProcess.length > 0) return fromProcess
  const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
  const value = viteEnv?.[name]
  return value && value.length > 0 ? value : undefined
}

export type AppConfig = {
  chainId: number
  rpcUrl: string
  funderKey: Hex | undefined
  implementation: Address | undefined
  recipient: Address
  recipient2: Address
  maxFundWei: bigint
  faucetFloorWei: bigint
  minFundedBalanceWei: bigint
}

const DEFAULT_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
const ZERO = '0x0000000000000000000000000000000000000000'

export function getConfig(): AppConfig {
  const chainId = Number(read('CHAIN_ID') ?? SEPOLIA_CHAIN_ID)
  if (chainId !== SEPOLIA_CHAIN_ID && chainId !== ANVIL_CHAIN_ID) {
    throw new Error(`CHAIN_ID must be ${SEPOLIA_CHAIN_ID} (Sepolia) or ${ANVIL_CHAIN_ID} (anvil)`)
  }

  const rpcUrl = read('SEPOLIA_RPC_URL') ?? (chainId === ANVIL_CHAIN_ID ? 'http://127.0.0.1:8545' : DEFAULT_RPC)

  const funderKeyRaw = read('FUNDER_PRIVATE_KEY')
  const funderKey = funderKeyRaw && /^0x[0-9a-fA-F]{64}$/.test(funderKeyRaw) ? (funderKeyRaw as Hex) : undefined

  const implementationRaw = read('IMPLEMENTATION_ADDRESS')
  const implementation =
    implementationRaw && isAddress(implementationRaw) && implementationRaw !== ZERO
      ? (implementationRaw as Address)
      : undefined

  const recipientRaw = read('RECIPIENT_ADDRESS')
  const recipient = recipientRaw && isAddress(recipientRaw) ? (recipientRaw as Address) : '0x000000000000000000000000000000000000dEaD'

  const recipient2Raw = read('RECIPIENT2_ADDRESS')
  const recipient2 =
    recipient2Raw && isAddress(recipient2Raw) ? (recipient2Raw as Address) : '0x000000000000000000000000000000000000bEEF'

  return {
    chainId,
    rpcUrl,
    funderKey,
    implementation,
    recipient,
    recipient2,
    maxFundWei: parseEther(read('MAX_FUND_ETH') ?? '0.01'),
    faucetFloorWei: parseEther(read('FAUCET_FLOOR_ETH') ?? '0.005'),
    minFundedBalanceWei: parseEther(read('MIN_FUNDED_BALANCE_ETH') ?? '0.001'),
  }
}

export const LIMITS = {
  /** Max bytes for a raw transaction body. */
  maxRawTxBytes: 128 * 1024,
  /** Max bytes for any JSON API body. */
  maxJsonBytes: 16 * 1024,
  /** Faucet requests per IP per window. */
  fundRequests: 8,
  fundWindowMs: 10 * 60 * 1000,
} as const
