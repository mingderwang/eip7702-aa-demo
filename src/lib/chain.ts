import { anvil, sepolia, type Chain } from 'viem/chains'

export const ANVIL_CHAIN_ID = 31337
export const SEPOLIA_CHAIN_ID = 11155111

/** Resolve the viem chain object for a supported chain id. */
export function resolveChain(chainId: number): Chain {
  if (chainId === ANVIL_CHAIN_ID) return anvil
  if (chainId === SEPOLIA_CHAIN_ID) return sepolia
  throw new Error(`unsupported chain id: ${chainId}`)
}

export function explorerTxUrl(chainId: number, hash: string): string | null {
  if (chainId === SEPOLIA_CHAIN_ID) return `https://sepolia.etherscan.io/tx/${hash}`
  return null
}

export function explorerAddressUrl(chainId: number, address: string): string | null {
  if (chainId === SEPOLIA_CHAIN_ID) return `https://sepolia.etherscan.io/address/${address}`
  return null
}
