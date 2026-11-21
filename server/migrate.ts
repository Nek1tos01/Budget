import type { WireMember, WireSnapshot } from '../src/cloud/protocol'
import { requireOwner } from './auth'
import { assertActor, assertResult, processed, statement, unprocessed, type Actor, type D1Database } from './database'
import { ApiError, json, sha256 } from './http'
import { migration, parse, validateSnapshot } from './validation'

type StoredMember = { id: string; active: number; placeholder: number; role: 'owner' | 'member' }
type ImportedMember = Pick<WireMember, 'id' | 'name' | 'color'> & { placeholder: number }

function mapMembers(actor: Actor, snapshot: WireSnapshot, current: StoredMember[]) {
  const known = new Set(current.map(row => row.id))
  const available = current.find(row => row.role === 'member' && row.active)
    ?? current.find(row => row.placeholder)
  const mapping = new Map(snapshot.members.filter(row => known.has(row.id)).map(row => [row.id, row.id]))
  const unmapped = snapshot.members.filter(row => !known.has(row.id))
  const newMembers: ImportedMember[] = []
  const displayUpdates: Pick<WireMember, 'id' | 'name' | 'color'>[] = []
  const claimed = new Set(mapping.values())
  const sourceOwner = unmapped.find(row => row.role === 'owner')
    ?? (!claimed.has(actor.memberId) ? unmapped.find(row => row.role === undefined && row.active !== false) : undefined)
  if (sourceOwner) {
    if (claimed.has(actor.memberId)) throw new ApiError(400, 'В копии указано несколько владельцев.')
    mapping.set(sourceOwner.id, actor.memberId)
    claimed.add(actor.memberId)
  }
  let secondSeatMapped = false
  for (const row of unmapped) {
    if (row === sourceOwner) continue
    if (row.role === 'owner') throw new ApiError(400, 'В копии указано несколько владельцев.')
    const historical = row.active === false && !row.placeholder
    if (historical) {
      const id = crypto.randomUUID()
      mapping.set(row.id, id)
      newMembers.push({ id, name: row.name, color: row.color, placeholder: 0 })
      continue
    }
    if (secondSeatMapped || (available && claimed.has(available.id))) {
      throw new ApiError(400, 'В копии больше двух действующих профилей.')
    }
    secondSeatMapped = true
    const id = available?.id ?? crypto.randomUUID()
    mapping.set(row.id, id)
    if (!available) newMembers.push({ id, name: row.name, color: row.color, placeholder: 1 })
  }
  for (const row of snapshot.members) {
    const id = mapping.get(row.id)
    // Restore display data for the owner and reserved profile while preserving the other signed-in account.
    if (id && (id === actor.memberId || (available && available.placeholder && id === available.id))) {
      displayUpdates.push({ id, name: row.name, color: row.color })
    }
  }
  return { mapping, known, newMembers, displayUpdates }
}

function restoreRecords(
  db: D1Database,
  actor: Actor,
  now: number,
  id: string,
  kind: 'category' | 'transaction' | 'profile' | 'receipt' | 'receiptRule' | 'limitTransfer',
  rows: object[],
) {
  const key = kind === 'profile' ? "'household'" : "json_extract(item.value,'$.id')"
  return statement(db, `INSERT INTO records(household_id,kind,key,version,value,created_at,updated_at)
    SELECT ?1,?2,${key},1,item.value,?3,?3 FROM json_each(?4) item
    WHERE NOT EXISTS(SELECT 1 FROM processed_mutations WHERE household_id=?1 AND member_id=?5 AND id=?6)
    ON CONFLICT(household_id,kind,key) DO UPDATE SET
      version=records.version+1,value=excluded.value,updated_at=excluded.updated_at`,
  actor.householdId, kind, now, JSON.stringify(rows), actor.memberId, id)
}

