import Dexie, { type Table } from 'dexie'
import type { Profile, Snapshot, Theme } from '../domain/models'
import { fiscalReceiptKey, receiptOperations, type Receipt, type ReceiptRule } from '../domain/receipts'
import {
  decodeCategory, decodeProfile, decodeTransaction, encodeSnapshot,
  type Authentication, type CloudRecord, type Invitation, type Mutation,
  type Session, type SyncPage, type WireSnapshot,
} from './protocol'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type Change = DistributiveOmit<Mutation, 'id' | 'expectedVersion'>
interface Conflict {
  mutation: Mutation
  record: CloudRecord | null
  message: string
  code?: string
}
interface Restore {
  phase: 'queued' | 'sending' | 'rejected'
  id: string
  snapshot: WireSnapshot
  expectedCursor: number
}
export interface Connection {
  key: 'active'
  session: Session
  mode: 'active' | 'staging'
  cursor: number
  records: CloudRecord[]
  queue: Mutation[]
  review?: string[]
  theme: Theme
  lastCategory: string | null
  conflict?: Conflict
  restore?: Restore
  error?: string
  authRequired?: boolean
  offline?: boolean
}

class CloudDatabase extends Dexie {
  connections!: Table<Connection, string>
  constructor() {
    super('budget-cloud-v1')
    this.version(1).stores({ connections: 'key' })
  }
}
const db = new CloudDatabase()
export const readConnection = () => db.connections.get('active')
export type WorkspaceScope = string
export function workspaceScope(connection?: Connection): WorkspaceScope {
  return connection?.mode === 'active' ? 'cloud:' + connection.session.householdId + ':' + connection.session.memberId : 'local'
}
const sameSession = (a: Session, b: Session) => a.householdId === b.householdId && a.memberId === b.memberId
const sameRecord = (a: Pick<CloudRecord, 'kind' | 'key'>, b: Pick<CloudRecord, 'kind' | 'key'>) => a.kind === b.kind && a.key === b.key
const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('')

function edit<T>(session: Session, update: (connection: Connection) => T) {
  return db.transaction('rw', db.connections, async () => {
    const connection = await readConnection()
    if (!connection || !sameSession(connection.session, session)) return undefined
    const result = update(connection)
    await db.connections.put(connection)
    return result
  })
}

class RequestError extends Error {
  constructor(readonly status: number, message: string, readonly record: CloudRecord | null = null, readonly code?: string) { super(message) }
}
async function api<T>(path: string, body?: unknown, session?: Session): Promise<T> {
  const headers = new Headers()
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  if (session) {
    headers.set('X-Budget-Household', session.householdId)
    headers.set('X-Budget-Member', session.memberId)
  }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 12_000)
  try {
    const response = await fetch('/api/v1/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers, body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store', credentials: 'same-origin', signal: abort.signal,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new RequestError(response.status, data?.error || 'Общий бюджет временно недоступен.', data?.record, data?.code)
    if (!data) throw new Error('Ответ сервера общего бюджета недоступен.')
    return data as T
  } finally { clearTimeout(timer) }
}

export function project(connection: Connection): Snapshot | null {
  const records = new Map<string, CloudRecord>()
  for (const row of connection.records) records.set(row.kind + ':' + row.key, row)
  for (const row of connection.queue) {
    // The pending draft remains in the queue, but a rejected duplicate cannot add to totals.
    if ((connection.conflict?.code === 'receipt_duplicate' || row.kind === 'limitTransfer') &&
        connection.conflict && sameRecord(connection.conflict.mutation, row)) continue
    records.set(row.kind + ':' + row.key, { kind: row.kind, key: row.key, version: row.expectedVersion + 1, value: row.value } as CloudRecord)
  }
  let profile: Profile | undefined
  const categories: Snapshot['categories'] = []
  const members: Snapshot['members'] = []
  const transactions: Snapshot['transactions'] = []
  const receipts: Receipt[] = []
  const receiptRules: ReceiptRule[] = []
  const limitTransfers: NonNullable<Snapshot['limitTransfers']> = []
  const fiscalKeys = new Set<string>()
  for (const row of records.values()) {
    if (!row.value) continue
    if (row.kind === 'profile') profile = decodeProfile(row.value)
    if (row.kind === 'category') categories.push(decodeCategory(row.value))
    if (row.kind === 'member') members.push(row.value)
    if (row.kind === 'transaction') transactions.push(decodeTransaction(row.value))
    if (row.kind === 'receiptRule') receiptRules.push(row.value)
    if (row.kind === 'limitTransfer') limitTransfers.push(row.value)
    if (row.kind === 'receipt') {
      const fiscal = fiscalReceiptKey(row.value.fiscal)
      if (fiscal && fiscalKeys.has(fiscal)) continue
      if (fiscal) fiscalKeys.add(fiscal)
      receipts.push(row.value)
      transactions.push(...receiptOperations(row.value))
    }
  }
  if (!profile) return null
  profile.settings = { ...profile.settings, theme: connection.theme, lastCategory: connection.lastCategory, demo: false }
  transactions.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.id.localeCompare(a.id))
  return {
    version: 3, viewerId: connection.session.memberId, cloudCursor: connection.cursor, profile, transactions, categories, members,
    ...(receipts.length ? { receipts } : {}),
    ...(receiptRules.length ? { receiptRules } : {}),
    limitTransfers,
  }
}

