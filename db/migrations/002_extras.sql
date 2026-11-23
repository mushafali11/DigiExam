ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE attempts ADD COLUMN IF NOT EXISTS extra_minutes INTEGER NOT NULL DEFAULT 0;

ALTER TABLE attempt_events ADD COLUMN IF NOT EXISTS detail TEXT;
ALTER TABLE attempt_events ADD COLUMN IF NOT EXISTS excused BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE attempt_events DROP CONSTRAINT IF EXISTS attempt_events_type_check;
ALTER TABLE attempt_events ADD CONSTRAINT attempt_events_type_check
  CHECK (type IN ('start', 'save', 'tab_switch', 'submit', 'auto_submit', 'extend', 'reopen'));