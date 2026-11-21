import {
  decodeCategory, decodeTransaction,
  type CloudRecord, type EntityKind, type Mutation, type SyncPage, type WireProfile,
} from '../src/cloud/protocol'
import {
  assertLimitTransferChange, currentLimitPeriod, sameLimitPeriod,
} from '../src/domain/limit-transfers'
import { MAX_MONEY } from '../src/domain/models'
import { receiptCategoryIds, receiptOperations, type FiscalReceipt } from '../src/domain/receipts'
import {
  actorBindings, assertActor, assertResult, processed, statement, unprocessed, validSession,
  type Actor, type D1Database,
} from './database'
import { ApiError, json, sha256 } from './http'
import { parseMutation, validateLimitChange } from './validation'

type StoredRecord = { kind: EntityKind; key: string; version: number; value: string | null }
type EmptyRecord = { kind: null; key: null; version: null; value: null }
type SyncRow = { cursor: number; revision: number | null; overflow: number } & (StoredRecord | EmptyRecord)
type LimitState = { cursor: number; profile: string } & (StoredRecord | EmptyRecord)
type Processed = { digest: string; response: string }
const pageSize = 100
const pageBytes = 1024 * 1024

function toRecord(row: StoredRecord): CloudRecord {
  return { kind: row.kind, key: row.key, version: row.version, value: row.value === null ? null : JSON.parse(row.value) }
}

export async function sync(db: D1Database, actor: Actor, url: URL, now: number) {
  const raw = url.searchParams.get('after') ?? '0'
  const after = Number(raw)
  if (!/^(0|[1-9][0-9]{0,15})$/.test(raw) || !Number.isSafeInteger(after)) {
    throw new ApiError(400, 'Некорректная ревизия синхронизации.')
  }
  // Return one lightweight sentinel when the next receipt would exceed the page budget.
  const { results } = await statement(db, `WITH candidates AS (
    SELECT h.id AS household_id,h.cursor,r.kind,r.key,r.version,r.revision,
      COALESCE(length(CAST(r.value AS BLOB)),0)+1024 AS bytes
    FROM households h LEFT JOIN records r ON r.household_id=h.id AND r.revision>iif(?1>h.cursor,0,?1)
    WHERE h.id=?2 AND EXISTS(${validSession}) ORDER BY r.revision LIMIT ${pageSize + 1}
  ), sizes AS (
    SELECT *, SUM(bytes) OVER (ORDER BY revision ROWS UNBOUNDED PRECEDING) AS cumulative FROM candidates
  )
  SELECT s.cursor,s.kind,s.key,s.version,s.revision,r.value,s.cumulative>${pageBytes} AS overflow
    FROM sizes s LEFT JOIN records r ON r.household_id=s.household_id AND r.kind=s.kind AND r.key=s.key
      AND s.cumulative<=${pageBytes}
    WHERE s.cumulative-s.bytes<=${pageBytes} ORDER BY s.revision`,
  after, actor.householdId, ...actorBindings(actor, now)).all<SyncRow>()
  if (results.length === 0) throw new ApiError(401, 'Сессия завершилась. Войдите снова.')
  const boundary = results[0].cursor
  const more = results.length > pageSize || results.some(row => row.overflow === 1)
  const rows = results.slice(0, pageSize).filter(row => row.overflow === 0)
  const response: SyncPage = {
    cursor: more ? rows[rows.length - 1].revision ?? boundary : boundary,
    records: rows.filter(row => row.kind !== null).map(toRecord),
    more,
    ...(after > boundary ? { reset: true } : {}),
  }
  return json(response)
}

function writeEntity(db: D1Database, actor: Actor, mutation: Mutation, now: number) {
  const { kind, key, id, value } = mutation
  if (kind === 'member' && value) {
    return statement(db, `UPDATE members SET name=?1,color=?2,updated_at=?3 WHERE household_id=?4 AND id=?5
      AND ${unprocessed}`, value.name, value.color, now, actor.householdId, key, actor.householdId, actor.memberId, id)
  }
  // Preserve original authorship and server creation time across ordinary edits.
  const author = "'$.authorId', COALESCE(json_extract(old.value,'$.authorId'),?5)"
  let payload = '?4'
  if (kind === 'transaction' && value) {
    payload = `json_set(?4, ${author}, '$.createdAt', COALESCE(json_extract(old.value,'$.createdAt'),?6))`
  }
  if (kind === 'receipt' && value) payload = `json_set(?4, ${author})`
  return statement(db, `INSERT INTO records(household_id,kind,key,version,value,created_at,updated_at)
    SELECT ?1,?2,?3,1,${payload},?6,?6
    FROM (SELECT 1) LEFT JOIN records old ON old.household_id=?1 AND old.kind=?2 AND old.key=?3
    WHERE NOT EXISTS(SELECT 1 FROM processed_mutations WHERE household_id=?1 AND member_id=?5 AND id=?7)
    ON CONFLICT(household_id,kind,key) DO UPDATE SET
      version=records.version+1,value=excluded.value,updated_at=excluded.updated_at`,
  actor.householdId, kind, key, value === null ? null : JSON.stringify(value), actor.memberId, now, id)
}

