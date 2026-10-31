import type { Address, Hex, PublicClient, WalletClient } from 'viem'
import { type BatchCall, authorizationNonce, encodeExecute } from './eip7702'

export const DELEGATED_BATCH_GAS = 500_000n
export const PLAIN_TX_GAS = 120_000n

export type FeeQuote = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }

/** EIP-1559 fee quote with a legacy fallback for RPCs without `eth_maxPriorityFeePerGas`. */
export async function quoteFees(publicClient: PublicClient): Promise<FeeQuote> {
  try {
    const estimate = await publicClient.estimateFeesPerGas()
    return {
      maxFeePerGas: estimate.maxFeePerGas,
      maxPriorityFeePerGas: estimate.maxPriorityFeePerGas,
    }
  } catch {
    const gasPrice = await publicClient.getGasPrice()
    return { maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: gasPrice }
  }
}

export type BuiltTransaction = {
  raw: Hex
  nonce: bigint
  gas: bigint
  data: Hex
  fees: FeeQuote
  /** Set only when this transaction also carries the EIP-7702 authorization. */
  authorization: { contractAddress: Address; nonce: bigint } | null
}

/**
 * Builds and signs a **self-executing** EIP-7702 (type 0x04) transaction:
 * the account delegates to `implementation` and immediately calls `execute(calls)` on itself
 * in the same transaction, paying gas from its own balance.
 *
 * No bundler, paymaster or external wallet is involved — only this account's key.
 */
export async function buildDelegatedBatchTx(params: {
  publicClient: PublicClient
  wallet: WalletClient
  account: { address: Address }
  implementation: Address
  calls: readonly BatchCall[]
  chainId: number
  gas?: bigint
}): Promise<BuiltTransaction> {
  const { publicClient, wallet, account, implementation, calls, chainId } = params
  const gas = params.gas ?? DELEGATED_BATCH_GAS

  const nonce = BigInt(await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }))
  const fees = await quoteFees(publicClient)

  // Authorization nonce must match the account nonce *at processing time*: the type-4 tx
  // bumps the sender nonce before the authorization list is applied.
  const authNonce = authorizationNonce(nonce)
  const authorization = await wallet.signAuthorization({
    account: account as never,
    contractAddress: implementation,
    chainId,
    nonce: authNonce,
  })

  const data = encodeExecute(calls)
  const raw = await wallet.signTransaction({
    account: account as never,
    chainId,
    to: account.address,
    data,
    nonce,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    authorizationList: [authorization],
  })

  return {
    raw,
    nonce,
    gas,
    data,
    fees,
    authorization: { contractAddress: implementation, nonce: authNonce },
  }
}

/** Builds and signs a plain type-2 transaction from an already delegated account. */
export async function buildPlainTx(params: {
  publicClient: PublicClient
  wallet: WalletClient
  account: { address: Address }
  to: Address
  value: bigint
  chainId: number
  data?: Hex
  gas?: bigint
}): Promise<BuiltTransaction> {
  const { publicClient, wallet, account, to, value, chainId } = params
  const nonce = BigInt(await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }))
  const fees = await quoteFees(publicClient)
  const data = params.data ?? '0x'
  const gas = params.gas ?? PLAIN_TX_GAS

  const raw = await wallet.signTransaction({
    account: account as never,
    chainId,
    to,
    value,
    data,
    nonce,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  } as never)

  return { raw, nonce, gas, data, fees, authorization: null }
}
