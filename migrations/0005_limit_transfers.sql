-- Rebuild the kind constraint without replaying any record, revision or turnover trigger.
DROP VIEW record_category_refs;
DROP TRIGGER member_insert;
DROP TRIGGER member_update;

CREATE TABLE records_next (
  household_id TEXT NOT NULL REFERENCES households(id),
  kind TEXT NOT NULL CHECK (kind IN ('profile', 'category', 'transaction', 'member', 'receipt', 'receiptRule', 'limitTransfer')),
  key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  value TEXT CHECK (value IS NULL OR json_valid(value)),
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, kind, key)
) STRICT;

INSERT INTO records_next(household_id, kind, key, version, value, revision, created_at, updated_at)
  SELECT household_id, kind, key, version, value, revision, created_at, updated_at FROM records;
DROP TABLE records;
ALTER TABLE records_next RENAME TO records;

CREATE INDEX records_revision ON records(household_id, revision);
CREATE INDEX transaction_category ON records(household_id, json_extract(value, '$.categoryId'))
  WHERE kind = 'transaction' AND value IS NOT NULL;

CREATE UNIQUE INDEX receipt_fiscal_identity ON records(
  household_id,
  json_extract(value, '$.fiscal.fn'),
  json_extract(value, '$.fiscal.i'),
  json_extract(value, '$.fiscal.fp'),
  json_extract(value, '$.fiscal.n')
) WHERE kind = 'receipt' AND value IS NOT NULL AND json_extract(value, '$.fiscal.fn') IS NOT NULL;

CREATE VIEW record_category_refs AS
  SELECT household_id, kind, key, json_extract(value, '$.categoryId') AS category_id
    FROM records WHERE kind IN ('transaction', 'receipt', 'receiptRule') AND value IS NOT NULL
  UNION ALL
  SELECT household_id, kind, key, json_extract(value, '$.adjustmentCategoryId')
    FROM records WHERE kind = 'receipt' AND value IS NOT NULL
  UNION ALL
  SELECT household_id, kind, key, json_extract(value, '$.roundingCategoryId')
    FROM records WHERE kind = 'receipt' AND value IS NOT NULL
  UNION ALL
  SELECT record.household_id, record.kind, record.key, json_extract(item.value, '$.categoryId')
    FROM records record, json_each(record.value, '$.items') item
    WHERE record.kind = 'receipt' AND record.value IS NOT NULL;

CREATE TRIGGER records_insert AFTER INSERT ON records BEGIN
  UPDATE households SET
    cursor = cursor + 1,
    total_minor = total_minor + COALESCE(CASE NEW.kind
      WHEN 'transaction' THEN CAST(json_extract(NEW.value, '$.amount') AS INTEGER)
      WHEN 'receipt' THEN COALESCE(json_extract(NEW.value, '$.budgetAmount'), json_extract(NEW.value, '$.total')) END, 0)
    WHERE id = NEW.household_id;
  UPDATE records SET revision = (SELECT cursor FROM households WHERE id = NEW.household_id)
    WHERE household_id = NEW.household_id AND kind = NEW.kind AND key = NEW.key;
END;

CREATE TRIGGER records_update AFTER UPDATE OF version ON records BEGIN
  UPDATE households SET
    cursor = cursor + 1,
    total_minor = total_minor + (COALESCE(CASE NEW.kind
      WHEN 'transaction' THEN CAST(json_extract(NEW.value, '$.amount') AS INTEGER)
      WHEN 'receipt' THEN COALESCE(json_extract(NEW.value, '$.budgetAmount'), json_extract(NEW.value, '$.total')) END, 0) - COALESCE(CASE OLD.kind
      WHEN 'transaction' THEN CAST(json_extract(OLD.value, '$.amount') AS INTEGER)
      WHEN 'receipt' THEN COALESCE(json_extract(OLD.value, '$.budgetAmount'), json_extract(OLD.value, '$.total')) END, 0))
    WHERE id = NEW.household_id;
  UPDATE records SET revision = (SELECT cursor FROM households WHERE id = NEW.household_id)
    WHERE household_id = NEW.household_id AND kind = NEW.kind AND key = NEW.key;
END;

CREATE TRIGGER member_insert AFTER INSERT ON members BEGIN
  INSERT INTO records(household_id, kind, key, version, value, created_at, updated_at)
    VALUES (NEW.household_id, 'member', NEW.id, 1,
      json_object('id', NEW.id, 'name', NEW.name, 'color', NEW.color, 'role', NEW.role,
        'active', json(iif(NEW.active, 'true', 'false')), 'placeholder', json(iif(NEW.placeholder, 'true', 'false'))),
      NEW.created_at, NEW.updated_at);
