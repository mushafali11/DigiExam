-- Flag a question for review (student side)
ALTER TABLE attempt_questions ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT FALSE;