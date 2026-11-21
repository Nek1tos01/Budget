export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly details?: Record<string, unknown>) {
    super(message)
  }
}

export function json(data: unknown, status = 200, extra?: HeadersInit) {
  const headers = new Headers(extra)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'private, no-store')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Vary', 'Cookie')
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  return new Response(JSON.stringify(data), { status, headers })
}

export function isLocalHttp(url: URL) {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

export async function readJson(request: Request, byteLimit: number): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'Запрос должен быть в формате JSON.')
  }
  if (Number(request.headers.get('content-length')) > byteLimit) throw tooLarge()
  if (!request.body) throw new ApiError(400, 'Отсутствует тело запроса.')
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let result = ''
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > byteLimit) throw tooLarge()
      result += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(result + decoder.decode())
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(400, 'Запрос содержит некорректный JSON.')
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function tooLarge() { return new ApiError(413, 'Размер запроса превышает допустимый.') }

export async function sha256(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function secret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export const isSecret = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value)