function assertCategoryAccess(db: D1Database, actor: Actor, mutation: Mutation) {
  const { kind, key, id, value } = mutation
  let categoryIds: string[] = []
  if (kind === 'transaction' && value?.categoryId) categoryIds = [value.categoryId]
  if (kind === 'receipt' && value) categoryIds = [...receiptCategoryIds(value)]
  if (kind === 'receiptRule' && value) categoryIds = [value.categoryId]
  if (!categoryIds.length) return []
  return [statement(db, `INSERT INTO operation_assertions
    VALUES (1,1,1, EXISTS(
      SELECT 1 FROM processed_mutations WHERE household_id=?1 AND member_id=?2 AND id=?3
    ) OR NOT EXISTS (
      SELECT 1 FROM json_each(?4) incoming WHERE NOT EXISTS (
        SELECT 1 FROM records c WHERE c.household_id=?1 AND c.kind='category'
          AND c.key=incoming.value AND c.value IS NOT NULL
          AND (json_extract(c.value,'$.archived')=0 OR (?5 != 'receiptRule' AND EXISTS(
            SELECT 1 FROM record_category_refs
              WHERE household_id=?1 AND kind=?5 AND key=?6 AND category_id=c.key
          )))
      )
    ))`, actor.householdId, actor.memberId, id, JSON.stringify(categoryIds), kind, key)]
}

function assertCategoryLimit(db: D1Database, actor: Actor, { id, key, kind, value }: Mutation) {
  if (kind !== 'category' || !value) return []
  return [statement(db, `INSERT INTO operation_assertions VALUES (1,1,1,
    EXISTS(SELECT 1 FROM processed_mutations WHERE household_id=?1 AND member_id=?2 AND id=?3)
    OR NOT EXISTS (
      SELECT 1 FROM records WHERE household_id=?1 AND kind='limitTransfer' AND value IS NOT NULL
        AND json_extract(value,'$.cancelled')=0
        AND ?4 IN (json_extract(value,'$.fromCategoryId'),json_extract(value,'$.toCategoryId'))
      GROUP BY json_extract(value,'$.kind'),json_extract(value,'$.start'),json_extract(value,'$.end')
      HAVING (CASE json_extract(value,'$.kind') WHEN 'week' THEN ?5 ELSE ?6 END) + SUM(
        iif(json_extract(value,'$.fromCategoryId')=?4,-1,1)*json_extract(value,'$.amount')
      ) NOT BETWEEN 0 AND ?7
    ))`, actor.householdId, actor.memberId, id, key, value.limits.week, value.limits.month, MAX_MONEY)]
}

async function duplicateReceipt(db: D1Database, actor: Actor, fiscal: FiscalReceipt): Promise<never> {
  const { fn, i, fp, n } = fiscal
  const existing = await statement(db, `SELECT r.kind,r.key,r.version,r.value FROM households h
    LEFT JOIN records r ON r.household_id=h.id AND r.kind='receipt' AND r.value IS NOT NULL
      AND json_extract(r.value,'$.fiscal.fn')=? AND json_extract(r.value,'$.fiscal.i')=?
      AND json_extract(r.value,'$.fiscal.fp')=? AND json_extract(r.value,'$.fiscal.n')=?
    WHERE h.id=? AND EXISTS(${validSession})`,
  fn, i, fp, n, actor.householdId, ...actorBindings(actor, Date.now())).first<StoredRecord | EmptyRecord>()
  if (!existing) throw new ApiError(401, 'Сессия завершилась. Войдите снова.')
  throw new ApiError(409, 'Этот чек уже добавлен.', {
    code: 'receipt_duplicate', record: existing.kind === null ? null : toRecord(existing),
  })
}

