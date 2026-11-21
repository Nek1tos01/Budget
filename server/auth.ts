import { z } from 'zod'
import type { Authentication, Session, WireCategory, WireProfile } from '../src/cloud/protocol'
import { actorBindings, assertActor, statement, validSession, type Actor, type D1Database } from './database'
import { ApiError, isLocalHttp, isSecret, json, secret, sha256 } from './http'
import { identifier, parse, profileName, timezone } from './validation'

const sessionName = 'budget_session'
const second = 1000
const hour = 60 * 60 * second
const day = 24 * hour
const sessionLifetime = 30 * day
const invitationLifetime = 15 * 60 * second
const confirmationLifetime = 15 * 60 * second
const ownerColor = '#a092ff'
const memberColor = '#f0a2bf'
const starterCategories: WireCategory[] = [
  { id: 'food', name: 'Продукты', emoji: '🛒', color: '#a092ff', limits: { week: '700000', month: '2900000' }, archived: false },
  { id: 'cafe', name: 'Кафе', emoji: '☕', color: '#f3ab72', limits: { week: '350000', month: '1500000' }, archived: false },
  { id: 'transport', name: 'Транспорт', emoji: '🚌', color: '#74b5ff', limits: { week: '250000', month: '1050000' }, archived: false },
  { id: 'fun', name: 'Развлечения', emoji: '🍿', color: '#e992c6', limits: { week: '300000', month: '1200000' }, archived: false },
  { id: 'home', name: 'Дом', emoji: '🏠', color: '#71d4b6', limits: { week: '400000', month: '1800000' }, archived: false },
]

const empty = z.object({}).strict()
const createBody = z.object({ name: profileName, budgetName: profileName, timezone }).strict()
const tokenSchema = z.string().refine(isSecret)
const joinBody = z.object({ name: profileName, token: tokenSchema }).strict()
const recoverBody = z.object({ code: tokenSchema }).strict()
const revokeBody = z.object({ memberId: identifier }).strict()

export function cookie(request: Request, token: string, lifetime = sessionLifetime) {
  const secure = isLocalHttp(new URL(request.url)) ? '' : '; Secure'
  return `${sessionName}=${token}; HttpOnly${secure}; SameSite=Strict; Path=/api/v1; Max-Age=${lifetime / second}`
}

function sessionToken(request: Request) {
  const candidates = request.headers.get('cookie')?.split(';').map(value => value.trim())
    .filter(value => value.startsWith(sessionName + '=')) ?? []
  const token = candidates.length === 1 ? candidates[0].slice(sessionName.length + 1) : ''
  return isSecret(token) ? token : null
}

function publicSession({ householdId, memberId, role }: Session): Session {
  return { householdId, memberId, role }
}

export async function requireActor(db: D1Database, request: Request, now: number): Promise<Actor> {
  const token = sessionToken(request)
  const hash = token ? await sha256(token) : null
  const row = hash && await statement(db, `SELECT s.household_id AS householdId,s.member_id AS memberId,
    m.role,s.expires_at AS expiresAt FROM sessions s
    JOIN members m ON m.household_id=s.household_id AND m.id=s.member_id
    WHERE s.token_hash=? AND s.expires_at>? AND m.active=1`, hash, now).first<Session & { expiresAt: number }>()
  if (!row || !hash) throw new ApiError(401, 'Сессия завершилась. Войдите снова.')
  return { ...row, hash }
}

export function requireOwner(actor: Actor) {
  if (actor.role !== 'owner') throw new ApiError(403, 'Это действие доступно владельцу бюджета.')
}

export function requireScope(actor: Actor, request: Request) {
  if (request.headers.get('X-Budget-Household') !== actor.householdId ||
      request.headers.get('X-Budget-Member') !== actor.memberId) {
    throw new ApiError(403, 'На устройстве открыт другой профиль бюджета.')
  }
}

export async function refreshCookie(db: D1Database, request: Request, actor: Actor, now: number) {
  if (actor.expiresAt >= now + 7 * day) return null
  const token = sessionToken(request)
  if (!token) return null
  try {
    const update = await statement(db, `UPDATE sessions SET expires_at=?
      WHERE token_hash=? AND expires_at>? AND expires_at<? AND EXISTS(${validSession})`,
    now + sessionLifetime, actor.hash, now, now + 7 * day,
    ...actorBindings(actor, now)).run()
    return update.meta.changes ? cookie(request, token) : null
  } catch {
    // The read can still succeed while a renewal write is unavailable.
    return null
  }
}

export async function currentSession(db: D1Database, request: Request, actor: Actor, now: number) {
  const refreshed = await refreshCookie(db, request, actor, now)
  return json({ session: publicSession(actor) }, 200, refreshed ? { 'Set-Cookie': refreshed } : undefined)
}

