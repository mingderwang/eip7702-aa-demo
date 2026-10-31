import { createPublicClient, createWalletClient, http, type Address, type PublicClient, type WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { resolveChain } from '../chain'
import { getConfig } from './env'

export function getPublicClient(): PublicClient {
  const config = getConfig()
  return createPublicClient({
    chain: resolveChain(config.chainId),
    transport: http(config.rpcUrl, { timeout: 30_000, retryCount: 2 }),
  }) as PublicClient
}

export function getFunderWallet(): { address: Address; client: WalletClient } | null {
  const config = getConfig()
  if (!config.funderKey) return null
  const account = privateKeyToAccount(config.funderKey)
  const client = createWalletClient({
    account,
    chain: resolveChain(config.chainId),
    transport: http(config.rpcUrl, { timeout: 30_000, retryCount: 2 }),
  })
  return { address: account.address, client: client as WalletClient }
}