async function prepareLimitChange(db: D1Database, actor: Actor,
  action: Extract<Mutation, { kind: 'limitTransfer' }>, digest: string, now: number) {
  const transfer = action.value
  if (!transfer) throw new ApiError(400, 'Отмените перенос, чтобы сохранить его в истории.')
  const [, previous, state, dependencies] = await db.batch<Processed | LimitState | StoredRecord>([
    assertActor(db, actor, now),
    processed(db, actor, action.id),
    statement(db, `SELECT h.cursor,p.value AS profile,r.kind,r.key,r.version,r.value
      FROM households h JOIN records p ON p.household_id=h.id AND p.kind='profile' AND p.key='household'
      LEFT JOIN records r ON r.household_id=h.id AND r.kind='limitTransfer' AND r.key=?2 WHERE h.id=?1`,
    actor.householdId, action.key),
    statement(db, `SELECT kind,key,version,value FROM records WHERE household_id=?1 AND value IS NOT NULL
      AND (kind='category' AND key IN (?3,?4)
        OR kind='limitTransfer' AND json_extract(value,'$.kind')=?2
          AND json_extract(value,'$.start')=?5 AND json_extract(value,'$.end')=?6
        OR (kind='receipt' OR (kind='transaction' AND json_extract(value,'$.categoryId') IN (?3,?4)))
          AND json_extract(value,'$.date')>=?5 AND json_extract(value,'$.date')<?6)
      AND NOT EXISTS(SELECT 1 FROM processed_mutations WHERE household_id=?1 AND member_id=?7 AND id=?8)`,
    actor.householdId, transfer.kind, transfer.fromCategoryId, transfer.toCategoryId,
    transfer.start, transfer.end, actor.memberId, action.id),
  ])
  const replay = previous.results[0] as Processed | undefined
  if (replay) {
    if (replay.digest !== digest) throw new ApiError(409, 'Идентификатор запроса уже использован.')
    return { response: json(JSON.parse(replay.response)) }
  }
  const current = state.results[0] as LimitState
  const record = current.kind === null ? null : toRecord(current)
  if ((record?.version ?? 0) !== action.expectedVersion) {
    throw new ApiError(409, 'Данные изменились на другом устройстве.', { record })
  }
  const records = (dependencies.results as StoredRecord[]).map(toRecord)
  const categories = records.flatMap(row => row.kind === 'category' && row.value ? [decodeCategory(row.value)] : [])
  const transfers = records.flatMap(row => row.kind === 'limitTransfer' && row.value ? [row.value] : [])
  const { settings } = JSON.parse(current.profile) as WireProfile
  if (!sameLimitPeriod(transfer, currentLimitPeriod(transfer.kind, now, settings))) {
    throw new ApiError(400, 'Перенос доступен только для текущего периода.')
  }
  const prior = record?.kind === 'limitTransfer' ? record.value ?? undefined : undefined
  if (record && !prior) throw new ApiError(400, 'Этот перенос удалён из истории при восстановлении бюджета.')
  const transactions = records.flatMap(row => {
    if (row.kind === 'transaction' && row.value) return [decodeTransaction(row.value)]
    if (row.kind === 'receipt' && row.value) return receiptOperations(row.value)
    return []
  })
  validateLimitChange(() => assertLimitTransferChange(transfer, prior, categories, transfers, transactions))
  return { cursor: current.cursor }
}

export async function mutate(db: D1Database, actor: Actor, input: unknown, now: number) {
  const action = parseMutation(input)
  if (action.kind === 'member' && action.key !== actor.memberId) throw new ApiError(403, 'Можно изменить только свой профиль.')
  const digest = await sha256(JSON.stringify(action))
  const { id, kind, key, expectedVersion, value } = action
  const stored = processed(db, actor, id)
  try {
    const validated = kind === 'limitTransfer' ? await prepareLimitChange(db, actor, action, digest, now) : undefined
    if (validated?.response) return validated.response
    const result = await db.batch<Processed>([
      assertActor(db, actor, now),
      assertResult(db,
        `COALESCE((SELECT digest=?4 FROM processed_mutations WHERE household_id=?1 AND member_id=?2 AND id=?3),1)`,
        `EXISTS(SELECT 1 FROM processed_mutations WHERE household_id=?1 AND member_id=?2 AND id=?3)
        OR (COALESCE((SELECT version FROM records WHERE household_id=?1 AND kind=?5 AND key=?6),0)=?7
          AND (?7>0 OR ?8=1) AND (?9 IS NULL OR (SELECT cursor FROM households WHERE id=?1)=?9))`,
        actor.householdId, actor.memberId, id, digest, kind, key, expectedVersion, value === null ? 0 : 1, validated?.cursor ?? null),
      ...assertCategoryAccess(db, actor, action),
      ...assertCategoryLimit(db, actor, action),
      writeEntity(db, actor, action, now),
      statement(db, `INSERT INTO processed_mutations(household_id,member_id,id,digest,response,created_at)
        SELECT ?1,?2,?3,?4,json_object('record',json_object('kind',r.kind,'key',r.key,'version',r.version,'value',json(r.value))),?5
        FROM records r WHERE r.household_id=?1 AND r.kind=?6 AND r.key=?7
        ON CONFLICT(household_id,member_id,id) DO NOTHING`, actor.householdId, actor.memberId, id, digest, now, kind, key),
      stored,
    ])
    return json(JSON.parse(result[result.length - 1].results[0].response))
  } catch (error) {
    const message = error instanceof Error ? error.message + ' ' + String(error.cause ?? '') : ''
    if (action.kind === 'receipt' && action.value?.fiscal && message.includes('receipt_fiscal_identity')) {
      return duplicateReceipt(db, actor, action.value.fiscal)
    }
    if (!message.includes('budget_conflict')) throw error
    const existing = await statement(db, `SELECT r.kind,r.key,r.version,r.value FROM households h
      LEFT JOIN records r ON r.household_id=h.id AND r.kind=? AND r.key=?
      WHERE h.id=? AND EXISTS(${validSession})`,
    kind, key, actor.householdId, ...actorBindings(actor, Date.now())).first<StoredRecord | EmptyRecord>()
    if (!existing) throw new ApiError(401, 'Сессия завершилась. Войдите снова.')
    throw new ApiError(409, 'Данные изменились на другом устройстве.', {
      record: existing.kind === null ? null : toRecord(existing),
    })
  }
}