async function credentials() {
  const token = secret()
  const recoveryCode = secret()
  const [tokenHash, recoveryHash] = await Promise.all([sha256(token), sha256(recoveryCode)])
  return { token, tokenHash, recoveryCode, recoveryHash }
}

function authenticated(request: Request, session: Session, keys: Awaited<ReturnType<typeof credentials>>, status = 200) {
  const result: Authentication = { session: publicSession(session), recoveryCode: keys.recoveryCode }
  return json(result, status, { 'Set-Cookie': cookie(request, keys.token) })
}

async function throttle(db: D1Database, scope: string, key: string, now: number, perKey: number, global: number) {
  const start = Math.floor(now / hour) * hour
  const hashedKey = await sha256(`${start}:${key}`)
  const specific = `${scope}:${hashedKey}`
  const shared = `${scope}:global`
  const accepted = await statement(db, `WITH allowable AS MATERIALIZED (
    SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM rate_limits WHERE scope=?1 AND window_start=?3 AND attempts>=?4)
      AND NOT EXISTS(SELECT 1 FROM rate_limits WHERE scope=?2 AND window_start=?3 AND attempts>=?5)
  ), scopes(scope) AS (VALUES (?1), (?2))
  INSERT INTO rate_limits(scope,window_start,attempts)
    SELECT scope,?3,1 FROM scopes CROSS JOIN allowable WHERE true
    ON CONFLICT(scope,window_start) DO UPDATE SET attempts=attempts+1
    RETURNING scope`, specific, shared, start, perKey, global).all<{ scope: string }>()
  if (accepted.results.length === 0) throw new ApiError(429, 'Слишком много попыток. Повторите позже.', {
    retryAfter: Math.ceil((start + hour - now) / second),
  })
  await statement(db, `DELETE FROM rate_limits WHERE (scope,window_start) IN (
    SELECT scope,window_start FROM rate_limits WHERE window_start<? LIMIT 100
  )`, start - hour).run()
}

const clientAddress = (request: Request) => request.headers.get('CF-Connecting-IP') || 'unknown'

export async function createHousehold(db: D1Database, request: Request, input: unknown, now: number) {
  await throttle(db, 'create', clientAddress(request), now, 8, 120)
  const body = parse(createBody, input)
  const keys = await credentials()
  const householdId = crypto.randomUUID()
  const memberId = crypto.randomUUID()
  const placeholderId = crypto.randomUUID()
  const profile: WireProfile = {
    household: { id: 'household', name: body.budgetName },
    settings: { weekStart: 1, timezone: body.timezone, theme: 'dark', lastCategory: null, demo: false },
    budget: { week: '2000000', month: '9000000' },
  }
  await db.batch([
    statement(db, 'INSERT INTO households(id,created_at) VALUES (?,?)', householdId, now),
    statement(db, `INSERT INTO members VALUES
      (?1,?2,'owner',1,0,?3,?4,?5,?5),(?1,?6,'member',0,1,'Участник 2',?7,?5,?5)`,
    householdId, memberId, body.name, ownerColor, now, placeholderId, memberColor),
    statement(db, `INSERT INTO records(household_id,kind,key,version,value,created_at,updated_at)
      VALUES (?1,'profile','household',1,?2,?3,?3)`, householdId, JSON.stringify(profile), now),
    statement(db, `INSERT INTO records(household_id,kind,key,version,value,created_at,updated_at)
      SELECT ?,'category',json_extract(value,'$.id'),1,value,?2,?2 FROM json_each(?3)`,
    householdId, now, JSON.stringify(starterCategories)),
    statement(db, 'INSERT INTO sessions VALUES (?,?,?,?,?)', keys.tokenHash, householdId, memberId, now, now + sessionLifetime),
    statement(db, `INSERT INTO recovery_credentials(code_hash,household_id,member_id,created_at)
      VALUES (?,?,?,?)`, keys.recoveryHash, householdId, memberId, now),
  ])
  return authenticated(request, { householdId, memberId, role: 'owner' }, keys, 201)
}

