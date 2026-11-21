import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, beforeEach, test } from 'node:test'
import { URL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const project = fileURLToPath(new URL('../../', import.meta.url))
const { AbortSignal, fetch } = globalThis
const wrangler = join(project, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const run = promisify(execFile)
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false' }
const api = '/api/v1'
const secrets = new Set()
let sandbox
let state
let origin
let server
let serverLogs = ''

async function openPort() {
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const { port } = listener.address()
  await new Promise((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve())
  })
  return port
}

function localWrangler(args) {
  return run(process.execPath, [wrangler, ...args], {
    cwd: project,
    env,
    timeout: 30_000,
    windowsHide: true,
  })
}

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'budget-cloud-'))
  state = join(sandbox, 'd1')
  const assets = join(sandbox, 'assets')
  await mkdir(assets)
  await writeFile(join(assets, 'index.html'), '<!doctype html><title>Cloud API test</title>')
  await copyFile(join(project, 'public', '_routes.json'), join(assets, '_routes.json'))
  await localWrangler(['d1', 'migrations', 'apply', 'budget', '--local', '--persist-to', state])
  const port = await openPort()
  origin = 'http://127.0.0.1:' + port
  server = spawn(process.execPath, [
    wrangler, 'pages', 'dev', assets, '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state,
  ], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [server.stdout, server.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => { serverLogs += chunk })
  }
  server.on('error', (error) => { serverLogs += String(error) })

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && server.exitCode === null) {
    let response
    try {
      response = await fetch(origin + api + '/session', { signal: AbortSignal.timeout(1000) })
    } catch {
      await delay(100)
      continue
    }
    if (response.status === 401) return
    throw new Error('Expected API session route to respond with 401, got ' + response.status + '\n' + serverLogs)
  }
  throw new Error('Local Pages Functions did not become ready\n' + serverLogs)
}, { timeout: 65_000 })

beforeEach(async () => {
  // All scenarios use the same loopback address and separate household fixtures.
  await sql('DELETE FROM rate_limits')
}, { timeout: 30_000 })

after(async () => {
  try {
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      const closed = once(server, 'close', { signal: AbortSignal.timeout(8000) })
      server.kill()
      await closed
    }
    for (const secret of secrets) {
      assert.ok(!serverLogs.includes(secret), 'A raw credential appeared in the local Pages logs')
    }
  } finally {
    if (sandbox) await rm(sandbox, { recursive: true, force: true, maxRetries: 5 })
  }
})

async function request(path, { client, body, rawBody, headers = {}, requestOrigin = origin } = {}) {
  const post = body !== undefined || rawBody !== undefined
  const response = await fetch(origin + api + path, {
    method: post ? 'POST' : 'GET',
    headers: {
      ...(client ? {
        Cookie: client.cookie,
        'X-Budget-Household': client.session.householdId,
        'X-Budget-Member': client.session.memberId,
      } : {}),
      ...(post ? { 'Content-Type': 'application/json' } : {}),
      ...(post && requestOrigin !== null ? { Origin: requestOrigin } : {}),
      ...headers,
    },
    body: post ? rawBody ?? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12_000),
  })
  assert.match(response.headers.get('content-type') || '', /application\/json/i, path)
  return { status: response.status, headers: response.headers, data: await response.json() }
}

function status(response, expected, operation) {
  assert.equal(response.status, expected, operation)
  return response.data
}

function success(response, operation) {
  assert.ok(response.status >= 200 && response.status < 300, operation + ' returned ' + response.status)
  return response.data
}

function credentials(response, operation) {
  const { session, recoveryCode } = success(response, operation)
  const attributes = response.headers.get('set-cookie')
  assert.ok(attributes, 'Session cookie is issued')
  assert.ok(/;\s*HttpOnly\b/i.test(attributes), 'Session cookie is HttpOnly')
  assert.ok(/;\s*SameSite=Strict\b/i.test(attributes), 'Session cookie is same-site only')
  assert.ok(/;\s*Path=\/api\/v1(?:;|$)/i.test(attributes), 'Session cookie is scoped to the API')
  assert.ok(/;\s*Max-Age=[1-9]\d*(?:;|$)/i.test(attributes), 'Session cookie expires')
  const [cookie] = attributes.split(';')
  const token = cookie.slice(cookie.indexOf('=') + 1)
  assert.ok(Buffer.from(token, 'base64url').length >= 16, 'Session tokens contain at least 128 bits')
  assert.ok(typeof recoveryCode === 'string' && recoveryCode.length >= 22, 'Recovery code is issued')
  secrets.add(token)
  secrets.add(recoveryCode)
  return { session, cookie, token, recoveryCode }
}

async function createBudget(name = 'Owner', budgetName = 'Shared budget') {
  return credentials(await request('/households', {
    body: { name, budgetName, timezone: 'Europe/Moscow' },
  }), 'Create household')
}

async function invite(owner) {
  const started = Date.now()
  const { token, expiresAt } = success(await request('/invite', { client: owner, body: {} }), 'Create invitation')
  assert.ok(/^[a-zA-Z0-9_-]+$/.test(token), 'Invitation uses the URL-safe token alphabet')
  assert.ok(Buffer.from(token, 'base64url').length >= 16, 'Invitation tokens contain at least 128 bits')
  const expiry = Date.parse(expiresAt)
  assert.ok(expiry >= started + 900_000 && expiry <= Date.now() + 900_000, 'Invitation lifetime is 15 minutes')
  secrets.add(token)
  return token
}

async function joinBudget(token, name = 'Partner') {
  return credentials(await request('/join', { body: { name, token } }), 'Join household')
}

async function pair() {
  const owner = await createBudget()
  return { owner, partner: await joinBudget(await invite(owner)) }
}

async function sync(client, afterCursor = 0) {
  return status(await request('/sync?after=' + afterCursor, { client }), 200, 'Read changes')
}

function expense(client, id, amount, categoryId = 'food') {
  return { id, type: 'expense', amount, categoryId, memberId: client.session.memberId, date: '2026-11-19', note: '' }
}

function receipt(client, id, overrides = {}) {
  return {
    id, source: 'combined', store: 'Магазин', date: '2026-11-19', total: 12_345,
    fiscal: { fn: '0000000000000123', i: '234', fp: '345', n: 1, date: '2026-11-19', time: '15:23', total: 12_345 },
    memberId: client.session.memberId, note: '', mode: 'split', categoryId: null, mismatchAccepted: false,
    items: [{ id: 'milk', originalName: 'Молоко', name: 'Молоко', quantity: '1', amount: 12_345, categoryId: 'food', needsReview: false }],
    ...overrides,
  }
}

function limitTransfer(overrides = {}) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', dateStyle: 'short' }).format(new Date())
  const start = new Date(today + 'T00:00:00Z')
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 7)
  return {
    id: randomUUID(), kind: 'week', start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10),
    fromCategoryId: 'food', toCategoryId: 'home', amount: 20_000, cancelled: false, createdAt: Date.now(),
    ...overrides,
  }
}

function mutation(kind, key, expectedVersion, value, id = randomUUID()) {
  return { id, kind, key, expectedVersion, value }
}

