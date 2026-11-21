import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import type { Session } from '../src/cloud/protocol'
import { ApiError } from './http'

export type { D1Database }
export type BoundValue = string | number | null
export type Actor = Session & { hash: string; expiresAt: number }

export const validSession = `SELECT 1 FROM sessions s
  JOIN members m ON m.household_id=s.household_id AND m.id=s.member_id
  WHERE s.token_hash=? AND s.expires_at>? AND s.household_id=? AND s.member_id=? AND m.active=1`

export function statement(db: D1Database, sql: string, ...values: BoundValue[]): D1PreparedStatement {
  return db.prepare(sql).bind(...values)
}

export const actorBindings = (actor: Actor, now: number) => [actor.hash, now, actor.householdId, actor.memberId] as const

export function assertActor(db: D1Database, actor: Actor, now: number, owner = false) {
  return statement(db, `INSERT INTO operation_assertions VALUES (EXISTS(${validSession}
    ${owner ? "AND m.role='owner'" : ''}), 1, 1, 1)`, ...actorBindings(actor, now))
}

export function assertResult(db: D1Database, digestMatches: string, stateMatches: string, ...values: BoundValue[]) {
  return statement(db, `INSERT INTO operation_assertions VALUES (1, ${digestMatches}, ${stateMatches}, 1)`, ...values)
}

export function processed(db: D1Database, actor: Actor, id: string) {
  return statement(db, 'SELECT digest, response FROM processed_mutations WHERE household_id=? AND member_id=? AND id=?',
    actor.householdId, actor.memberId, id)
}

export const unprocessed = 'NOT EXISTS (SELECT 1 FROM processed_mutations WHERE household_id=? AND member_id=? AND id=?)'

// Internal result codes preserve predictable HTTP errors without exposing SQL diagnostics.
export function databaseError(error: unknown): never {
  const message = error instanceof Error ? error.message + ' ' + String(error.cause ?? '') : ''
  if (message.includes('budget_unauthorized')) throw new ApiError(401, 'Сессия завершилась. Войдите снова.')
  if (message.includes('budget_id_reused')) throw new ApiError(409, 'Идентификатор запроса уже использован.')
  if (message.includes('budget_conflict')) throw new ApiError(409, 'Данные изменились на другом устройстве.')
  if (message.includes('budget_reference')) throw new ApiError(400, 'Запись ссылается на недоступные данные.')
  if (message.includes('budget_fiscal_immutable')) throw new ApiError(400, 'Фискальные реквизиты сохранённого чека нельзя изменить.')
  if (message.includes('total_minor BETWEEN')) throw new ApiError(400, 'Оборот превышает допустимую точность.')
  throw error
}