function enqueue(connection: Connection, change: Change) {
  const previous = connection.queue.findLast(row => sameRecord(row, change))
  const confirmed = connection.records.find(row => sameRecord(row, change))
  const expectedVersion = previous ? previous.expectedVersion + 1 : confirmed?.version ?? 0
  connection.queue.push({ ...change, id: id(), expectedVersion } as Mutation)
}

export async function writeCloud(connection: Connection, update: (current: Connection, snapshot: Snapshot) => Change | null) {
  const written = await edit(connection.session, current => {
    if (current.mode !== 'active' || current.authRequired || current.restore) throw new Error('Сначала завершите подключение или восстановление общего бюджета.')
    const snapshot = project(current)
    if (!snapshot) throw new Error('Общий бюджет ещё загружается.')
    const change = update(current, snapshot)
    if (change) enqueue(current, change)
    return true
  })
  if (!written) throw new Error('Профиль общего бюджета изменился.')
  void syncCloud(true)
}

export async function authenticate(action: 'households' | 'join' | 'recover', body: unknown, theme: Theme, stage = false) {
  const previous = await readConnection()
  if ((previous?.queue.length || previous?.restore) && action !== 'recover') throw new Error('Сначала отправьте или сохраните ожидающие изменения.')
  const expectedRecovery = action === 'recover' ? previous?.session : undefined
  const auth = await api<Authentication>(action, body, expectedRecovery)
  await db.transaction('rw', db.connections, async () => {
    const existing = await readConnection()
    if (existing && sameSession(existing.session, auth.session)) {
      existing.authRequired = false
      existing.error = undefined
      existing.session = auth.session
      await db.connections.put(existing)
      return
    }
    if (existing?.queue.length || existing?.restore) throw new Error('Этот код относится к другому профилю. Восстановите исходный профиль для отправки изменений.')
    await db.connections.put({ key: 'active', session: auth.session, mode: stage ? 'staging' : 'active', cursor: 0, records: [], queue: [], theme, lastCategory: null })
  })
  void syncCloud(true)
  return auth
}

export async function confirmRecovery(session: Session, code: string) {
  const current = await readConnection()
  if (!current || !sameSession(current.session, session)) throw new Error('Профиль изменился. Откройте восстановление заново.')
  await api<{ ok: true }>('recover/confirm', { code }, session)
}

export const invite = (session: Session) => api<Invitation>('invite', {}, session)
export async function revoke(session: Session, memberId: string) {
  await api('members/revoke', { memberId }, session)
  await syncCloud(true)
}

export async function disconnect(session: Session, options: { discard?: boolean; unavailable?: boolean; leave?: boolean } = {}) {
  const { discard = false, unavailable = false, leave = false } = options
  const connection = await readConnection()
  if (!connection || !sameSession(connection.session, session)) return
  if ((connection.queue.length || connection.restore) && !discard) throw new Error('Сначала отправьте изменения или сохраните копию и подтвердите выход.')
  if (!unavailable) {
    try { await api(leave ? 'members/leave' : 'logout', {}, session) }
    catch (error) {
      if (leave || !(error instanceof RequestError && error.status === 401)) throw error
    }
  } else if (!connection.authRequired) throw new Error('Сессия ещё активна.')
  await db.transaction('rw', db.connections, async () => {
    const current = await readConnection()
    if (current && sameSession(current.session, session)) {
      if (!discard && (current.queue.length || current.restore)) throw new Error('Есть ожидающие изменения.')
      await db.connections.delete('active')
    }
  })
}