function mutate(client, body, options = {}) {
  return request('/sync/mutate', { client, body, ...options })
}

function record(feed, kind, key) {
  return feed.records.find((entry) => entry.kind === kind && entry.key === key)
}

function digest(secret) {
  return createHash('sha256').update(secret).digest('hex')
}

async function sql(command) {
  const { stdout } = await localWrangler([
    'd1', 'execute', 'budget', '--local', '--persist-to', state, '--command', command, '--json',
  ])
  return JSON.parse(stdout)[0].results
}

test('an owner gets an isolated authenticated household and names round-trip unchanged', async () => {
  const owner = await createBudget("O'Connor", "D'Angelo household")
  assert.equal(owner.session.role, 'owner')
  assert.ok(owner.session.householdId)
  assert.ok(owner.session.memberId)
  const session = await request('/session', { client: owner })
  assert.deepEqual(status(session, 200), { session: owner.session })
  assert.match(session.headers.get('cache-control') || '', /\bno-store\b/i)
  const feed = await sync(owner)
  assert.equal(record(feed, 'profile', 'household').value.household.name, "D'Angelo household")
  assert.equal(record(feed, 'member', owner.session.memberId).value.name, "O'Connor")
  assert.equal(feed.more, false)
  assert.ok(feed.cursor > 0)
  assert.equal(status(await request('/session'), 401).session, undefined)
})

test('one invitation admits one partner, stays single-use, and stops at two active members', async () => {
  const owner = await createBudget()
  const token = await invite(owner)
  const requests = await Promise.all([
    request('/join', { body: { name: 'First candidate', token } }),
    request('/join', { body: { name: 'Second candidate', token } }),
  ])
  const accepted = requests.find(({ status: code }) => code >= 200 && code < 300)
  assert.ok(accepted, 'One concurrent join succeeds')
  const partner = credentials(accepted, 'Join household')
  status(requests.find((response) => response !== accepted), 409, 'Race for already used invitation')
  assert.equal(partner.session.householdId, owner.session.householdId)
  assert.notEqual(partner.session.memberId, owner.session.memberId)
  assert.equal(partner.session.role, 'member')
  status(await request('/join', { body: { name: 'Third candidate', token } }), 409, 'Reuse invitation')
  status(await request('/invite', { client: owner, body: {} }), 409, 'Invite when household is full')
  status(await request('/invite', { client: partner, body: {} }), 403, 'Member cannot invite')
  status(await request('/members/revoke', { client: partner, body: { memberId: owner.session.memberId } }), 403)
  status(await request('/join', { body: { name: 'Invalid token', token: 'short' } }), 400, 'Short invitation token')
})

test('expired invitations and sessions are rejected using their D1 expiry timestamps', async () => {
  const owner = await createBudget()
  const token = await invite(owner)
  const tokenHash = digest(token)
  const sessionHash = digest(owner.token)
  const recoveryHash = digest(owner.recoveryCode)
  const hashedCredentials = await sql(`SELECT 'invitation' AS credential FROM invitations WHERE token_hash='${tokenHash}'
    UNION ALL SELECT 'session' FROM sessions WHERE token_hash='${sessionHash}'
    UNION ALL SELECT 'recovery' FROM recovery_credentials WHERE code_hash='${recoveryHash}'`)
  assert.deepEqual(hashedCredentials.map(({ credential }) => credential).sort(), ['invitation', 'recovery', 'session'])

  await sql("UPDATE invitations SET expires_at = 1 WHERE token_hash = '" + tokenHash + "'")
  status(await request('/join', { body: { name: 'Too late', token } }), 409, 'Expired invitation')
  const nextToken = await invite(owner)
  assert.ok(nextToken !== token, 'New invitation has a different random token')
  await sql("UPDATE sessions SET expires_at = " + (Date.now() + 60_000) + " WHERE token_hash = '" + sessionHash + "'")
  const renewed = await request('/sync?after=0', { client: owner })
  status(renewed, 200, 'An active session can sync shortly before expiry')
  assert.ok(renewed.headers.get('set-cookie')?.split(';')[0] === owner.cookie, 'Sync renews the browser cookie')
  const [{ expires_at: extendedExpiry }] = await sql("SELECT expires_at FROM sessions WHERE token_hash = '" + sessionHash + "'")
  assert.ok(extendedExpiry > Date.now() + 7 * 24 * 60 * 60 * 1000, 'The session expiry is also renewed in D1')
  await sql("UPDATE sessions SET expires_at = 1 WHERE token_hash = '" + sessionHash + "'")
  status(await request('/session', { client: owner }), 401, 'Expired session')
  status(await request('/sync?after=0', { client: owner }), 401, 'Expired session cannot read data')
})

test('revocation cuts off a member’s active and recovery credentials', async () => {
  const { owner, partner } = await pair()
  success(await request('/members/revoke', { client: owner, body: { memberId: partner.session.memberId } }), 'Revoke partner')
  status(await request('/session', { client: partner }), 401, 'Revoked session')
  status(await request('/sync?after=0', { client: partner }), 401, 'Revoked session cannot read')
  status(await mutate(partner, mutation('transaction', 'revoked', 0, expense(partner, 'revoked', '100'))), 401)
  status(await request('/recover', { body: { code: partner.recoveryCode } }), 401, 'Revoked member cannot recover')
  const replacement = await joinBudget(await invite(owner), 'Replacement')
  assert.equal(replacement.session.householdId, owner.session.householdId)
  status(await request('/members/leave', { client: owner, body: {} }), 403, 'The owner cannot leave')
  const leave = await request('/members/leave', { client: replacement, body: {} })
  assert.deepEqual(status(leave, 200, 'A member can leave voluntarily'), { ok: true })
  assert.match(leave.headers.get('set-cookie') || '', /\bMax-Age=0\b/i)
  status(await request('/session', { client: replacement }), 401, 'Leaving ends the member session')
  status(await request('/recover', { body: { code: replacement.recoveryCode } }), 401, 'Leaving ends recovery access')
  const former = record(await sync(owner), 'member', replacement.session.memberId)
  assert.equal(former.value.active, false, 'Leaving preserves the member for historical references')
  await invite(owner)
})

