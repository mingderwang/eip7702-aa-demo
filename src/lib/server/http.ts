export class ApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export function errorJson(error: unknown): Response {
  if (error instanceof ApiError) {
    return json({ error: error.message, code: error.code }, error.status)
  }
  const message = error instanceof Error ? error.message : 'unexpected error'
  console.error('[api]', error)
  return json({ error: message, code: 'INTERNAL' }, 500)
}

export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const text = await request.text()
  if (text.length > maxBytes) throw new ApiError(413, 'BODY_TOO_LARGE', 'request body too large')
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON')
  }
}

/** Best-effort client IP for rate limiting (Vercel sets x-forwarded-for). */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}