function receive(connection: Connection, row: CloudRecord) {
  const index = connection.records.findIndex(record => sameRecord(record, row))
  if (index === -1) connection.records.push(row)
  else if (connection.records[index].version <= row.version) connection.records[index] = row
}

export async function restoreCloud(snapshot: Snapshot, connection: Connection, expectedCursor = connection.cursor) {
  if (connection.session.role !== 'owner') throw new Error('Восстановить общий бюджет может только владелец.')
  const wire = encodeSnapshot(snapshot)
  const result = await edit(connection.session, current => {
    if (current.queue.length || current.conflict) throw new Error('Сначала отправьте ожидающие изменения.')
    if (current.restore) throw new Error('Другой перенос ещё ожидает подтверждения.')
    if (current.cursor !== expectedCursor) throw new Error('Общий бюджет изменился. Проверьте актуальные данные и подтвердите перенос заново.')
    if (current.cursor === 0) throw new Error('Дождитесь первой синхронизации.')
    current.restore = { phase: 'queued', id: id(), snapshot: wire, expectedCursor }
    return true
  })
  if (!result) throw new Error('Сессия общего бюджета изменилась.')
  await syncCloud(true)
  const latest = await readConnection()
  if (!latest || !sameSession(latest.session, connection.session) || latest.restore) {
    throw new Error(latest?.error ?? 'Перенос сохранён в очереди и продолжится при подключении.')
  }
}

async function pull(connection: Connection) {
  const { session } = connection
  const current = await readConnection()
  if (!current || !sameSession(current.session, session)) return
  const since = current.cursor
  let cursor = since
  let reset = false
  const received: CloudRecord[] = []
  for (;;) {
    const page = await api<SyncPage>('sync?after=' + cursor, undefined, session)
    if (!Number.isSafeInteger(page.cursor) || page.cursor < 0 ||
        (!page.reset && (page.cursor < cursor || (page.more && page.cursor === cursor)))) {
      throw new Error('Сервер вернул неверную ревизию.')
    }
    if (page.reset) { received.length = 0; reset = true }
    received.push(...page.records)
    cursor = page.cursor
    if (!page.more) break
  }
  if (cursor === since && received.length === 0 && !reset && !current.offline) return
  await edit(session, state => {
    if (state.cursor !== since) return
    if (reset) state.records = []
    for (const row of received) receive(state, row)
    state.cursor = cursor
    state.offline = false
  })
}

let syncTask: Promise<void> | undefined
let failures = 0
let retryAfter = 0
let resync = false
export function syncCloud(force = false): Promise<void> {
  if (syncTask) {
    if (force) resync = true
    return syncTask
  }
  if (!force && Date.now() < retryAfter) return Promise.resolve()
  syncTask = runSync().finally(() => {
    syncTask = undefined
    if (resync) {
      resync = false
      void syncCloud(true)
    }
  })
  return syncTask
}