test('recovery can retry a lost response and rotates the credential on confirmation', async () => {
  const owner = await createBudget()
  const scope = {
    'X-Budget-Household': owner.session.householdId,
    'X-Budget-Member': owner.session.memberId,
  }
  status(await request('/recover', {
    body: { code: owner.recoveryCode }, headers: { 'X-Budget-Household': owner.session.householdId },
  }), 400, 'Recovery scope must supply both identifiers')
  status(await request('/recover', {
    body: { code: owner.recoveryCode }, headers: { ...scope, 'X-Budget-Household': randomUUID() },
  }), 401, 'Recovery credentials cannot rotate under a different local household scope')
  status(await request('/session', { client: owner }), 200, 'Rejected recovery leaves the session active')
  success(await request('/logout', { client: owner, body: {} }), 'Log out')
  status(await request('/session', { client: owner }), 401, 'Logged-out session')
  const first = credentials(await request('/recover', {
    body: { code: owner.recoveryCode }, headers: scope,
  }), 'Recovery with an interrupted response')
  const recovered = credentials(await request('/recover', {
    body: { code: owner.recoveryCode }, headers: scope,
  }), 'Retry with the original recovery code')
  status(await request('/session', { client: first }), 401, 'Retry revokes the earlier recovery session')
  assert.deepEqual(recovered.session, owner.session)
  assert.ok(recovered.token !== owner.token, 'Recovery issues a fresh session')
  assert.ok(recovered.recoveryCode !== owner.recoveryCode, 'Recovery prepares a fresh code')
  assert.deepEqual(status(await request('/session', { client: recovered }), 200).session, owner.session)
  status(await request('/recover/confirm', {
    client: recovered, body: { code: first.recoveryCode },
  }), 409, 'A superseded replacement cannot be confirmed')
  status(await request('/recover/confirm', {
    client: recovered, body: { code: recovered.recoveryCode }, headers: { 'X-Budget-Member': randomUUID() },
  }), 403, 'Confirmation requires the recovery session scope')
  status(await request('/recover/confirm', {
    client: recovered, body: { code: owner.recoveryCode },
  }), 409, 'The original code is not a confirmation code')
  const confirmation = { client: recovered, body: { code: recovered.recoveryCode } }
  assert.deepEqual(status(await request('/recover/confirm', confirmation), 200), { ok: true })
  assert.deepEqual(status(await request('/recover/confirm', confirmation), 200), { ok: true }, 'Retry after a lost confirmation response')
  status(await request('/recover', { body: { code: owner.recoveryCode } }), 401, 'Previous code cannot be reused')
  const fromNewDevice = credentials(await request('/recover', { body: { code: recovered.recoveryCode } }), 'Unscoped recovery')
  assert.deepEqual(fromNewDevice.session, owner.session)
  await sql("UPDATE pending_recoveries SET expires_at = 1 WHERE session_token_hash = '" + digest(fromNewDevice.token) + "'")
  status(await request('/recover/confirm', {
    client: fromNewDevice, body: { code: fromNewDevice.recoveryCode },
  }), 409, 'An expired replacement cannot be confirmed')
  success(await request('/recover', { body: { code: recovered.recoveryCode } }), 'Expired confirmation leaves the original code available')
})

test('sync guards the cookie and both scopes, including valid sessions for other households', async () => {
  const { owner, partner } = await pair()
  const stranger = await createBudget('Stranger')
  const id = randomUUID()
  const value = { ...expense(owner, id, '50000'), authorId: partner.session.memberId, createdAt: 1 }
  const recorded = success(await mutate(owner, mutation('transaction', id, 0, value)), 'Add owner expense').record
  assert.equal(recorded.value.authorId, owner.session.memberId, 'Server attributes authorship to the authenticated writer')
  assert.ok(recorded.value.createdAt > value.createdAt, 'Server supplies creation time')

  status(await request('/sync?after=0'), 401, 'Unauthenticated sync read')
  status(await mutate(undefined, mutation('transaction', id, 1, null)), 401, 'Unauthenticated mutation')
  status(await request('/sync?after=0', {
    client: stranger, headers: { 'X-Budget-Household': owner.session.householdId, 'X-Budget-Member': owner.session.memberId },
  }), 403, 'Other household cannot read')
  status(await request('/sync?after=0', {
    client: owner, headers: { 'X-Budget-Member': partner.session.memberId },
  }), 403, 'Header cannot impersonate another member')
  status(await request('/logout', {
    client: owner, body: {}, headers: { 'X-Budget-Household': stranger.session.householdId },
  }), 403, 'A profile cannot end a different profile’s session')
  status(await mutate(stranger, mutation('transaction', id, 1, null), {
    headers: { 'X-Budget-Household': owner.session.householdId },
  }), 403, 'Header cannot select another household')
  assert.equal(status(await mutate(stranger, mutation('transaction', id, 1, null)), 409).record, null)
  const forged = randomUUID()
  status(await mutate(stranger, mutation('transaction', forged, 0, expense(owner, forged, '100'))), 400, 'Foreign participant reference')
  assert.equal(record(await sync(stranger), 'transaction', id), undefined)
  assert.equal(record(await sync(partner), 'transaction', id).value.amount, '50000')
})

test('cross-origin writes, invalid amounts, invalid dates, and oversized requests are rejected', async () => {
  const owner = await createBudget()
  const id = randomUUID()
  const value = expense(owner, id, '50001')
  const change = mutation('transaction', id, 0, value)
  const rejected = await mutate(owner, change, { requestOrigin: 'https://example.invalid' })
  status(rejected, 403, 'Cross-origin mutation')
  assert.equal(rejected.headers.get('access-control-allow-origin'), null)
  status(await mutate(owner, change, { requestOrigin: null }), 403, 'Write without Origin')
  const cursor = (await sync(owner)).cursor

  for (const amount of [50001, '0', '-1', '5.01', '9223372036854775808']) {
    status(await mutate(owner, mutation('transaction', id, 0, { ...value, amount })), 400, 'Invalid cents')
  }
  status(await mutate(owner, mutation('transaction', id, 0, { ...value, date: '2026-02-30' })), 400, 'Nonexistent day')
  status(await request('/sync/mutate', { client: owner, rawBody: '{"unfinished":' }), 400, 'Malformed JSON')
  status(await request('/sync/mutate', {
    client: owner, body: { ...change, value: { ...value, note: 'x'.repeat(4 * 1024 * 1024) } },
  }), 413, 'Oversized request')

  const feed = await sync(owner, cursor)
  assert.equal(feed.cursor, cursor)
  assert.deepEqual(feed.records, [])
})

test('both members sync the receipt setting, category default, and expense scope', async () => {
  const { owner, partner } = await pair()
  const initial = await sync(owner)
  const profile = record(initial, 'profile', 'household')
  const food = record(initial, 'category', 'food')
  const enabled = status(await mutate(partner, mutation('profile', profile.key, profile.version, {
    ...profile.value, settings: { ...profile.value.settings, roundReceiptTotals: true },
  })), 200).record
  const category = status(await mutate(owner, mutation('category', food.key, food.version, {
    ...food.value, defaultBudgetScope: 'monthly_only',
  })), 200).record
  assert.equal(record(await sync(owner), 'profile', profile.key).value.settings.roundReceiptTotals, true)
  assert.equal(record(await sync(partner), 'category', food.key).value.defaultBudgetScope, 'monthly_only')

  const ownerExpense = { ...expense(owner, randomUUID(), '1000'), budgetScope: 'monthly_only' }
  const partnerExpense = { ...expense(partner, randomUUID(), '2000'), budgetScope: 'monthly_only' }
  for (const [client, value] of [[owner, ownerExpense], [partner, partnerExpense]]) {
    status(await mutate(client, mutation('transaction', value.id, 0, value)), 200)
  }
  assert.equal(record(await sync(owner), 'transaction', partnerExpense.id).value.budgetScope, 'monthly_only')
  assert.equal(record(await sync(partner), 'transaction', ownerExpense.id).value.budgetScope, 'monthly_only')

  const changed = status(await mutate(partner, mutation('transaction', ownerExpense.id, 1, {
    ...ownerExpense, budgetScope: 'weekly_and_monthly',
  })), 200).record
  assert.equal(changed.value.authorId, owner.session.memberId)
  assert.equal(record(await sync(owner), 'transaction', ownerExpense.id).value.budgetScope, 'weekly_and_monthly')
  status(await mutate(owner, mutation('category', category.key, category.version, {
    ...category.value, defaultBudgetScope: 'weekly_only',
  })), 400)
  const income = { ...expense(partner, randomUUID(), '3000', null), type: 'income', source: 'Salary', budgetScope: 'monthly_only' }
  status(await mutate(partner, mutation('transaction', income.id, 0, income)), 400)

  status(await mutate(owner, mutation('profile', enabled.key, enabled.version, {
    ...enabled.value, settings: { ...enabled.value.settings, roundReceiptTotals: false },
  })), 200)
  assert.equal(record(await sync(partner), 'profile', profile.key).value.settings.roundReceiptTotals, false)
})

