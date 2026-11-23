-- 段K11：指示簿（CA-074〜CA-079。docs/04 の 23）。
-- order_sheets：受診ごとに1つ。items は項目の JSON（欄・字〔写した字は保存した文の字のまま、ほかは選別を通した後の字〕・動き・開始と予定の終わり〔先生が入れたときだけ〕・
-- スケール〔入れたときのテンプレの中身・先生が入れた体重・いまの段〕・誰が入れたか・元の字の場所・AI の案の根拠の短い名前・資料に見つからなかった数〔※〕・状態・日時・直した記録）。
-- AI に送った資料・AI の答えそのものは入れない
CREATE TABLE IF NOT EXISTS order_sheets (
  encounter_id TEXT PRIMARY KEY REFERENCES encounters (id) ON DELETE CASCADE,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  items TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 16)
);
CREATE INDEX IF NOT EXISTS order_sheets_by_patient ON order_sheets (patient_id);

-- 先生が指示簿を直した記録（どの項目を、いつ、何をしたか・誰が入れた項目か。文は入らない）
CREATE TABLE IF NOT EXISTS order_edits (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  encounter_id TEXT NOT NULL,
  at TEXT NOT NULL CHECK (length(at) = 16),
  item_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add', 'edit', 'stop', 'restart', 'scale', 'delete')),
  origin TEXT NOT NULL CHECK (origin IN ('self', 'ai', 'transcribed'))
);
CREATE INDEX IF NOT EXISTS order_edits_by_patient ON order_edits (patient_id, at);

-- スケールのテンプレ（CA-075）：患者に付かない（patient_id の列はない）。先生の施設の内容（名前・薬・濃度・投与量の単位・段・注）の JSON。
-- 患者の情報は書かない決まり（字は識別情報の形の検査を通す）。外すときは、行を消さず removed_at を入れる
CREATE TABLE IF NOT EXISTS order_templates (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) = 16),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 16),
  removed_at TEXT CHECK (removed_at IS NULL OR length(removed_at) = 16)
);
