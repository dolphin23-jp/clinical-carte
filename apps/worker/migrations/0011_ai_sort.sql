-- 段J：AI による振り分け（CA-056・CA-057。docs/04 の 16）。
-- (1) 事実の日時が「おおよそ」のときの印（「夕方ごろ」「11/15〜11/17ごろ」）。AI の手がかりから、決定論で計算した日時に付く
ALTER TABLE medications ADD COLUMN at_approx TEXT;
ALTER TABLE events ADD COLUMN at_approx TEXT;
ALTER TABLE observations ADD COLUMN at_approx TEXT;
-- (2) 測定値を誰が読んだか（rule：字を決定論で読んだ・ai：AI が読んだ項目と値）と、AI の数が書かれた場所の字に見つからない印
ALTER TABLE observations ADD COLUMN read_by TEXT NOT NULL DEFAULT 'rule' CHECK (read_by IN ('rule', 'ai'));
ALTER TABLE observations ADD COLUMN unseen INTEGER NOT NULL DEFAULT 0 CHECK (unseen IN (0, 1));

-- (3) 経過の出来事：病歴・経過の文に書かれた「いつ・何があったか」。引用の場所と、AI の短い要約（80 字まで。数は引用にあるものだけ）。
-- 文から作る行（整理し直すと入れ替わる・文を消すと消える）
CREATE TABLE IF NOT EXISTS course_items (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  encounter_id TEXT NOT NULL REFERENCES encounters (id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  at TEXT CHECK (at IS NULL OR length(at) IN (10, 16)),
  at_approx TEXT,
  category TEXT NOT NULL CHECK (category IN ('onset', 'change', 'intake', 'visit', 'test', 'treatment', 'finding', 'other')),
  summary TEXT NOT NULL,
  span_start INTEGER NOT NULL,
  span_end INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai', 'self'))
);
CREATE INDEX IF NOT EXISTS course_items_by_patient ON course_items (patient_id, at);
CREATE INDEX IF NOT EXISTS course_items_by_source ON course_items (source_id);

-- (4) AI のプロブレムリスト（患者ごとに1つ）。items は項目の JSON（名前・確からしさ・状態・結びつけた筋と出来事の場所・根拠の短い文・始まった日・先生の直しの印）
CREATE TABLE IF NOT EXISTS problem_lists (
  patient_id TEXT PRIMARY KEY REFERENCES patients (id) ON DELETE CASCADE,
  made_at TEXT NOT NULL CHECK (length(made_at) = 16),
  prompt_version TEXT NOT NULL,
  basis TEXT NOT NULL,
  items TEXT NOT NULL
);

-- (5) 先生がプロブレムリストを直した記録（どの項目の、どの欄を、いつ。名前の前後は、選別を通した後の字）
CREATE TABLE IF NOT EXISTS problem_list_edits (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  at TEXT NOT NULL CHECK (length(at) = 16),
  item_key TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('name', 'certainty', 'activity', 'hidden', 'move')),
  before TEXT,
  after TEXT
);
CREATE INDEX IF NOT EXISTS problem_list_edits_by_patient ON problem_list_edits (patient_id, at);
