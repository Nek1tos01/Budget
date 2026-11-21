import 'fake-indexeddb/auto'
import { expect, test, vi } from 'vitest'
import { authenticate, disconnect, project, readConnection, resolveConflict, syncCloud, writeCloud } from '../src/cloud/client'
import { encodeCategory, encodeProfile, encodeTransaction, fromCents, type CloudRecord, type Mutation } from '../src/cloud/protocol'
import { repository } from '../src/data/repository'
import { newSnapshot } from '../src/data/demo'
import { parseFiscalQr, type Receipt } from '../src/domain/receipts'

test('десятичные копейки сохраняют точность, небезопасные значения отклоняются', () => {
  expect(fromCents('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER)
  for (const amount of ['9007199254740992', '1e6', '12.01', '01', '-1']) expect(() => fromCents(amount)).toThrow()
})

test('после потерянного подтверждения очередь повторяет ту же мутацию', async () => {
  const snapshot = newSnapshot(false)
  const session = { householdId: 'example-household', memberId: snapshot.members[0].id, role: 'owner' as const }
  const initial = [
    { kind: 'profile', key: 'household', version: 1, value: encodeProfile(snapshot.profile) },
    { kind: 'category', key: snapshot.categories[0].id, version: 1, value: encodeCategory(snapshot.categories[0]) },
    ...snapshot.members.map(member => ({ kind: 'member', key: member.id, version: 1, value: member })),
  ] as CloudRecord[]
  const sends: Mutation[] = []
  let stored: CloudRecord | undefined
  const row = { id: 'new-row', type: 'expense' as const, amount: 50501, categoryId: snapshot.categories[0].id, memberId: session.memberId, date: '2026-11-20', note: 'Черновик' }

  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith('/households')) return Response.json({ session, recoveryCode: 'test-only' })
    if (url.endsWith('/logout')) return Response.json({ ok: true })
    expect(new Headers(options.headers).get('X-Budget-Household')).toBe(session.householdId)
    if (url.includes('/sync?')) {
      const after = Number(url.split('=').at(-1))
      return Response.json({ cursor: stored ? 5 : 4, more: false, records: after < 4 ? initial : after < 5 && stored ? [stored] : [] })
    }
    const mutation = JSON.parse(String(options.body)) as Mutation
    sends.push(mutation)
    if (!stored) {
      stored = { kind: 'transaction', key: mutation.key, version: 1, value: encodeTransaction(row) }
      throw new TypeError('lost response')
    }
    return Response.json({ record: stored })
  }))
  try {
    await authenticate('households', {}, 'dark')
    await vi.waitFor(async () => expect((await readConnection())?.cursor).toBe(4))
    await expect(repository.putTransaction(row, undefined, 'local')).rejects.toThrow('Бюджет изменился')
    await writeCloud((await readConnection())!, () => ({ kind: 'transaction', key: row.id, value: encodeTransaction(row) }))
    await vi.waitFor(async () => expect((await readConnection())?.error).toContain('Нет связи'))
    const offline = (await readConnection())!
    expect(offline.queue).toHaveLength(1)
    expect(project(offline)?.transactions).toEqual([row])
    await syncCloud(true)
    const synced = (await readConnection())!
    expect(sends).toHaveLength(2)
    expect(sends[1]).toEqual(sends[0])
    expect(synced.queue).toHaveLength(0)
    expect(project(synced)?.transactions).toEqual([row])
    await disconnect(synced.session)
    expect(await readConnection()).toBeUndefined()
  } finally { vi.unstubAllGlobals() }
})