test('independent additions converge and retrying after a lost response emits one change', async () => {
  const { owner, partner } = await pair()
  const beforeAdds = (await sync(owner)).cursor
  const ownerId = randomUUID()
  const partnerId = "partner's-receipt"
  const first = mutation('transaction', ownerId, 0, expense(owner, ownerId, '50000'))
  const second = mutation('transaction', partnerId, 0, expense(partner, partnerId, '80000'))
  // The first sender discards the response and retries the original mutation.
  const [, otherResult] = await Promise.all([mutate(owner, first), mutate(partner, second)])
  success(otherResult, 'Add partner expense')
  assert.equal(record(await sync(partner, beforeAdds), 'transaction', ownerId).value.amount, '50000')
  const retry = success(await mutate(owner, first), 'Retry unacknowledged mutation').record
  assert.equal(retry.version, 1)
  assert.equal(retry.value.amount, '50000')
  status(await mutate(owner, { ...first, value: { ...first.value, amount: '99000' } }), 409, 'Mutation ID cannot change payload')

  for (const client of [owner, partner]) {
    const feed = await sync(client, beforeAdds)
    const transactions = feed.records.filter(({ kind }) => kind === 'transaction')
    assert.deepEqual(transactions.map(({ key }) => key).sort(), [ownerId, partnerId].sort())
    assert.equal(record(feed, 'transaction', ownerId).value.amount, '50000')
    assert.equal(record(feed, 'transaction', partnerId).value.amount, '80000')
    assert.ok(feed.cursor > beforeAdds)
    assert.deepEqual((await sync(client, feed.cursor)).records, [])
  }
})

test('concurrent edits report the winning version for a transaction and a budget limit', async () => {
  const { owner, partner } = await pair()
  const id = randomUUID()
  const value = expense(owner, id, '12500')
  const added = success(await mutate(owner, mutation('transaction', id, 0, value)), 'Add expense').record
  const profile = record(await sync(owner), 'profile', 'household')
  for (const [entry, edits] of [
    [added, [{ ...added.value, amount: '15000' }, { ...added.value, amount: '17500' }]],
    [profile, [
      { ...profile.value, budget: { ...profile.value.budget, week: '99000' } },
      { ...profile.value, budget: { ...profile.value.budget, week: '97000' } },
    ]],
  ]) {
    const clients = [owner, partner]
    const replies = await Promise.all(edits.map((edit, index) =>
      mutate(clients[index], mutation(entry.kind, entry.key, entry.version, edit))))
    const winner = replies.find(({ status: code }) => code >= 200 && code < 300)
    assert.ok(winner, 'One editor wins for ' + entry.kind)
    const saved = winner.data.record
    assert.equal(saved.version, entry.version + 1)
    assert.deepEqual(status(replies.find((reply) => reply !== winner), 409, 'Concurrent editor conflict').record, saved)
    assert.deepEqual(record(await sync(partner), entry.kind, entry.key), saved)
  }

  const edited = record(await sync(owner), 'transaction', id)
  const beforeDelete = (await sync(partner)).cursor
  const deleted = success(await mutate(owner, mutation('transaction', id, edited.version, null)), 'Delete expense').record
  assert.equal(deleted.version, edited.version + 1)
  assert.equal(deleted.value, null)
  const staleEdit = mutation('transaction', id, edited.version, { ...edited.value, amount: '99999' })
  assert.deepEqual(status(await mutate(partner, staleEdit), 409, 'Stale edit after deletion').record, deleted)
  assert.deepEqual(record(await sync(partner, beforeDelete), 'transaction', id), deleted)
})

test('snapshot import preserves cents and links, is idempotent, and checks the expected cursor', async () => {
  const owner = await createBudget()
  const beforeMigration = await sync(owner)
  const categoryId = 'migrated-food'
  const snapshot = {
    version: 2,
    profile: {
      household: { id: 'household', name: 'Imported budget' },
      budget: { week: '150000', month: '500000' },
      settings: { weekStart: 3, timezone: 'Asia/Novosibirsk', theme: 'dark', lastCategory: categoryId, demo: false },
    },
    categories: [
      { id: categoryId, name: 'Groceries', emoji: '🍎', color: '#112233', limits: { week: '50000', month: '200000' }, archived: false },
    ],
    members: [
      { id: 'local-member-1', name: 'Local owner', color: '#112233' },
      { id: 'local-member-2', name: 'Local partner', color: '#445566' },
    ],
    transactions: [
      { ...expense(owner, 'local-expense', '12345', categoryId), memberId: 'local-member-1', note: 'Preserve history' },
      { ...expense(owner, 'local-income', '98765', null), type: 'income', memberId: 'local-member-2', source: 'Salary' },
    ],
  }
  const transfer = { id: randomUUID(), snapshot, expectedCursor: beforeMigration.cursor }
  const invalid = {
    ...snapshot, transactions: [{ ...snapshot.transactions[0], categoryId: 'missing-category' }],
  }
  status(await request('/migrate', { client: owner, body: { ...transfer, snapshot: invalid } }), 400, 'Invalid migration reference')
  assert.deepEqual((await sync(owner, beforeMigration.cursor)).records, [], 'Invalid import leaves the budget untouched')
  const transferred = success(await request('/migrate', { client: owner, body: transfer }), 'Migrate snapshot')
  assert.ok(transferred.cursor > beforeMigration.cursor)
  assert.deepEqual(success(await request('/migrate', { client: owner, body: transfer }), 'Repeat migration'), transferred)
  status(await request('/migrate', { client: owner, body: { ...transfer, id: randomUUID() } }), 409, 'Stale migration cursor')
  const feed = await sync(owner)
  assert.deepEqual(record(feed, 'profile', 'household').value.budget, { week: '150000', month: '500000' })
  assert.equal(record(feed, 'profile', 'household').value.settings.weekStart, 3)
  assert.equal(record(feed, 'profile', 'household').value.settings.timezone, 'Asia/Novosibirsk')
  assert.equal(record(feed, 'category', categoryId).value.limits.week, '50000')
  const imported = feed.records.filter(({ kind, value }) => kind === 'transaction' && value !== null)
  assert.equal(imported.length, 2)
  const outgoing = record(feed, 'transaction', 'local-expense').value
  assert.equal(outgoing.amount, '12345')
  assert.equal(outgoing.categoryId, categoryId)
  assert.equal(outgoing.memberId, owner.session.memberId)
  const incoming = record(feed, 'transaction', 'local-income').value
  assert.equal(incoming.amount, '98765')
  assert.equal(incoming.type, 'income')
  assert.notEqual(incoming.memberId, owner.session.memberId)
  assert.ok(record(feed, 'member', incoming.memberId)?.value, 'Member references survive migration')
  assert.deepEqual((await sync(owner, transferred.cursor)).records, [])
})

