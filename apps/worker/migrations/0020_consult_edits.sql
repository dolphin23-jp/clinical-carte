-- 段M2：残した相談の答えを直す（CA-083。docs/04 の 24）。直す字は、選別（C-1）を通した後の字で置き換える（前の字は残さない）。
-- edited は、残した後に先生が直したか（「先生が直した」の印）。updated_at は、直した日時（直していなければ NULL）。
-- consult_note_history は、残した・直した・消した記録（どの答えに何をしたかと、どちらの答えかだけ。文は持たない）。
ALTER TABLE consult_notes ADD COLUMN edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1));
ALTER TABLE consult_notes ADD COLUMN updated_at TEXT CHECK (updated_at IS NULL OR length(updated_at) = 16);
CREATE TABLE IF NOT EXISTS consult_note_history (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  at TEXT NOT NULL CHECK (length(at) = 16),
  note_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add', 'edit', 'delete')),
  mode TEXT NOT NULL CHECK (mode IN ('consult', 'record'))
);
CREATE INDEX IF NOT EXISTS consult_note_history_by_patient ON consult_note_history (patient_id, at);
