-- 段K7：申し送り（CA-058 の A5・CA-067。docs/04 の 19）。I-PASS の形。本人が「保存する」を押したものだけ残す。
-- severity は、先生が選んだ重症度（安定・要注意・不安定）。AI は書かない（既定の値もない）。
-- sections は、見出しごとの文（患者の要約・やること・起こりうることと対応。選別 C-1 を通した後の字）と、根拠の参照（場所・題・頁・URL だけ。本文なし）。
-- 受け手の確認は、画面のメモリだけで、残さない。残した・直した・消した記録は、カルテ記載と同じ document_history（文は持たない）。
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  encounter_id TEXT NOT NULL REFERENCES encounters (id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (length(day) = 10),
  severity TEXT NOT NULL CHECK (severity IN ('stable', 'watcher', 'unstable')),
  sections TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('self', 'ai', 'ai_edited')),
  entered_at TEXT NOT NULL CHECK (length(entered_at) = 16),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 16)
);
CREATE INDEX IF NOT EXISTS handoffs_by_encounter ON handoffs (encounter_id, day);
CREATE INDEX IF NOT EXISTS handoffs_by_patient ON handoffs (patient_id, day);
