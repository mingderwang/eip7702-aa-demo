import type { APIRoute } from 'astro'
import { isAddress, type Address } from 'viem'
import { decodeDesignator } from '../../lib/eip7702'
import { getPublicClient } from '../../lib/server/clients'
import { ApiError, errorJson, json } from '../../lib/server/http'

export const prerender = false

export const GET: APIRoute = async ({ url }) => {
  try {
    const raw = url.searchParams.get('address')
    if (!raw || !isAddress(raw)) {
      throw new ApiError(400, 'INVALID_ADDRESS', 'query parameter `address` must be a valid EVM address')
    }
    const address = raw as Address
    const client = getPublicClient()

    const [balance, nonce, code] = await Promise.all([
      client.getBalance({ address }),
      client.getTransactionCount({ address, blockTag: 'pending' }),
      client.getCode({ address }),
    ])

    const designator = decodeDesignator(code)

    return json({
      address,
      balance: balance.toString(),
      nonce,
      code: designator.code,
      delegated: designator.delegated,
      implementation: designator.delegated ? designator.implementation : null,
    })
  } catch (error) {
    return errorJson(error)
  }
}
