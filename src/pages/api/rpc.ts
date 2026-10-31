import type { APIRoute } from 'astro'
import { getConfig, LIMITS } from '../../lib/server/env'
import { ApiError, clientIp, errorJson, json, readJson } from '../../lib/server/http'
import { rateLimit } from '../../lib/server/rateLimit'

export const prerender = false

/**
 * Read-only JSON-RPC proxy used by the browser's viem public client.
 *
 * Keeps the upstream RPC URL server-side and avoids CORS problems. Write methods are
 * intentionally not allowed: signed transactions go through `/api/broadcast` instead.
 */
const ALLOWED_METHODS = new Set([
  'eth_chainId',
  'net_version',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_getTransactionCount',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_call',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
])

type RpcBody = { jsonrpc?: string; id?: number | string; method?: string; params?: unknown[] }

export const POST: APIRoute = async ({ request }) => {
  try {
    const limit = rateLimit(`rpc:${clientIp(request)}`, 1200, 60_000)
    if (!limit.ok) throw new ApiError(429, 'RATE_LIMITED', 'too many RPC calls')

    const body = (await readJson(request, LIMITS.maxJsonBytes)) as RpcBody | null
    if (!body || typeof body.method !== 'string' || !Array.isArray(body.params ?? [])) {
      throw new ApiError(400, 'INVALID_REQUEST', 'malformed JSON-RPC request')
    }
    if (!ALLOWED_METHODS.has(body.method)) {
      throw new ApiError(403, 'METHOD_NOT_ALLOWED', `method ${body.method} is not allowed on this proxy`)
    }

    const config = getConfig()
    const upstream = await fetch(config.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: body.id ?? 1,
        method: body.method,
        params: body.params ?? [],
      }),
      signal: AbortSignal.timeout(30_000),
    })

    const text = await upstream.text()
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  } catch (error) {
    if (error instanceof ApiError) return errorJson(error)
    const message = error instanceof Error ? error.message : 'upstream RPC failed'
    return json({ error: message, code: 'RPC_FAILED' }, 502)
  }
}
