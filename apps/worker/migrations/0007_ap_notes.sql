-- 段5：A/P（評価と方針）の記録（CA-030〜035。docs/04 の 12）。本人が書いた・AI の案から採用した、決まったことだけ（議論は保存しない）。
-- 文は、保存の前に選別（C-1）を通した後の字。根拠の参照（refs）は場所・題・頁・URL だけで、書籍やページの本文は持たない。

CREATE TABLE IF NOT EXISTS ap_notes (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  encounter_id TEXT NOT NULL REFERENCES encounters (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  day TEXT NOT NULL CHECK (length(day) = 10),
  part TEXT NOT NULL CHECK (part IN ('assessment', 'plan')),
  plan_kind TEXT CHECK (plan_kind IS NULL OR plan_kind IN ('dx', 'tx', 'ex', 'other')),
  text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('self', 'ai', 'ai_edited')),
  refs TEXT NOT NULL DEFAULT '[]',
  entered_at TEXT NOT NULL CHECK (length(entered_at) = 16),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 16)
);
CREATE INDEX IF NOT EXISTS ap_notes_by_encounter ON ap_notes (encounter_id, day);
CREATE INDEX IF NOT EXISTS ap_notes_by_patient ON ap_notes (patient_id);

-- A/P を足した・直した・消した記録：どの A/P を、いつ、どうしたか、誰の文になったか。文は持たない
CREATE TABLE IF NOT EXISTS ap_history (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  at TEXT NOT NULL CHECK (length(at) = 16),
  note_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add', 'edit', 'kind', 'delete')),
  origin TEXT CHECK (origin IS NULL OR origin IN ('self', 'ai', 'ai_edited'))
);
CREATE INDEX IF NOT EXISTS ap_history_by_patient ON ap_history (patient_id, at);
