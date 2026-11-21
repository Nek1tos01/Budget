-- Keep the recorded total as the budget amount for receipts without saved rounding.
DROP VIEW record_category_refs;

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

DROP TRIGGER records_insert;
DROP TRIGGER records_update;

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