test('receipt schema upgrade preserves the Stage 2 records, revisions and turnover', async () => {
  const database = new DatabaseSync(':memory:')
  const apply = async name => database.exec(await readFile(join(project, 'migrations', name), 'utf8'))
  try {
    await apply('0001_households.sql')
    await apply('0002_recovery_confirmation.sql')
    database.exec(`
      INSERT INTO households(id,created_at) VALUES ('budget',1);
      INSERT INTO members VALUES ('budget','owner','owner',1,0,'Owner','#112233',1,1);
      INSERT INTO records(household_id,kind,key,version,value,created_at,updated_at) VALUES
        ('budget','category','food',2,'{"id":"food"}',1,2),
        ('budget','transaction','buy',1,'{"memberId":"owner","authorId":"owner","type":"expense","categoryId":"food","amount":"99"}',1,1),
        ('budget','transaction','deleted',3,NULL,1,3);
    `)
    const records = database.prepare('SELECT * FROM records ORDER BY revision').all()
    const budget = database.prepare('SELECT * FROM households').get()
    await apply('0003_receipts.sql')
    assert.deepEqual(database.prepare('SELECT * FROM records ORDER BY revision').all(), records)
    assert.deepEqual(database.prepare('SELECT * FROM households').get(), budget)
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
    database.exec("UPDATE members SET name='Edited' WHERE id='owner'")
    assert.equal(database.prepare("SELECT version FROM records WHERE key='owner'").get().version, 2)
    assert.throws(() => database.exec("UPDATE records SET value=NULL WHERE key='food'"), /budget_reference/)
  } finally {
    database.close()
  }
})

test('receipt rounding upgrade preserves existing records, revisions, and turnover', async () => {
  const database = new DatabaseSync(':memory:')
  const apply = async name => database.exec(await readFile(join(project, 'migrations', name), 'utf8'))
  try {
    await apply('0001_households.sql')
    await apply('0002_recovery_confirmation.sql')
    await apply('0003_receipts.sql')
    database.exec(`
      INSERT INTO households(id,created_at) VALUES ('budget',1);
      INSERT INTO members VALUES ('budget','owner','owner',1,0,'Owner','#112233',1,1);
      INSERT INTO records(household_id,kind,key,version,value,created_at,updated_at) VALUES
        ('budget','category','food',1,'{"id":"food"}',1,1),
        ('budget','transaction','buy',1,'{"memberId":"owner","authorId":"owner","type":"expense","categoryId":"food","amount":"99"}',1,1),
        ('budget','receipt','receipt',1,'{"memberId":"owner","authorId":"owner","total":12345}',1,1),
        ('budget','receipt','deleted',3,NULL,1,3);
    `)
    const records = () => database.prepare('SELECT * FROM records ORDER BY revision').all()
    const budget = () => database.prepare('SELECT * FROM households').get()
    const previousRecords = records()
    const previousBudget = budget()
    assert.equal(previousBudget.total_minor, 12_444)
    await apply('0004_receipt_rounding.sql')
    assert.deepEqual(records(), previousRecords)
    assert.deepEqual(budget(), previousBudget)
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])

    database.exec(`UPDATE records SET version=version+1,value=json_set(value,'$.budgetAmount',12400,'$.roundingDelta',55)
      WHERE key='receipt'`)
    assert.equal(budget().total_minor, 12_499)
    assert.equal(budget().cursor, previousBudget.cursor + 1)
    database.exec("UPDATE records SET version=version+1,value=NULL WHERE key='receipt'")
    assert.equal(budget().total_minor, 99)
    assert.equal(budget().cursor, previousBudget.cursor + 2)
  } finally {
    database.close()
  }
})

test('limit transfer schema upgrade preserves rounded turnover and the Stage 4 change index', async () => {
  const database = new DatabaseSync(':memory:')
  const apply = async name => database.exec(await readFile(join(project, 'migrations', name), 'utf8'))
  try {
    await apply('0001_households.sql')
    await apply('0002_recovery_confirmation.sql')
    await apply('0003_receipts.sql')
    await apply('0004_receipt_rounding.sql')
    database.exec(`
      INSERT INTO households(id,created_at) VALUES ('budget',1);
      INSERT INTO members VALUES ('budget','owner','owner',1,0,'Owner','#112233',1,1);
      INSERT INTO records(household_id,kind,key,version,value,created_at,updated_at) VALUES
        ('budget','category','food',2,'{"id":"food"}',1,2),
        ('budget','category','home',1,'{"id":"home"}',1,1),
        ('budget','transaction','deleted',3,NULL,1,3),
        ('budget','receipt','receipt',1,'{"memberId":"owner","authorId":"owner","total":12345,"budgetAmount":12400,"roundingCategoryId":"home"}',1,1);
    `)
    const records = () => database.prepare('SELECT * FROM records ORDER BY revision').all()
    const budget = () => database.prepare('SELECT * FROM households').get()
    const previousRecords = records()
    const previousBudget = budget()
    assert.equal(previousBudget.total_minor, 12_400)
    await apply('0005_limit_transfers.sql')
    assert.deepEqual(records(), previousRecords)
    assert.deepEqual(budget(), previousBudget)
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])

    const transfer = limitTransfer()
    database.prepare("INSERT INTO records(household_id,kind,key,version,value,created_at,updated_at) VALUES ('budget','limitTransfer',?,1,?,1,1)")
      .run(transfer.id, JSON.stringify(transfer))
    assert.equal(budget().total_minor, 12_400)
    assert.equal(budget().cursor, previousBudget.cursor + 1)
    assert.equal(records().at(-1).revision, budget().cursor)
    assert.throws(() => database.exec("UPDATE records SET value=NULL WHERE key='food'"), /budget_reference/)
    assert.throws(() => database.exec("UPDATE records SET value=NULL WHERE key='home'"), /budget_reference/)
    database.exec("UPDATE members SET name='Edited' WHERE id='owner'")
    assert.equal(records().at(-1).kind, 'member')
    database.exec("UPDATE records SET version=version+1,value=NULL WHERE key='receipt'")
    assert.equal(budget().total_minor, 0)
  } finally {
    database.close()
  }
})

