import type { APIRoute } from 'astro'
import { isAddress, type Address } from 'viem'
import { getConfig, LIMITS } from '../../lib/server/env'
import { fundAccount } from '../../lib/server/funder'
import { ApiError, clientIp, errorJson, json, readJson } from '../../lib/server/http'
import { rateLimit } from '../../lib/server/rateLimit'

export const prerender = false

export const POST: APIRoute = async ({ request }) => {
  try {
    const limit = rateLimit(`fund:${clientIp(request)}`, LIMITS.fundRequests, LIMITS.fundWindowMs)
    if (!limit.ok) {
      throw new ApiError(
        429,
        'RATE_LIMITED',
        `too many faucet requests, retry in ${Math.ceil(limit.retryAfterMs / 1000)}s`,
      )
    }

    const body = (await readJson(request, LIMITS.maxJsonBytes)) as { address?: string } | null
    if (!body?.address || !isAddress(body.address)) {
      throw new ApiError(400, 'INVALID_ADDRESS', 'body must contain a valid `address`')
    }

    const config = getConfig()
    if (!config.implementation) {
      throw new ApiError(503, 'NOT_CONFIGURED', 'IMPLEMENTATION_ADDRESS is not configured')
    }

    const result = await fundAccount(body.address as Address)

    return json({
      ok: true,
      hash: result.hash,
      amountWei: result.amount.toString(),
      balanceWei: result.balance.toString(),
      skipped: result.skipped,
      faucet: result.faucet,
      reason: result.skipped ? 'address already funded' : null,
    })
  } catch (error) {
    return errorJson(error)
  }
}
