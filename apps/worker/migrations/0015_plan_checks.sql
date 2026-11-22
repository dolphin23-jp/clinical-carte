-- 段K9：予定と実施の突き合わせ（CA-058 の B2・CA-071。docs/04 の 21）。患者ごとに1つ。
-- body は、確かめた後の一覧の JSON（予定の行ごとの、記載の場所〔文の id と字の範囲〕・記録に書かれた行の字・#問題の見出し・日時・種類・予定の日〔AI の手がかりから決定論で計算〕・
-- 状態〔実施の記載あり・その後の記載に見つからない・振り分けられなかった〕・実施の記載の場所と短い名前・先生の印〔実施を確かめた・中止・不要・外した〕。
-- 「予定ではない」の数・理由ごとの出さなかった数・数と長さで落とした数）。AI に送った資料・AI の答えそのものは入れない。basis は、組み直すかを決める記録の印
CREATE TABLE IF NOT EXISTS plan_checks (
  patient_id TEXT PRIMARY KEY REFERENCES patients (id) ON DELETE CASCADE,
  made_at TEXT NOT NULL CHECK (length(made_at) = 16),
  prompt_version TEXT NOT NULL,
  basis TEXT NOT NULL,
  body TEXT NOT NULL
);

-- 先生が印を付けた記録（どの項目に、いつ、どの印から、どの印へ。打った文はない：印はボタンだけ）
CREATE TABLE IF NOT EXISTS plan_check_edits (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  at TEXT NOT NULL CHECK (length(at) = 16),
  item_key TEXT NOT NULL,
  before TEXT NOT NULL CHECK (before IN ('none', 'confirmed', 'cancelled', 'hidden')),
  after TEXT NOT NULL CHECK (after IN ('none', 'confirmed', 'cancelled', 'hidden'))
);
CREATE INDEX IF NOT EXISTS plan_check_edits_by_patient ON plan_check_edits (patient_id, at);
