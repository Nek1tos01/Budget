CREATE TABLE households (
  id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  total_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_minor BETWEEN 0 AND 9007199254740991),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE members (
  household_id TEXT NOT NULL REFERENCES households(id),
  id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  placeholder INTEGER NOT NULL CHECK (placeholder IN (0, 1)),
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (role != 'owner' OR (active = 1 AND placeholder = 0)),
  CHECK (placeholder = 0 OR active = 0),
  PRIMARY KEY (household_id, id)
) STRICT;

CREATE UNIQUE INDEX one_active_member_per_role ON members(household_id, role) WHERE active = 1;
CREATE UNIQUE INDEX one_placeholder ON members(household_id) WHERE placeholder = 1;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (household_id, member_id) REFERENCES members(household_id, id)
) STRICT;

CREATE INDEX sessions_member ON sessions(household_id, member_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE recovery_credentials (
  code_hash TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (household_id, member_id) REFERENCES members(household_id, id),
  UNIQUE (household_id, member_id)
) STRICT;

CREATE TABLE invitations (
  token_hash TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumption_nonce TEXT,
  consumed_member_id TEXT,
  FOREIGN KEY (household_id, consumed_member_id) REFERENCES members(household_id, id)
) STRICT;

CREATE INDEX invitations_household ON invitations(household_id);
CREATE INDEX invitations_expiry ON invitations(expires_at);

-- Current entity state and compact change index. A deletion keeps its version.
CREATE TABLE records (
  household_id TEXT NOT NULL REFERENCES households(id),
  kind TEXT NOT NULL CHECK (kind IN ('profile', 'category', 'transaction', 'member')),
  key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  value TEXT CHECK (value IS NULL OR json_valid(value)),
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, kind, key)
) STRICT;

CREATE INDEX records_revision ON records(household_id, revision);
CREATE INDEX transaction_category ON records(household_id, json_extract(value, '$.categoryId'))
  WHERE kind = 'transaction' AND value IS NOT NULL;

CREATE TABLE processed_mutations (
  household_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  id TEXT NOT NULL,
  digest TEXT NOT NULL,
  response TEXT NOT NULL CHECK (json_valid(response)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (household_id, member_id) REFERENCES members(household_id, id),
  PRIMARY KEY (household_id, member_id, id)
) STRICT;

CREATE TABLE rate_limits (
  scope TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (scope, window_start)
) STRICT;

CREATE INDEX rate_limits_expiry ON rate_limits(window_start);

-- Assertions and writes in a D1 batch share the same transaction. The table stays empty.
CREATE TABLE operation_assertions (
  authorized INTEGER NOT NULL,
  matching_digest INTEGER NOT NULL,
  matching_version INTEGER NOT NULL,
  valid_reference INTEGER NOT NULL
) STRICT;

CREATE TRIGGER assert_operation BEFORE INSERT ON operation_assertions BEGIN
  SELECT CASE WHEN NEW.authorized != 1 THEN RAISE(ABORT, 'budget_unauthorized') END;
  SELECT CASE WHEN NEW.matching_digest != 1 THEN RAISE(ABORT, 'budget_id_reused') END;
  SELECT CASE WHEN NEW.matching_version != 1 THEN RAISE(ABORT, 'budget_conflict') END;
  SELECT CASE WHEN NEW.valid_reference != 1 THEN RAISE(ABORT, 'budget_reference') END;
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER records_insert AFTER INSERT ON records BEGIN
  UPDATE households SET
    cursor = cursor + 1,
    total_minor = total_minor + CASE WHEN NEW.kind = 'transaction'
      THEN COALESCE(CAST(json_extract(NEW.value, '$.amount') AS INTEGER), 0) ELSE 0 END
    WHERE id = NEW.household_id;
  UPDATE records SET revision = (SELECT cursor FROM households WHERE id = NEW.household_id)
    WHERE household_id = NEW.household_id AND kind = NEW.kind AND key = NEW.key;
END;

CREATE TRIGGER records_update AFTER UPDATE OF version ON records BEGIN
  UPDATE households SET
    cursor = cursor + 1,
    total_minor = total_minor + CASE WHEN NEW.kind = 'transaction'
      THEN COALESCE(CAST(json_extract(NEW.value, '$.amount') AS INTEGER), 0) -
           COALESCE(CAST(json_extract(OLD.value, '$.amount') AS INTEGER), 0) ELSE 0 END
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

CREATE TRIGGER transaction_insert BEFORE INSERT ON records WHEN NEW.kind = 'transaction' AND NEW.value IS NOT NULL BEGIN
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

CREATE TRIGGER transaction_update BEFORE UPDATE OF value ON records WHEN NEW.kind = 'transaction' AND NEW.value IS NOT NULL BEGIN
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

CREATE TRIGGER category_tombstone BEFORE UPDATE OF value ON records WHEN NEW.kind = 'category' AND NEW.value IS NULL BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM records WHERE household_id = NEW.household_id AND kind = 'transaction' AND value IS NOT NULL
      AND json_extract(value, '$.categoryId') = NEW.key
    ) THEN RAISE(ABORT, 'budget_reference') END;
END;