test('принятие серверной версии не перезаписывается зависимой офлайн-правкой', async () => {
  const snapshot = newSnapshot(false)
  const session = { householdId: 'conflicting-household', memberId: snapshot.members[0].id, role: 'owner' as const }
  const row = { id: 'conflict-row', type: 'expense' as const, amount: 50000, categoryId: snapshot.categories[0].id, memberId: session.memberId, date: '2026-11-20', note: '' }
  const existing = { kind: 'transaction' as const, key: row.id, version: 1, value: encodeTransaction(row) }
  const server = { ...existing, version: 2, value: encodeTransaction({ ...row, amount: 80000 }) }
  const initial = [{ kind: 'profile', key: 'household', version: 1, value: encodeProfile(snapshot.profile) }, existing]
  const network = { onLine: true }
  const sent: Mutation[] = []
  vi.stubGlobal('navigator', network)
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith('/households')) return Response.json({ session, recoveryCode: 'test-only' })
    if (url.endsWith('/logout')) return Response.json({ ok: true })
    if (url.includes('/sync?')) return Response.json(Number(url.split('=').at(-1)) === 0
      ? { cursor: 2, records: initial, more: false }
      : { cursor: 3, records: [server], more: false })
    sent.push(JSON.parse(String(options.body)) as Mutation)
    return Response.json({ error: 'Версия устарела', record: server }, { status: 409 })
  }))
  try {
    await authenticate('households', {}, 'dark')
    await vi.waitFor(async () => expect((await readConnection())?.cursor).toBeGreaterThanOrEqual(2))
    network.onLine = false
    for (const amount of [70000, 90000]) {
      await writeCloud((await readConnection())!, () => ({ kind: 'transaction', key: row.id, value: encodeTransaction({ ...row, amount }) }))
    }
    network.onLine = true
    await syncCloud(true)
    await vi.waitFor(async () => expect((await readConnection())?.conflict?.record?.version).toBe(2))
    await resolveConflict(session, 'server')
    await vi.waitFor(async () => expect((await readConnection())?.conflict?.message).toContain('предыдущую локальную версию'))
    expect(sent).toHaveLength(1)
    expect((await readConnection())?.queue).toHaveLength(1)
    await disconnect(session, { discard: true })
  } finally { vi.unstubAllGlobals() }
})

test('параллельный импорт фискального чека сохраняет черновик конфликта без двойного учёта', async () => {
  const snapshot = newSnapshot(false)
  const session = { householdId: 'receipts', memberId: snapshot.members[0].id, role: 'owner' as const }
  const category = snapshot.categories[0]
  const fiscal = parseFiscalQr('t=20261120T1742&s=14.05&fn=000110000105&i=10&fp=55&n=1')
  const queued: Receipt = {
    id: 'purchase-device-a', source: 'qr', store: '', date: fiscal.date, fiscal, total: fiscal.total, note: '',
    mode: 'single', categoryId: category.id, memberId: session.memberId, mismatchAccepted: false, items: [],
  }
  const existing: CloudRecord = { kind: 'receipt', version: 1, key: 'purchase-device-b', value: { ...queued, id: 'purchase-device-b' } }
  const initial: CloudRecord[] = [
    { kind: 'profile', key: 'household', version: 1, value: encodeProfile(snapshot.profile) },
    { kind: 'category', key: category.id, version: 1, value: encodeCategory(category) },
    ...snapshot.members.map(member => ({ kind: 'member' as const, key: member.id, version: 1, value: member })),
  ]
  const network = { onLine: true }
  let rejected = false
  vi.stubGlobal('navigator', network)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/households')) return Response.json({ session, recoveryCode: 'test-only' })
    if (url.endsWith('/logout')) return Response.json({ ok: true })
    if (url.includes('/sync?')) return Response.json(Number(url.split('=').at(-1)) === 0
      ? { cursor: 4, records: initial, more: false }
      : { cursor: rejected ? 5 : 4, records: rejected ? [existing] : [], more: false })
    rejected = true
    return Response.json({ error: 'Этот чек уже добавлен.', code: 'receipt_duplicate', record: existing }, { status: 409 })
  }))
  try {
    await authenticate('households', {}, 'dark')
    await vi.waitFor(async () => expect((await readConnection())?.cursor).toBe(4))
    network.onLine = false
    await repository.putReceipt(queued)
    expect((await repository.read())?.transactions).toMatchObject([{ amount: 1405, receiptId: queued.id }])
    network.onLine = true
    await syncCloud(true)
    await vi.waitFor(async () => expect((await readConnection())?.conflict?.code).toBe('receipt_duplicate'))
    const connection = (await readConnection())!
    expect(connection.queue).toMatchObject([{ kind: 'receipt', key: queued.id, value: queued }])
    expect(project(connection)?.transactions).toMatchObject([{ amount: 1405, receiptId: existing.key }])
    await expect(resolveConflict(session, 'local')).rejects.toThrow('уже добавлен')
    await resolveConflict(session, 'server')
    expect((await readConnection())?.queue).toEqual([])
    await disconnect(session)
  } finally { vi.unstubAllGlobals() }
})
