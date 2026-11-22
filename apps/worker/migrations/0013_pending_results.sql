-- 段K6：結果待ちを追う（CA-058 の A3・CA-065。docs/04 の 18）。患者ごとに1つ。
-- body は、確かめた後の一覧の JSON（提出の候補ごとの、種類・記載の場所〔文の id と字の範囲〕・記録に書かれた名前・日時・状態〔結果待ち・結果の記載がある・振り分けられなかった〕・
-- 結果の記載の場所と短い名前・先生の印〔結果を確かめた・外した〕。「提出ではない」の数・理由ごとの出さなかった数・長さで落とした数）。
-- AI に送った資料・AI の答えそのものは入れない。basis は、組み直すかを決める記録の印（プロブレムリストと同じ）
CREATE TABLE IF NOT EXISTS pending_results (
  patient_id TEXT PRIMARY KEY REFERENCES patients (id) ON DELETE CASCADE,
  made_at TEXT NOT NULL CHECK (length(made_at) = 16),
  prompt_version TEXT NOT NULL,
  basis TEXT NOT NULL,
  body TEXT NOT NULL
);

-- 先生が印を付けた記録（どの項目に、いつ、どの印から、どの印へ。打った文はない：印はボタンだけ）
CREATE TABLE IF NOT EXISTS pending_result_edits (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  at TEXT NOT NULL CHECK (length(at) = 16),
  item_key TEXT NOT NULL,
  before TEXT NOT NULL CHECK (before IN ('none', 'checked', 'hidden')),
  after TEXT NOT NULL CHECK (after IN ('none', 'checked', 'hidden'))
);
CREATE INDEX IF NOT EXISTS pending_result_edits_by_patient ON pending_result_edits (patient_id, at);