END;

CREATE TRIGGER member_update AFTER UPDATE ON members BEGIN
  UPDATE records SET version = version + 1, updated_at = NEW.updated_at,
    value = json_object('id', NEW.id, 'name', NEW.name, 'color', NEW.color, 'role', NEW.role,
      'active', json(iif(NEW.active, 'true', 'false')), 'placeholder', json(iif(NEW.placeholder, 'true', 'false')))
    WHERE household_id = NEW.household_id AND kind = 'member' AND key = NEW.id;
  DELETE FROM sessions WHERE household_id = NEW.household_id AND member_id = NEW.id AND NEW.active = 0;
  DELETE FROM recovery_credentials WHERE household_id = NEW.household_id AND member_id = NEW.id AND NEW.active = 0;
END;

CREATE TRIGGER transaction_insert BEFORE INSERT ON records WHEN NEW.kind IN ('transaction', 'receipt') AND NEW.value IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM members WHERE household_id = NEW.household_id AND id = json_extract(NEW.value, '$.memberId')
    ) OR NOT EXISTS (
    SELECT 1 FROM members WHERE household_id = NEW.household_id AND id = json_extract(NEW.value, '$.authorId')
    ) THEN RAISE(ABORT, 'budget_reference') END;
  SELECT CASE WHEN json_extract(NEW.value, '$.type') = 'expense' AND NOT EXISTS (
    SELECT 1 FROM records WHERE household_id = NEW.household_id AND kind = 'category'
      AND key = json_extract(NEW.value, '$.categoryId') AND value IS NOT NULL
    ) THEN RAISE(ABORT, 'budget_reference') END;
END;

CREATE TRIGGER transaction_update BEFORE UPDATE OF value ON records WHEN NEW.kind IN ('transaction', 'receipt') AND NEW.value IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM members WHERE household_id = NEW.household_id AND id = json_extract(NEW.value, '$.memberId')
    ) OR NOT EXISTS (
    SELECT 1 FROM members WHERE household_id = NEW.household_id AND id = json_extract(NEW.value, '$.authorId')
    ) THEN RAISE(ABORT, 'budget_reference') END;
  SELECT CASE WHEN json_extract(NEW.value, '$.type') = 'expense' AND NOT EXISTS (
    SELECT 1 FROM records WHERE household_id = NEW.household_id AND kind = 'category'
      AND key = json_extract(NEW.value, '$.categoryId') AND value IS NOT NULL
    ) THEN RAISE(ABORT, 'budget_reference') END;
END;

CREATE TRIGGER receipt_fiscal_update BEFORE UPDATE OF value ON records
  WHEN OLD.kind = 'receipt' AND NEW.value IS NOT NULL AND json_extract(OLD.value, '$.fiscal.fn') IS NOT NULL BEGIN
  SELECT CASE WHEN
    json_extract(NEW.value, '$.fiscal.fn') IS NOT json_extract(OLD.value, '$.fiscal.fn') OR
    json_extract(NEW.value, '$.fiscal.i') IS NOT json_extract(OLD.value, '$.fiscal.i') OR
    json_extract(NEW.value, '$.fiscal.fp') IS NOT json_extract(OLD.value, '$.fiscal.fp') OR
    json_extract(NEW.value, '$.fiscal.n') IS NOT json_extract(OLD.value, '$.fiscal.n') OR
    json_extract(NEW.value, '$.fiscal.date') IS NOT json_extract(OLD.value, '$.fiscal.date') OR
    json_extract(NEW.value, '$.fiscal.time') IS NOT json_extract(OLD.value, '$.fiscal.time') OR
    json_extract(NEW.value, '$.fiscal.total') IS NOT json_extract(OLD.value, '$.fiscal.total')
  THEN RAISE(ABORT, 'budget_fiscal_immutable') END;
END;

CREATE TRIGGER category_tombstone BEFORE UPDATE OF value ON records WHEN NEW.kind = 'category' AND NEW.value IS NULL BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM record_category_refs WHERE household_id = NEW.household_id AND category_id = NEW.key
    ) OR EXISTS (
    SELECT 1 FROM records WHERE household_id = NEW.household_id AND kind = 'limitTransfer' AND value IS NOT NULL
      AND NEW.key IN (json_extract(value, '$.fromCategoryId'), json_extract(value, '$.toCategoryId'))
    ) THEN RAISE(ABORT, 'budget_reference') END;
END;