async function runSync() {
  const connection = await readConnection()
  if (!connection || connection.authRequired) return
  const { session } = connection
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    await edit(session, state => { state.offline = true })
    return
  }
  try {
    if (connection.restore) {
      const restore = connection.restore
      if (restore.phase === 'rejected') { await pull(connection); return }
      const sending = await edit(session, state => {
        if (state.restore?.id !== restore.id || state.restore.phase === 'rejected') return false
        state.restore.phase = 'sending'
        return true
      })
      if (!sending) return
      try {
        await api('migrate', { id: restore.id, expectedCursor: restore.expectedCursor, snapshot: restore.snapshot }, session)
      } catch (error) {
        if (error instanceof RequestError && [400, 409, 413, 422].includes(error.status)) {
          await edit(session, state => {
            if (state.restore?.id !== restore.id) return
            state.restore.phase = 'rejected'
            state.error = error.status === 409 ? 'Общий бюджет изменился. Сохраните копию и подтвердите перенос заново.' : error.message
          })
          await pull(connection)
          return
        }
        throw error
      }
      await pull(connection)
      await edit(session, state => {
        if (state.restore?.id === restore.id) {
          state.restore = undefined
          state.mode = 'active'
        }
      })
    }
    for (;;) {
      const state = await readConnection()
      if (!state || !sameSession(state.session, session)) return
      const mutation = state.queue[0]
      if (!mutation || state.conflict) break
      if (state.review?.includes(mutation.id)) {
        await edit(session, current => {
          if (current.queue[0]?.id !== mutation.id) return
          const record = current.records.find(row => sameRecord(row, mutation)) ?? null
          current.conflict = { mutation, record, message: 'Эта правка опиралась на предыдущую локальную версию. Проверьте её перед отправкой.' }
        })
        break
      }
      try {
        const { record } = await api<{ record: CloudRecord }>('sync/mutate', mutation, session)
        await edit(session, current => {
          receive(current, record)
          current.queue = current.queue.filter(row => row.id !== mutation.id)
        })
      } catch (error) {
        if (!(error instanceof RequestError && (error.status === 409 || error.status === 400 || error.status === 422))) throw error
        await edit(session, current => {
          if (current.queue[0]?.id !== mutation.id) return
          current.conflict = { mutation, record: error.record, message: error.message, code: error.code }
          if (error.code === 'receipt_duplicate' && error.record) receive(current, error.record)
        })
        break
      }
    }
    await pull(connection)
    failures = 0
    retryAfter = 0
    await edit(session, state => { state.error = undefined; state.offline = false })
  } catch (error) {
    failures++
    retryAfter = Date.now() + Math.min(120_000, 5_000 * 2 ** Math.min(failures - 1, 5))
    await edit(session, state => {
      if (error instanceof RequestError && (error.status === 401 || error.status === 403)) state.authRequired = true
      state.offline = typeof navigator !== 'undefined' && navigator.onLine === false
      state.error = error instanceof RequestError ? error.message : 'Нет связи с общим бюджетом. Изменения сохранены на устройстве.'
    })
  }
}

export async function cancelRestore(session: Session) {
  await edit(session, state => {
    if (!state.restore) throw new Error('Общий бюджет уже подтвердил перенос.')
    if (state.restore.phase === 'sending') throw new Error('Дождитесь ответа сервера. Перенос мог уже примениться.')
    state.restore = undefined
    state.error = undefined
  })
}

export async function resolveConflict(session: Session, choice: 'server' | 'local', newAmount?: number) {
  await edit(session, state => {
    const conflict = state.conflict
    if (!conflict) return
    if (conflict.code === 'receipt_duplicate' && choice === 'local') throw new Error('Этот чек уже добавлен. Откройте существующий чек.')
    if (conflict.record) receive(state, conflict.record)
    const [head, ...rest] = state.queue
    if (head?.id === conflict.mutation.id) {
      state.queue = conflict.code === 'receipt_duplicate' ? rest.filter(row => !sameRecord(row, head)) : rest
      const pendingIds = new Set(state.queue.map(row => row.id))
      const dependent = state.queue.filter(row => sameRecord(row, head)).map(row => row.id)
      state.review = [...new Set([...(state.review ?? []).filter(id => pendingIds.has(id)), ...dependent])]
      if (choice === 'local') {
        const actual = state.records.find(record => sameRecord(record, head))
        const retry = { ...head, id: id(), expectedVersion: actual?.version ?? 0 }
        if (newAmount !== undefined && retry.kind === 'transaction' && retry.value) {
          retry.value = { ...retry.value, amount: String(newAmount) }
        }
        state.queue.unshift(retry)
      }
    }
    state.conflict = undefined
  })
  void syncCloud(true)
}

export function startCloudSync() {
  const active = () => { if (!document.hidden) void syncCloud(true) }
  const timer = setInterval(() => { if (!document.hidden) void syncCloud() }, 20_000)
  window.addEventListener('online', active)
  window.addEventListener('offline', active)
  document.addEventListener('visibilitychange', active)
  active()
  return () => {
    clearInterval(timer)
    window.removeEventListener('online', active)
    window.removeEventListener('offline', active)
    document.removeEventListener('visibilitychange', active)
  }
}
