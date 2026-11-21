-- 段3e：問題以外の事実（投薬・できごと・測定値）を、本人が直す（docs/04 の 10）。
-- 直せるのは、外す・戻すと、選ぶだけの直し（投薬の動き・できごとの種類・日時）。打つ欄はない（打った文は選別を通す決まり。docs/01 の 2）。

-- 外した印（0：使う・1：本人が外した）。外した行は消さず、見方から除く（戻せる）
ALTER TABLE medications ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1));
ALTER TABLE events ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1));
ALTER TABLE observations ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1));

-- 事実を直した記録：どの表のどの行の、どの欄を、前と後（選んだ値・日時・印だけ。文は入らない）。日時は日本の日時
CREATE TABLE IF NOT EXISTS fact_edits (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  at TEXT NOT NULL CHECK (length(at) = 16),
  fact TEXT NOT NULL CHECK (fact IN ('medication', 'event', 'observation')),
  target TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('excluded', 'action', 'kind', 'at')),
  before TEXT,
  after TEXT
);
CREATE INDEX IF NOT EXISTS fact_edits_by_patient ON fact_edits (patient_id, at);
