import { encodeFunctionData, type Address, type Hex } from 'viem'
import { batchExecutorAbi } from './generated/batchExecutor'

/**
 * EIP-7702 delegation designator: `0xef0100 || address`.
 * https://eips.ethereum.org/EIPS/eip-7702
 */
export const DELEGATION_PREFIX = '0xef0100'

/** ERC-1271 magic value returned for a valid signature. */
export const ERC1271_MAGIC = '0x1626ba7e'

/** Generous fixed gas limit: auth list + 2 calls. Avoids relying on node-side estimation for type-4 txs. */
export const BATCH_GAS_LIMIT = 500_000n

export type BatchCall = {
  to: Address
  value: bigint
  data: Hex
}

export type Designator =
  | { delegated: false; code: Hex | null }
  | { delegated: true; implementation: Address; code: Hex }

/**
 * Decode the code stored at an EOA. After an EIP-7702 authorization is applied the account
 * code becomes `0xef0100 || implementation`, so `eth_getCode` is the source of truth for
 * "is this account abstracted?".
 */
export function decodeDesignator(code: Hex | null | undefined): Designator {
  if (!code || code === '0x') return { delegated: false, code: null }

  const normalized = code.toLowerCase() as Hex
  if (!normalized.startsWith(DELEGATION_PREFIX)) return { delegated: false, code: normalized }

  const raw = normalized.slice(DELEGATION_PREFIX.length)
  if (!/^[0-9a-f]{40}$/.test(raw)) return { delegated: false, code: normalized }

  return {
    delegated: true,
    implementation: `0x${raw}` as Address,
    code: normalized,
  }
}

/** ABI-encode `execute(Call[])` for the delegation target. */
export function encodeExecute(calls: readonly BatchCall[]): Hex {
  return encodeFunctionData({
    abi: batchExecutorAbi,
    functionName: 'execute',
    args: [
      calls.map((call) => ({
        to: call.to,
        value: call.value,
        data: call.data,
      })),
    ],
  })
}

/**
 * EIP-7702 authorizations are signed over `nonce = accountNonce` at *processing* time.
 * A self-executing type-4 transaction bumps the sender nonce before the authorization list
 * is processed, so the authorization must be signed over `txNonce + 1`.
 */
export function authorizationNonce(txNonce: bigint): bigint {
  return txNonce + 1n
}

export type AccountSnapshot = {
  address: Address
  balance: bigint
  nonce: number
  code: Hex | null
  delegated: boolean
  implementation: Address | null
}
