-- 段I：カルテ記載（CA-054。docs/04 の 15）。救急外来記録・外来初診・外来再診・入院時記録・プログレスノート・中間サマリー・退院サマリーを、
-- 本人が「保存する」を押したものだけ残す。中身は見出しごとの文（選別 C-1 を通した後の字）と、根拠の参照（場所・題・頁・URL だけ。本文なし）。
-- 相談のやりとり（問い・答え）は保存しない（CA-032 のまま）。

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  encounter_id TEXT NOT NULL REFERENCES encounters (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('er_record', 'outpatient_first', 'outpatient_revisit', 'admission', 'progress', 'interim_summary', 'discharge_summary')),
  day TEXT NOT NULL CHECK (length(day) = 10),
  sections TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('self', 'ai', 'ai_edited')),
  entered_at TEXT NOT NULL CHECK (length(entered_at) = 16),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 16)
);
CREATE INDEX IF NOT EXISTS documents_by_encounter ON documents (encounter_id, day);
CREATE INDEX IF NOT EXISTS documents_by_patient ON documents (patient_id);

-- 記載を残した・直した・消した記録：どの記載を、いつ、どうしたか、誰の文になったか。文は持たない
CREATE TABLE IF NOT EXISTS document_history (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  at TEXT NOT NULL CHECK (length(at) = 16),
  document_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add', 'edit', 'delete')),
  origin TEXT CHECK (origin IS NULL OR origin IN ('self', 'ai', 'ai_edited'))
);
CREATE INDEX IF NOT EXISTS document_history_by_patient ON document_history (patient_id, at);
