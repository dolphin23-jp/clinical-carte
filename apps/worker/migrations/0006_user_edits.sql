-- 本人の調節（CA-029。docs/04 の 11）：問題の筋の本人の決め（確からしさ・状態・並び・外す・打って直した名前）、
-- 本人が足した・直した区切り、ほかの直しの記録。

-- 問題の筋：本人が決めた確からしさ（NULL：書かれたとおり）、状態（active：いまの問題・resolved・inactive。NULL：書かれたとおり）、
-- 並び（NULL：最初の記載の順）、外した印、打って直した名前（選別を通した後の字）
ALTER TABLE problem_threads ADD COLUMN status_override TEXT CHECK (status_override IS NULL OR status_override IN ('problem', 'diagnosis', 'suspected', 'ruled_out'));
ALTER TABLE problem_threads ADD COLUMN activity_override TEXT CHECK (activity_override IS NULL OR activity_override IN ('active', 'resolved', 'inactive'));
ALTER TABLE problem_threads ADD COLUMN ord INTEGER;
ALTER TABLE problem_threads ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1));
ALTER TABLE problem_threads ADD COLUMN typed_name TEXT;

-- 区切り：本人が足した・見出しを直した区切りは self（整理し直しでも残す）
ALTER TABLE segments ADD COLUMN origin TEXT NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai', 'self'));

-- 本人の調節の記録（fact_edits・history に入らない分）：何の、どの行の、どの欄を、前と後（選んだ値・日時・名前だけ）。
-- 文を直したときは、前後の文を残さない（before・after は NULL）
CREATE TABLE IF NOT EXISTS user_edits (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  at TEXT NOT NULL CHECK (length(at) = 16),
  target_type TEXT NOT NULL CHECK (target_type IN ('source', 'segment', 'thread', 'problem', 'medication', 'event', 'observation')),
  target TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('kind', 'at', 'author_role', 'label', 'status', 'activity', 'ord', 'excluded', 'unmerge', 'typed_name', 'name', 'text', 'added')),
  before TEXT,
  after TEXT
);
CREATE INDEX IF NOT EXISTS user_edits_by_patient ON user_edits (patient_id, at);
