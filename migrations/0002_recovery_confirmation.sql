ALTER TABLE recovery_credentials ADD COLUMN confirmed_session_hash TEXT;

CREATE TABLE pending_recoveries (
  household_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  session_token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, member_id),
  FOREIGN KEY (household_id, member_id) REFERENCES members(household_id, id)
) STRICT;

CREATE INDEX pending_recoveries_expiry ON pending_recoveries(expires_at);

CREATE TRIGGER deactivate_pending_recovery AFTER UPDATE OF active ON members WHEN NEW.active = 0 BEGIN
  DELETE FROM pending_recoveries WHERE household_id = NEW.household_id AND member_id = NEW.id;
END;
