import type { APIRoute } from 'astro'
import { getFunderWallet, getPublicClient } from '../../lib/server/clients'
import { getConfig } from '../../lib/server/env'
import { errorJson, json } from '../../lib/server/http'

export const prerender = false

export const GET: APIRoute = async () => {
  try {
    const config = getConfig()
    const funder = getFunderWallet()

    let faucetBalance: bigint | null = null
    if (funder) {
      try {
        faucetBalance = await getPublicClient().getBalance({ address: funder.address })
      } catch {
        faucetBalance = null
      }
    }

    return json({
      chainId: config.chainId,
      chainName: config.chainId === 31337 ? 'Anvil (local)' : 'Sepolia',
      implementation: config.implementation ?? null,
      recipient: config.recipient,
      recipient2: config.recipient2,
      explorer: config.chainId === 11155111 ? 'https://sepolia.etherscan.io' : null,
      funding: {
        enabled: Boolean(funder && config.implementation),
        faucet: funder?.address ?? null,
        faucetBalanceWei: faucetBalance === null ? null : faucetBalance.toString(),
        amountWei: config.maxFundWei.toString(),
      },
      limits: {
        maxFundWei: config.maxFundWei.toString(),
        faucetFloorWei: config.faucetFloorWei.toString(),
      },
    })
  } catch (error) {
    return errorJson(error)
  }
}