export async function invite(db: D1Database, actor: Actor, input: unknown, now: number) {
  requireOwner(actor)
  parse(empty, input)
  await throttle(db, 'invite', actor.householdId, now, 20, 600)
  const token = secret()
  const hash = await sha256(token)
  const expiresAt = now + invitationLifetime
  const [, result] = await db.batch([
    assertActor(db, actor, now, true),
    statement(db, `INSERT INTO invitations(token_hash,household_id,created_at,expires_at)
      SELECT ?,?,?,? WHERE NOT EXISTS(
        SELECT 1 FROM members WHERE household_id=? AND role='member' AND active=1
      ) RETURNING token_hash`, hash, actor.householdId, now, expiresAt, actor.householdId),
    statement(db, `DELETE FROM invitations WHERE household_id=?1 AND token_hash<>?2
      AND EXISTS (SELECT 1 FROM invitations WHERE token_hash=?2)`, actor.householdId, hash),
    statement(db, `DELETE FROM invitations WHERE token_hash IN (
      SELECT token_hash FROM invitations WHERE expires_at<=? LIMIT 100
    )`, now),
  ])
  if (result.results.length === 0) throw new ApiError(409, 'В бюджете уже два активных участника.')
  return json({ token, expiresAt: new Date(expiresAt).toISOString() })
}

export async function joinHousehold(db: D1Database, request: Request, input: unknown, now: number) {
  await throttle(db, 'join', clientAddress(request), now, 30, 600)
  const { token, name } = parse(joinBody, input)
  const [inviteHash, keys] = await Promise.all([sha256(token), credentials()])
  const newId = crypto.randomUUID()
  const [, , , , result] = await db.batch([
    // Marking the token and assigning the slot happen in the same transaction.
    statement(db, `UPDATE invitations SET consumed_at=?1,consumption_nonce=?3
      WHERE token_hash=?2 AND consumed_at IS NULL AND expires_at>?1
      AND NOT EXISTS (SELECT 1 FROM members WHERE household_id=invitations.household_id AND role='member' AND active=1)
      RETURNING household_id`, now, inviteHash, keys.tokenHash),
    statement(db, `INSERT INTO members(household_id,id,role,active,placeholder,name,color,created_at,updated_at)
      SELECT household_id,?1,'member',1,0,?2,?3,?4,?4 FROM invitations
      WHERE token_hash=?5 AND consumption_nonce=?6
        AND NOT EXISTS (SELECT 1 FROM members WHERE household_id=invitations.household_id AND placeholder=1)`,
    newId, name, memberColor, now, inviteHash, keys.tokenHash),
    statement(db, `UPDATE members SET active=1,placeholder=0,name=?1,updated_at=?2
      WHERE placeholder=1 AND EXISTS (
        SELECT 1 FROM invitations i WHERE i.token_hash=?3 AND i.household_id=members.household_id
          AND i.consumption_nonce=?4
      )`, name, now, inviteHash, keys.tokenHash),
    statement(db, `INSERT INTO sessions
      SELECT ?1,m.household_id,m.id,?2,?3 FROM members m JOIN invitations i ON m.household_id=i.household_id
      WHERE i.token_hash=?4 AND i.consumption_nonce=?1 AND m.role='member' AND m.active=1`,
    keys.tokenHash, now, now + sessionLifetime, inviteHash),
    statement(db, `UPDATE invitations SET consumption_nonce=NULL,
      consumed_member_id=(SELECT member_id FROM sessions WHERE token_hash=?1)
      WHERE token_hash=?2 AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=?1)
      RETURNING household_id AS householdId,consumed_member_id AS memberId`, keys.tokenHash, inviteHash),
    statement(db, `INSERT INTO recovery_credentials(code_hash,household_id,member_id,created_at)
      SELECT ?,household_id,member_id,? FROM sessions WHERE token_hash=?`, keys.recoveryHash, now, keys.tokenHash),
    statement(db, `DELETE FROM sessions WHERE token_hash IN (
      SELECT token_hash FROM sessions WHERE expires_at<=? LIMIT 100
    )`, now),
  ])
  const joined = result.results[0] as Omit<Session, 'role'> | undefined
  if (!joined) throw new ApiError(409, 'Приглашение недействительно или срок его действия истёк.')
  return authenticated(request, { ...joined, role: 'member' }, keys)
}