test('receipt imports converge for two members and retry without counting turnover twice', async () => {
  const { owner, partner } = await pair()
  const start = (await sync(owner)).cursor
  const ownerDraft = receipt(owner, randomUUID(), { authorId: partner.session.memberId })
  const partnerDraft = receipt(partner, randomUUID(), { authorId: owner.session.memberId })
  const attempts = [ownerDraft, partnerDraft].map(draft => mutation('receipt', draft.id, 0, draft))
  const clients = [owner, partner]
  const results = await Promise.all(attempts.map((action, index) => mutate(clients[index], action)))
  const winner = results.findIndex(response => response.status === 200)
  assert.ok(winner >= 0, 'One simultaneous import succeeds')
  const saved = results[winner].data.record
  assert.equal(saved.value.authorId, clients[winner].session.memberId)
  const duplicate = status(results[1 - winner], 409, 'The identical fiscal document conflicts')
  assert.equal(duplicate.code, 'receipt_duplicate')
  assert.deepEqual(duplicate.record, saved)
  assert.deepEqual(status(await mutate(clients[winner], attempts[winner]), 200).record, saved)
  for (const client of clients) {
    assert.deepEqual((await sync(client, start)).records, [saved])
  }

  const outsider = await createBudget()
  const foreignDraft = receipt(outsider, randomUUID())
  status(await mutate(outsider, mutation('receipt', foreignDraft.id, 0, foreignDraft)), 200, 'Fiscal scope is the household')
  const refundId = randomUUID()
  const refund = receipt(owner, refundId, { mode: 'single', fiscal: { ...ownerDraft.fiscal, n: 2 }, items: [] })
  const savedRefund = status(await mutate(owner, mutation('receipt', refundId, 0, refund)), 200, 'A return is a distinct document').record
  assert.equal(savedRefund.value.fiscal.n, 2)
  status(await mutate(owner, mutation('receipt', refundId, 1, null)), 200)
  status(await mutate(owner, mutation('receipt', refundId, 2, { ...refund, fiscal: { ...refund.fiscal, n: 3 } })), 400,
    'Unsupported settlement types are rejected')
  const startEdit = (await sync(owner)).cursor
  const edited = status(await mutate(clients[1 - winner], mutation('receipt', saved.key, 1, {
    ...saved.value, memberId: partner.session.memberId, note: 'Проверено', authorId: partner.session.memberId,
  })), 200).record
  assert.equal(edited.version, 2)
  assert.equal(edited.value.authorId, saved.value.authorId)
  assert.deepEqual((await sync(owner, startEdit)).records, [edited])
  assert.deepEqual(status(await mutate(owner, mutation('receipt', saved.key, 1, saved.value)), 409).record, edited)

  const totals = () => sql(`SELECT total_minor FROM households WHERE id='${owner.session.householdId}'`)
  assert.deepEqual(await totals(), [{ total_minor: 12_345 }])
  const removed = status(await mutate(owner, mutation('receipt', saved.key, 2, null)), 200).record
  assert.equal(removed.value, null)
  assert.deepEqual(await totals(), [{ total_minor: 0 }])
})

test('receipt references respect household category and member boundaries', async () => {
  const { owner, partner } = await pair()
  const outsider = await createBudget()
  const food = record(await sync(owner), 'category', 'food')
  const id = randomUUID()
  const draft = receipt(owner, id)
  const start = (await sync(owner)).cursor
  status(await mutate(owner, mutation('receipt', id, 0, { ...draft, memberId: outsider.session.memberId })), 400)
  status(await mutate(owner, mutation('receipt', id, 0, { ...draft, total: 10_000 })), 400, 'An unreconciled receipt is rejected')
  status(await mutate(owner, mutation('receipt', id, 0, {
    ...draft, items: draft.items.map(item => ({ ...item, categoryId: 'missing' })),
  })), 400, 'Item category must belong to the household')
  const rule = { id: 'milk-rule', match: 'exact', pattern: 'молоко', categoryId: 'food' }
  status(await mutate(owner, mutation('receiptRule', rule.id, 0, { ...rule, categoryId: 'missing' })), 400)
  assert.deepEqual((await sync(owner, start)).records, [], 'Invalid mutations leave the budget untouched')

  const created = status(await mutate(owner, mutation('receipt', id, 0, draft)), 200).record
  const savedRule = status(await mutate(owner, mutation('receiptRule', rule.id, 0, rule)), 200).record
  assert.deepEqual(record(await sync(partner), 'receiptRule', rule.id), savedRule)
  assert.equal(record(await sync(outsider), 'receiptRule', rule.id), undefined)
  const edits = await Promise.all([owner, partner].map((client, index) => mutate(client, mutation('receiptRule', rule.id, 1, {
    ...rule, pattern: ['Молоко 1%', 'Молоко 3%'][index],
  }))))
  const updated = status(edits.find(response => response.status === 200), 200).record
  assert.deepEqual(status(edits.find(response => response.status === 409), 409).record, updated)
  assert.deepEqual(record(await sync(partner), 'receiptRule', rule.id), updated)
  status(await mutate(owner, mutation('category', 'food', food.version, null)), 400, 'Receipt references prevent category removal')
  const archived = status(await mutate(owner, mutation('category', 'food', food.version, { ...food.value, archived: true })), 200).record
  status(await mutate(partner, mutation('receipt', id, created.version, { ...created.value, note: 'Сохранено' })), 200,
    'Editing can keep a historical category')
  const newId = randomUUID()
  status(await mutate(owner, mutation('receipt', newId, 0, receipt(owner, newId, { fiscal: undefined, source: 'manual' }))), 400,
    'A new receipt cannot use an archived category')
  status(await mutate(owner, mutation('receipt', id, created.version + 1, null)), 200)
  status(await mutate(owner, mutation('category', 'food', archived.version, null)), 400, 'Rule references prevent category removal')
  status(await mutate(owner, mutation('receiptRule', rule.id, updated.version, null)), 200)
  status(await mutate(owner, mutation('category', 'food', archived.version, null)), 200)
})

