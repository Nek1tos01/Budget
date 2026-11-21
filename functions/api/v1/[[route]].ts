import {
  confirmRecovery, createHousehold, currentSession, invite, joinHousehold, leaveHousehold, logout, recover, refreshCookie,
  requireActor, requireScope, revoke,
} from '../../../server/auth'
import { databaseError, type D1Database } from '../../../server/database'
import { ApiError, isLocalHttp, json, readJson } from '../../../server/http'
import { restore } from '../../../server/migrate'
import { mutate, sync } from '../../../server/sync'

interface Env { DB: D1Database }
interface ApiContext { request: Request; env: Env }

const postRoutes = new Set([
  'households', 'join', 'recover', 'recover/confirm', 'invite', 'members/revoke', 'members/leave', 'logout', 'sync/mutate', 'migrate',
])
const getRoutes = new Set(['session', 'sync'])

async function handle({ request, env: { DB: db } }: ApiContext) {
  const url = new URL(request.url)
  if (url.protocol !== 'https:' && !isLocalHttp(url)) throw new ApiError(400, 'Для доступа необходим HTTPS.')
  const route = url.pathname.slice('/api/v1/'.length)
  const isPost = postRoutes.has(route)
  const isGet = getRoutes.has(route)
  if (!isPost && !isGet) throw new ApiError(404, 'Маршрут не найден.')
  if (request.method !== (isPost ? 'POST' : 'GET')) {
    return json({ error: 'Этот метод запроса не поддерживается.' }, 405, { Allow: isPost ? 'POST' : 'GET' })
  }
  if (isPost && request.headers.get('Origin') !== url.origin) {
    throw new ApiError(403, 'Неверный источник запроса.')
  }
  const now = Date.now()
  if (route === 'households' || route === 'join' || route === 'recover') {
    const body = await readJson(request, 32 * 1024)
    const attemptTime = Date.now()
    if (route === 'households') return createHousehold(db, request, body, attemptTime)
    if (route === 'join') return joinHousehold(db, request, body, attemptTime)
    return recover(db, request, body, attemptTime)
  }
  const actor = await requireActor(db, request, now)
  if (route === 'session') return currentSession(db, request, actor, now)
  requireScope(actor, request)
  if (route === 'sync') {
    const response = await sync(db, actor, url, now)
    const refreshed = await refreshCookie(db, request, actor, now)
    if (refreshed) response.headers.set('Set-Cookie', refreshed)
    return response
  }
  const body = await readJson(request, route === 'migrate' || route === 'sync/mutate' ? 1024 * 1024 : 32 * 1024)
  const writeTime = Date.now()
  if (route === 'recover/confirm') return confirmRecovery(db, actor, body, writeTime)
  if (route === 'invite') return invite(db, actor, body, writeTime)
  if (route === 'members/revoke') return revoke(db, actor, body, writeTime)
  if (route === 'members/leave') return leaveHousehold(db, request, actor, body, writeTime)
  if (route === 'logout') return logout(db, request, actor, body)
  // Refresh the clock after the body stream so a slow client cannot extend a session's validity.
  if (route === 'sync/mutate') return mutate(db, actor, body, writeTime)
  return restore(db, actor, body, writeTime)
}

export async function onRequest(context: ApiContext): Promise<Response> {
  try {
    try {
      return await handle(context)
    } catch (error) {
      databaseError(error)
    }
  } catch (error) {
    if (error instanceof ApiError) {
      const retry = error.details?.retryAfter
      return json({ error: error.message, ...error.details }, error.status,
        typeof retry === 'number' ? { 'Retry-After': String(retry) } : undefined)
    }
    return json({ error: 'Сервис бюджета временно недоступен. Повторите попытку позже.' }, 503)
  }
}