export async function recover(db: D1Database, request: Request, input: unknown, now: number) {
  const householdId = request.headers.get('X-Budget-Household')
  const memberId = request.headers.get('X-Budget-Member')
  if ((householdId === null) !== (memberId === null)) throw new ApiError(400, 'Укажите оба идентификатора профиля.')
  if (householdId !== null) {
    parse(identifier, householdId)
    parse(identifier, memberId)
  }
  await throttle(db, 'recover', clientAddress(request), now, 20, 600)
  const { code } = parse(recoverBody, input)
  const [codeHash, keys] = await Promise.all([sha256(code), credentials()])
  const [, , , result] = await db.batch([
    statement(db, `INSERT INTO pending_recoveries(household_id,member_id,code_hash,session_token_hash,expires_at)
      SELECT r.household_id,r.member_id,?1,?2,?3 FROM recovery_credentials r
      JOIN members m ON m.household_id=r.household_id AND m.id=r.member_id
      WHERE r.code_hash=?4 AND m.active=1 AND (?5 IS NULL OR (r.household_id=?5 AND r.member_id=?6))
      ON CONFLICT(household_id,member_id) DO UPDATE SET code_hash=excluded.code_hash,
        session_token_hash=excluded.session_token_hash,expires_at=excluded.expires_at`,
    keys.recoveryHash, keys.tokenHash, now + confirmationLifetime, codeHash, householdId, memberId),
    statement(db, `DELETE FROM sessions WHERE (household_id,member_id) IN (
      SELECT household_id,member_id FROM pending_recoveries WHERE session_token_hash=?
    ) OR token_hash IN (SELECT token_hash FROM sessions WHERE expires_at<=? LIMIT 100)`, keys.tokenHash, now),
    statement(db, `INSERT INTO sessions SELECT session_token_hash,household_id,member_id,?,?
      FROM pending_recoveries WHERE session_token_hash=?`, now, now + sessionLifetime, keys.tokenHash),
    statement(db, `SELECT s.household_id AS householdId,s.member_id AS memberId,m.role FROM sessions s
      JOIN members m ON m.household_id=s.household_id AND m.id=s.member_id WHERE s.token_hash=?`, keys.tokenHash),
    statement(db, `DELETE FROM pending_recoveries WHERE code_hash IN (
      SELECT code_hash FROM pending_recoveries WHERE expires_at<=? LIMIT 100
    )`, now),
  ])
  const session = result.results[0] as Session | undefined
  if (!session) throw new ApiError(401, 'Код восстановления недействителен.')
  return authenticated(request, session, keys)
}

export async function confirmRecovery(db: D1Database, actor: Actor, input: unknown, now: number) {
  const { code } = parse(recoverBody, input)
  const codeHash = await sha256(code)
  const [, , confirmation] = await db.batch([
    assertActor(db, actor, now),
    statement(db, `UPDATE recovery_credentials SET code_hash=?1,confirmed_session_hash=?2,created_at=?3
      WHERE household_id=?4 AND member_id=?5 AND EXISTS (
        SELECT 1 FROM pending_recoveries WHERE household_id=?4 AND member_id=?5 AND code_hash=?1
          AND session_token_hash=?2 AND expires_at>?3
      )`, codeHash, actor.hash, now, actor.householdId, actor.memberId),
    statement(db, `SELECT 1 FROM recovery_credentials WHERE household_id=? AND member_id=?
      AND code_hash=? AND confirmed_session_hash=?`, actor.householdId, actor.memberId, codeHash, actor.hash),
    statement(db, `DELETE FROM pending_recoveries WHERE household_id=?1 AND member_id=?2 AND code_hash=?3
      AND EXISTS (SELECT 1 FROM recovery_credentials WHERE household_id=?1 AND member_id=?2
        AND code_hash=?3 AND confirmed_session_hash=?4)`, actor.householdId, actor.memberId, codeHash, actor.hash),
  ])
  if (confirmation.results.length === 0) {
    throw new ApiError(409, 'Код подтверждения устарел. Восстановите доступ исходным кодом ещё раз.')
  }
  return json({ ok: true })
}

export async function revoke(db: D1Database, actor: Actor, input: unknown, now: number) {
  requireOwner(actor)
  const { memberId } = parse(revokeBody, input)
  if (memberId === actor.memberId) throw new ApiError(403, 'Владелец не может отозвать собственный доступ.')
  const [, result] = await db.batch([
    assertActor(db, actor, now, true),
    statement(db, `UPDATE members SET active=0,updated_at=? WHERE household_id=? AND id=? AND role='member'
      AND placeholder=0 RETURNING id`, now, actor.householdId, memberId),
  ])
  if (result.results.length === 0) throw new ApiError(404, 'Участник не найден.')
  return json({ ok: true })
}

export async function leaveHousehold(db: D1Database, request: Request, actor: Actor, input: unknown, now: number) {
  if (actor.role === 'owner') throw new ApiError(403, 'Владелец не может покинуть общий бюджет.')
  parse(empty, input)
  await db.batch([
    assertActor(db, actor, now),
    statement(db, `UPDATE members SET active=0,updated_at=? WHERE household_id=? AND id=? AND role='member'`,
      now, actor.householdId, actor.memberId),
  ])
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', 0) })
}

export async function logout(db: D1Database, request: Request, actor: Actor, input: unknown) {
  parse(empty, input)
  await statement(db, 'DELETE FROM sessions WHERE token_hash=?', actor.hash).run()
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', 0) })
}