test('rounded split receipts sync and protect their rounding category', async () => {
  const { owner, partner } = await pair()
  const initial = await sync(owner)
  const home = record(initial, 'category', 'home')
  const profile = record(initial, 'profile', 'household')
  status(await mutate(owner, mutation('profile', profile.key, profile.version, {
    ...profile.value, settings: { ...profile.value.settings, roundReceiptTotals: true },
  })), 200)
  const draft = receipt(owner, randomUUID(), {
    budgetScope: 'monthly_only', budgetAmount: 12_400, roundingDelta: 55, roundingCategoryId: home.key,
  })
  for (const changes of [
    { roundingCategoryId: 'missing' },
    { roundingCategoryId: undefined },
    { budgetAmount: 12_401, roundingDelta: 56 },
    { source: 'manual', fiscal: undefined },
    { mode: 'single', categoryId: 'food', fiscal: { ...draft.fiscal, n: 2 }, roundingCategoryId: undefined, budgetScope: undefined },
    { mode: 'single', categoryId: 'food', fiscal: { ...draft.fiscal, n: 2 }, roundingCategoryId: undefined, budgetAmount: undefined, roundingDelta: undefined },
  ]) {
    status(await mutate(owner, mutation('receipt', draft.id, 0, { ...draft, ...changes })), 400)
  }
  const change = mutation('receipt', draft.id, 0, draft)
  const created = status(await mutate(owner, change), 200).record
  assert.deepEqual(status(await mutate(owner, change), 200).record, created)
  const totals = () => sql(`SELECT total_minor FROM households WHERE id='${owner.session.householdId}'`)
  assert.equal((await totals())[0].total_minor, 12_400)
  assert.deepEqual(record(await sync(partner), 'receipt', draft.id).value, { ...draft, authorId: owner.session.memberId })
  status(await mutate(owner, mutation('category', home.key, home.version, null)), 400)

  const archived = status(await mutate(owner, mutation('category', home.key, home.version, {
    ...home.value, archived: true,
  })), 200).record
  const edited = status(await mutate(partner, mutation('receipt', draft.id, created.version, {
    ...created.value, note: 'Проверено', budgetScope: 'weekly_and_monthly',
  })), 200).record
  assert.equal(edited.value.budgetScope, 'weekly_and_monthly')
  assert.equal(edited.value.total, 12_345)
  assert.deepEqual(edited.value.fiscal, draft.fiscal)
  assert.equal((await totals())[0].total_minor, 12_400)
  const other = { ...draft, id: randomUUID(), fiscal: { ...draft.fiscal, i: '235' } }
  status(await mutate(partner, mutation('receipt', other.id, 0, other)), 400, 'A new receipt cannot use an archived rounding category')
  status(await mutate(partner, mutation('receipt', draft.id, edited.version, null)), 200)
  assert.equal((await totals())[0].total_minor, 0)
  status(await mutate(owner, mutation('category', home.key, archived.version, null)), 200)
})

test('receipt edits preserve registered fiscal identity, timestamp and amount', async () => {
  const { owner, partner } = await pair()
  const id = randomUUID()
  const draft = receipt(owner, id)
  const record = status(await mutate(owner, mutation('receipt', id, 0, draft)), 200).record
  const { cursor } = await sync(partner)
  for (const changes of [
    { source: 'manual', fiscal: undefined },
    { fiscal: { ...draft.fiscal, fp: '888' } },
    { fiscal: { ...draft.fiscal, time: '15:24' } },
    { total: 321, items: [{ ...draft.items[0], amount: 321 }], fiscal: { ...draft.fiscal, total: 321 } },
  ]) {
    status(await mutate(partner, mutation('receipt', id, record.version, { ...record.value, ...changes })), 400)
  }
  assert.deepEqual((await sync(owner, cursor)).records, [])
  const allowed = status(await mutate(partner, mutation('receipt', id, record.version, { ...record.value, note: 'Проверено' })), 200).record
  assert.deepEqual(allowed.value.fiscal, draft.fiscal)
})

test('receipt sync pages large accepted receipts within a bounded response', async () => {
  const { owner, partner } = await pair()
  const start = (await sync(partner)).cursor
  const name = 'Молоко'.padEnd(250, 'я')
  const items = Array.from({ length: 200 }, (_, index) => ({
    id: String(index), originalName: name, name, quantity: '1', amount: 1, categoryId: 'food', needsReview: false,
  }))
  const keys = []
  for (let index = 0; index < 6; index++) {
    const id = randomUUID()
    const draft = receipt(owner, id, { fiscal: undefined, source: 'manual', total: items.length, items })
    const stored = status(await mutate(owner, mutation('receipt', id, 0, draft)), 200).record
    assert.equal(stored.value.items.length, items.length)
    keys.push(id)
  }
  const first = await sync(partner, start)
  assert.equal(first.more, true)
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 1024 * 1024)
  const second = await sync(partner, first.cursor)
  assert.equal(second.more, false)
  assert.ok(second.cursor > first.cursor)
  assert.deepEqual([...first.records, ...second.records].map(row => row.key), keys)
})

test('snapshot restore validates receipt arithmetic, fiscal uniqueness and links before replacement', async () => {
  const { owner, partner } = await pair()
  const initial = await sync(owner)
  const original = receipt(owner, 'previous-receipt')
  status(await mutate(owner, mutation('receipt', original.id, 0, original)), 200)
  const { cursor } = await sync(owner)
  const restored = receipt(owner, 'restored-receipt', {
    memberId: 'local-member-2', authorId: 'local-member-2', budgetScope: 'monthly_only',
    budgetAmount: 12_400, roundingDelta: 55, roundingCategoryId: 'home',
  })
  const profile = record(initial, 'profile', 'household').value
  const snapshot = {
    version: 3,
    profile: { ...profile, settings: { ...profile.settings, roundReceiptTotals: true } },
    categories: initial.records.filter(({ kind }) => kind === 'category').map(({ value }) =>
      value.id === 'food' ? { ...value, defaultBudgetScope: 'monthly_only' } : value),
    members: [{ id: 'local-member-1', name: 'Маша', color: '#445566' }, { id: 'local-member-2', name: 'Саша', color: '#112233' }],
    transactions: [{ ...expense(owner, 'original-expense', '99'), memberId: 'local-member-1', budgetScope: 'monthly_only' }],
    receipts: [restored],
    receiptRules: [{ id: 'milk-rule', match: 'contains', pattern: 'молок', categoryId: 'food' }],
  }
  const transfer = { id: randomUUID(), snapshot, expectedCursor: cursor }
  for (const invalid of [
    { ...snapshot, receipts: undefined },
    { ...snapshot, receipts: [restored, { ...restored, id: 'same-fiscal-doc' }] },
    { ...snapshot, receipts: [{ ...restored, total: 12_346 }] },
    { ...snapshot, receipts: [{ ...restored, roundingCategoryId: 'missing' }] },
    { ...snapshot, receiptRules: [{ ...snapshot.receiptRules[0], categoryId: 'missing' }] },
  ]) {
    status(await request('/migrate', { client: owner, body: { ...transfer, snapshot: invalid } }), 400)
  }
  assert.deepEqual((await sync(owner, cursor)).records, [])
  const result = status(await request('/migrate', { client: owner, body: transfer }), 200)
  assert.deepEqual(status(await request('/migrate', { client: owner, body: transfer }), 200), result)
  const feed = await sync(partner)
  assert.equal(record(feed, 'receipt', original.id).value, null)
  assert.deepEqual(record(feed, 'receipt', restored.id).value, {
    ...restored, memberId: partner.session.memberId, authorId: partner.session.memberId,
  })
  assert.equal(record(feed, 'profile', 'household').value.settings.roundReceiptTotals, true)
  assert.equal(record(feed, 'category', 'food').value.defaultBudgetScope, 'monthly_only')
  assert.equal(record(feed, 'transaction', 'original-expense').value.budgetScope, 'monthly_only')
  assert.deepEqual(record(feed, 'receiptRule', 'milk-rule').value, snapshot.receiptRules[0])
  assert.deepEqual(await sql(`SELECT total_minor FROM households WHERE id='${owner.session.householdId}'`), [{ total_minor: 12_499 }])
})

