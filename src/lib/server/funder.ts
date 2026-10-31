import type { Address, Hex } from 'viem'
import { getFunderWallet, getPublicClient } from './clients'
import { getConfig } from './env'
import { ApiError } from './http'

export type FundResult = {
  hash: Hex | null
  amount: bigint
  skipped: boolean
  balance: bigint
  faucet: Address
}

/**
 * Demo faucet: sends testnet ETH from the server-side funder key to a freshly created account.
 *
 * Guards (important on a public deployment):
 *  - idempotent: an address that already holds `MIN_FUNDED_BALANCE_ETH` is never funded twice
 *  - faucet floor: refuses to spend below `FAUCET_FLOOR_ETH`
 *  - fixed amount: no caller-controlled value
 */
export async function fundAccount(address: Address): Promise<FundResult> {
  const config = getConfig()
  const funder = getFunderWallet()
  if (!funder) {
    throw new ApiError(503, 'FAUCET_DISABLED', 'faucet disabled: FUNDER_PRIVATE_KEY is not configured')
  }

  const publicClient = getPublicClient()
  const current = await publicClient.getBalance({ address })
  if (current >= config.minFundedBalanceWei) {
    return { hash: null, amount: 0n, skipped: true, balance: current, faucet: funder.address }
  }

  const faucetBalance = await publicClient.getBalance({ address: funder.address })
  if (faucetBalance < config.maxFundWei + config.faucetFloorWei) {
    throw new ApiError(
      503,
      'FAUCET_EMPTY',
      `faucet ${funder.address} is low on funds (${faucetBalance} wei)`,
    )
  }

  const hash = await funder.client.sendTransaction({
    account: funder.client.account!,
    chain: funder.client.chain,
    to: address,
    value: config.maxFundWei,
  })

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 })
  if (receipt.status !== 'success') {
    throw new ApiError(502, 'FUND_TX_REVERTED', `funding transaction ${hash} reverted`)
  }

  const balance = await publicClient.getBalance({ address })
  return { hash, amount: config.maxFundWei, skipped: false, balance, faucet: funder.address }
}
