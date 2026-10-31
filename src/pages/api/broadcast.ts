import type { APIRoute } from 'astro'
import { recoverTransactionAddress, type Address, type Hex, type TransactionSerialized } from 'viem'
import { DELEGATION_PREFIX } from '../../lib/eip7702'
import { getPublicClient } from '../../lib/server/clients'
import { getConfig, LIMITS } from '../../lib/server/env'
import { ApiError, clientIp, errorJson, json, readJson } from '../../lib/server/http'
import { rateLimit } from '../../lib/server/rateLimit'

export const prerender = false

/**
 * Relays an already-signed raw transaction to the chain.
 *
 * The server never sees a private key: the browser signs locally and only sends bytes.
 * Accepted types:
 *   - 0x04 (EIP-7702 set-code): required for the delegation + batch transaction
 *   - 0x02 (EIP-1559): only when the sender already carries a delegation designator
 * This keeps the endpoint from becoming a generic transaction relay.
 */
export const POST: APIRoute = async ({ request }) => {
  try {
    const limit = rateLimit(`broadcast:${clientIp(request)}`, 60, 60_000)
    if (!limit.ok) throw new ApiError(429, 'RATE_LIMITED', 'too many broadcasts, slow down')

    const body = (await readJson(request, LIMITS.maxRawTxBytes)) as { raw?: string } | null
    const raw = body?.raw

    if (!raw || !/^0x[0-9a-fA-F]+$/.test(raw)) {
      throw new ApiError(400, 'INVALID_RAW_TX', 'body must contain a hex-encoded `raw` transaction')
    }
    if (raw.length > LIMITS.maxRawTxBytes * 2) {
      throw new ApiError(413, 'BODY_TOO_LARGE', 'raw transaction too large')
    }

    const type = raw.slice(0, 4).toLowerCase()
    if (type !== '0x04' && type !== '0x02') {
      throw new ApiError(
        400,
        'UNSUPPORTED_TX_TYPE',
        'only type-0x04 (EIP-7702) and type-0x02 (from delegated accounts) are accepted',
      )
    }

    getConfig() // fail fast on bad configuration
    const client = getPublicClient()

    if (type === '0x02') {
      let sender: Address
      try {
        sender = await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized })
      } catch {
        throw new ApiError(400, 'INVALID_RAW_TX', 'could not recover the transaction sender')
      }

      const code = await client.getCode({ address: sender })
      if (!code || !code.toLowerCase().startsWith(DELEGATION_PREFIX)) {
        throw new ApiError(
          403,
          'NOT_DELEGATED',
          `sender ${sender} is not an EIP-7702 delegated account; send a type-0x04 transaction`,
        )
      }
    }

    const hash = await client.request({
      method: 'eth_sendRawTransaction',
      params: [raw as Hex],
    })

    return json({ ok: true, hash })
  } catch (error) {
    if (error instanceof ApiError) return errorJson(error)
    const message = error instanceof Error ? error.message : 'broadcast failed'
    return json({ error: message, code: 'BROADCAST_FAILED' }, 502)
  }
}