test('both members see one transfer, and scoped transactions and projected receipts reduce what can be transferred', async () => {
  const { owner, partner } = await pair()
  const draft = limitTransfer({ amount: 587_599 })
  const spending = { ...expense(partner, 'weekly-spend', '100001'), date: draft.start }
  status(await mutate(partner, mutation('transaction', spending.id, 0, spending)), 200)
  const monthlyOnly = { ...spending, id: 'monthly-spend', amount: '900000', budgetScope: 'monthly_only' }
  status(await mutate(partner, mutation('transaction', monthlyOnly.id, 0, monthlyOnly)), 200)
  const check = receipt(partner, 'week-receipt', {
    source: 'photo', fiscal: undefined, date: draft.start, budgetScope: 'monthly_only',
    budgetAmount: 12_400, roundingDelta: 55, roundingCategoryId: 'food',
  })
  check.items[0].budgetScope = 'weekly_and_monthly'
  status(await mutate(partner, mutation('receipt', check.id, 0, check)), 200)
  const { cursor } = await sync(owner)

  status(await mutate(owner, mutation('limitTransfer', draft.id, 0, { ...draft, amount: draft.amount + 1 })), 400)
  assert.deepEqual((await sync(partner, cursor)).records, [])
  const action = mutation('limitTransfer', draft.id, 0, draft)
  const saved = status(await mutate(owner, action), 200).record
  const changes = await sync(partner, cursor)
  assert.deepEqual(changes.records, [saved])
  assert.deepEqual(saved.value, draft)
  assert.deepEqual(await sql(`SELECT total_minor FROM households WHERE id='${owner.session.householdId}'`), [{ total_minor: 1_012_401 }])

  const homeSpend = { ...expense(partner, 'home-spend', '500000', 'home'), date: draft.start }
  status(await mutate(partner, mutation('transaction', homeSpend.id, 0, homeSpend)), 200)
  status(await mutate(partner, mutation('limitTransfer', draft.id, saved.version, { ...draft, cancelled: true })), 400)
  const reduction = status(await mutate(partner, mutation('limitTransfer', draft.id, saved.version, { ...draft, amount: 100_000 })), 200).record
  assert.equal(reduction.version, 2)
  assert.deepEqual(status(await mutate(owner, action), 200).record, saved)
  assert.deepEqual(record(await sync(owner), 'limitTransfer', draft.id), reduction)
  status(await mutate(partner, mutation('limitTransfer', draft.id, reduction.version, null)), 400)

  status(await mutate(partner, mutation('transaction', homeSpend.id, 1, null)), 200)
  const cancelled = status(await mutate(partner, mutation('limitTransfer', draft.id, reduction.version, { ...reduction.value, cancelled: true })), 200).record
  assert.deepEqual(record(await sync(owner), 'limitTransfer', draft.id), cancelled)
  assert.equal(cancelled.value.amount, 100_000)
  status(await mutate(owner, mutation('limitTransfer', draft.id, cancelled.version, reduction.value)), 400)
})

test('two participants cannot concurrently transfer the same available limit', async () => {
  const { owner, partner } = await pair()
  const initial = await sync(owner)
  const drafts = [limitTransfer({ amount: 500_000 }), limitTransfer({ amount: 500_000, toCategoryId: 'transport' })]
  const responses = await Promise.all([owner, partner].map((client, index) =>
    mutate(client, mutation('limitTransfer', drafts[index].id, 0, drafts[index]))))
  assert.equal(responses.filter(({ status }) => status === 200).length, 1)
  assert.ok(responses.some(({ status }) => status === 400 || status === 409))
  const accepted = responses.find(({ status }) => status === 200).data.record
  const feed = await sync(partner, initial.cursor)
  assert.deepEqual(feed.records, [accepted])
  const food = record(initial, 'category', 'food')
  const unsafeLimit = { ...food.value, limits: { ...food.value.limits, week: '499999' } }
  status(await mutate(owner, mutation('category', 'food', food.version, unsafeLimit)), 400)
  status(await mutate(partner, mutation('category', 'food', food.version, null)), 400)
  assert.deepEqual((await sync(owner, feed.cursor)).records, [])
})

test('restore preserves archived transfer history and detects older backups without transfers', async () => {
  const { owner, partner } = await pair()
  const draft = limitTransfer()
  const outside = limitTransfer({ start: '2021-01-04', end: '2021-01-11' })
  status(await mutate(partner, mutation('limitTransfer', outside.id, 0, outside)), 400)
  const initial = await sync(owner)
  const snapshot = {
    version: 3,
    profile: record(initial, 'profile', 'household').value,
    categories: initial.records.filter(({ kind }) => kind === 'category').map(({ value }) => ({
      ...value, archived: value.id === 'food',
    })),
    members: initial.records.filter(({ kind }) => kind === 'member').map(({ value }) => value),
    transactions: [], receipts: [], receiptRules: [],
    limitTransfers: [draft, { ...outside, cancelled: true }],
  }
  status(await request('/migrate', { client: owner, body: { id: randomUUID(), snapshot, expectedCursor: initial.cursor } }), 200)
  const feed = await sync(partner)
  assert.deepEqual(record(feed, 'limitTransfer', draft.id).value, draft)
  assert.deepEqual(record(feed, 'limitTransfer', outside.id).value, snapshot.limitTransfers[1])
  status(await mutate(partner, mutation('limitTransfer', outside.id, 1, { ...outside, cancelled: true })), 400)
  const archivedDraft = limitTransfer()
  status(await mutate(partner, mutation('limitTransfer', archivedDraft.id, 0, archivedDraft)), 400)
  for (const invalid of [
    { ...snapshot, limitTransfers: undefined },
    { ...snapshot, limitTransfers: [draft, draft] },
    { ...snapshot, limitTransfers: [{ ...draft, amount: 700_001 }] },
    { ...snapshot, limitTransfers: [{ ...draft, fromCategoryId: 'missing' }] },
  ]) {
    status(await request('/migrate', { client: owner, body: { id: randomUUID(), snapshot: invalid, expectedCursor: feed.cursor } }), 400)
  }
  assert.deepEqual((await sync(owner, feed.cursor)).records, [])
  const cancellation = status(await mutate(partner, mutation('limitTransfer', draft.id, 1, { ...draft, cancelled: true })), 200).record
  assert.equal(cancellation.value.cancelled, true)
  const latest = await sync(owner, feed.cursor)
  const replacement = { ...snapshot, limitTransfers: [snapshot.limitTransfers[1]] }
  status(await request('/migrate', { client: owner, body: { id: randomUUID(), snapshot: replacement, expectedCursor: latest.cursor } }), 200)
  assert.equal(record(await sync(partner), 'limitTransfer', draft.id).value, null)
})

test('creating households too frequently is rate-limited', async () => {
  await createBudget()
  for (let i = 0; i < 15; i += 1) {
    const response = await request('/households', {
      body: { name: 'Owner', budgetName: 'Rate limit fixture', timezone: 'Europe/Moscow' },
    })
    if (response.status === 429) {
      assert.ok(Number(response.headers.get('retry-after')) > 0, 'Response specifies when to retry')
      assert.equal(response.headers.get('set-cookie'), null)
      return
    }
    credentials(response, 'Create household before rate limit')
  }
  assert.fail('Repeated creation attempts were never limited')
})