export async function restore(db: D1Database, actor: Actor, input: unknown, now: number) {
  requireOwner(actor)
  const { id, expectedCursor, snapshot } = parse(migration, input)
  const digest = await sha256(JSON.stringify({ route: 'migrate', expectedCursor, snapshot }))
  type RestoreState = { cursor: number; legacy_blocked: number; transfers_missing: number }
  const [, previous, current, state] = await db.batch<{ digest: string; response: string } | StoredMember | RestoreState>([
    assertActor(db, actor, now, true),
    processed(db, actor, id),
    statement(db, 'SELECT id,role,active,placeholder FROM members WHERE household_id=?', actor.householdId),
    statement(db, `SELECT cursor, EXISTS(
      SELECT 1 FROM records WHERE household_id=households.id AND value IS NOT NULL
        AND ((?2=1 AND kind='receipt') OR (?3=1 AND kind='receiptRule'))
    ) AS legacy_blocked, (?4=1 AND EXISTS(
      SELECT 1 FROM records WHERE household_id=households.id AND kind='limitTransfer' AND value IS NOT NULL
    )) AS transfers_missing FROM households WHERE id=?1`,
    actor.householdId, snapshot.receipts === undefined ? 1 : 0, snapshot.receiptRules === undefined ? 1 : 0,
    snapshot.limitTransfers === undefined ? 1 : 0),
  ])
  const replay = previous.results[0]
  if (replay && 'digest' in replay) {
    if (replay.digest !== digest) throw new ApiError(409, 'Идентификатор запроса уже использован.')
    return json(JSON.parse(replay.response))
  }
  const currentState = state.results[0] as RestoreState
  if (currentState.cursor !== expectedCursor) throw new ApiError(409, 'Данные изменились на другом устройстве.')
  if (currentState.legacy_blocked) throw new ApiError(400, 'Эта копия не содержит данные чеков. Используйте актуальную копию бюджета.')
  if (currentState.transfers_missing) throw new ApiError(400, 'Эта копия не содержит историю переносов лимитов. Используйте актуальную копию бюджета.')
  const total = validateSnapshot(snapshot)
  const { mapping, known, newMembers, displayUpdates } = mapMembers(actor, snapshot, current.results as StoredMember[])
  const transactions = snapshot.transactions.map(row => ({
    ...row,
    memberId: mapping.get(row.memberId),
    authorId: row.authorId && known.has(row.authorId) ? row.authorId : actor.memberId,
    createdAt: row.createdAt ?? now,
  }))
  const receipts = (snapshot.receipts ?? []).map(row => ({
    ...row,
    memberId: mapping.get(row.memberId),
    authorId: (row.authorId && mapping.get(row.authorId)) || actor.memberId,
  }))
  const noReplay = [actor.householdId, actor.memberId, id] as const
  const result = await db.batch<{ digest: string; response: string }>([
    assertActor(db, actor, now, true),
    assertResult(db,
      `COALESCE((SELECT digest=?4 FROM processed_mutations WHERE household_id=?1 AND member_id=?2 AND id=?3),1)`,
      `EXISTS(SELECT 1 FROM processed_mutations WHERE household_id=?1 AND member_id=?2 AND id=?3)
        OR (SELECT cursor=?5 FROM households WHERE id=?1)`, ...noReplay, digest, expectedCursor),
    statement(db, `INSERT INTO members(household_id,id,role,active,placeholder,name,color,created_at,updated_at)
      SELECT ?1,json_extract(value,'$.id'),'member',0,json_extract(value,'$.placeholder'),
        json_extract(value,'$.name'),json_extract(value,'$.color'),?2,?2 FROM json_each(?3)
      WHERE ${unprocessed}`, actor.householdId, now, JSON.stringify(newMembers), ...noReplay),
    statement(db, `UPDATE members SET
      name=json_extract(item.value,'$.name'),color=json_extract(item.value,'$.color'),updated_at=?1
      FROM json_each(?2) item WHERE members.household_id=?3 AND members.id=json_extract(item.value,'$.id')
      AND ${unprocessed}`,
    now, JSON.stringify(displayUpdates), actor.householdId, ...noReplay),
    // Clear the previous turnover before adding the replacement so intermediate totals stay in range.
    statement(db, `UPDATE records SET version=version+1,value=NULL,updated_at=? WHERE household_id=?
      AND kind IN ('transaction','receipt','receiptRule','limitTransfer') AND value IS NOT NULL AND ${unprocessed}`, now, actor.householdId, ...noReplay),
    statement(db, `UPDATE records SET version=version+1,value=NULL,updated_at=? WHERE household_id=?
      AND kind='category' AND value IS NOT NULL AND key NOT IN (SELECT value FROM json_each(?))
      AND ${unprocessed}`, now, actor.householdId, JSON.stringify(snapshot.categories.map(row => row.id)), ...noReplay),
    restoreRecords(db, actor, now, id, 'profile', [snapshot.profile]),
    restoreRecords(db, actor, now, id, 'category', snapshot.categories),
    restoreRecords(db, actor, now, id, 'transaction', transactions),
    restoreRecords(db, actor, now, id, 'receipt', receipts),
    restoreRecords(db, actor, now, id, 'receiptRule', snapshot.receiptRules ?? []),
    restoreRecords(db, actor, now, id, 'limitTransfer', snapshot.limitTransfers ?? []),
    assertResult(db, '1',
      `EXISTS(SELECT 1 FROM processed_mutations WHERE household_id=?1 AND member_id=?2 AND id=?3)
        OR (SELECT total_minor=?4 FROM households WHERE id=?1)`, ...noReplay, total.toString()),
    statement(db, `INSERT INTO processed_mutations(household_id,member_id,id,digest,response,created_at)
      SELECT ?1,?2,?3,?4,json_object('cursor',cursor),?5 FROM households WHERE id=?1
      ON CONFLICT(household_id,member_id,id) DO NOTHING`, ...noReplay, digest, now),
    processed(db, actor, id),
  ])
  return json(JSON.parse(result[result.length - 1].results[0].response))
}
