-- 段1：患者・受診・取り込んだ文・測定値と、AI を呼んだ回数。docs/04 の 3 と 6（書き込みの一覧）。
-- 氏名・ID・生年月日・呼び名・病室の列は、ない（CA-003・CA-014）。日時は、日本の時刻の文字（YYYY-MM-DD か YYYY-MM-DDTHH:mm）。

CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  age INTEGER NOT NULL CHECK (age BETWEEN 0 AND 130),
  age_on TEXT NOT NULL CHECK (length(age_on) = 10),
  sex TEXT NOT NULL CHECK (sex IN ('male', 'female', 'other')),
  created_on TEXT NOT NULL CHECK (length(created_on) = 10)
);

CREATE TABLE IF NOT EXISTS encounters (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('er', 'outpatient', 'inpatient')),
  started TEXT NOT NULL CHECK (length(started) IN (10, 16)),
  ended TEXT CHECK (ended IS NULL OR length(ended) IN (10, 16))
);
CREATE INDEX IF NOT EXISTS encounters_by_patient ON encounters (patient_id, started);

-- 取り込んだ文：識別情報の場所を置き換えた後の文だけ（docs/01 の 2）。打った原文は、どこにも置かない。
-- replaced は、置き換えた種類ごとの件数（整数だけの JSON）。
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  encounter_id TEXT NOT NULL REFERENCES encounters (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  author_role TEXT NOT NULL,
  at TEXT CHECK (at IS NULL OR length(at) IN (10, 16)),
  entered_at TEXT NOT NULL CHECK (length(entered_at) = 16),
  text TEXT NOT NULL,
  replaced TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sources_by_patient ON sources (patient_id, at);

-- 測定値（バイタル・検査）：書かれたとおりに持つ。基準範囲・判定の列は、ない。
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  encounter_id TEXT NOT NULL REFERENCES encounters (id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  at TEXT CHECK (at IS NULL OR length(at) IN (10, 16)),
  name TEXT,
  name_raw TEXT NOT NULL,
  kind TEXT CHECK (kind IS NULL OR kind IN ('lab', 'vital')),
  value REAL,
  comparator TEXT CHECK (comparator IS NULL OR comparator IN ('<', '>', '<=', '>=')),
  value_text TEXT NOT NULL,
  unit TEXT,
  span_start INTEGER NOT NULL,
  span_end INTEGER NOT NULL,
  -- 文の中での順（書かれた順に並べるため。血圧の2つの値は、同じ場所から読む）
  ord INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('parser', 'ai', 'self'))
);
CREATE INDEX IF NOT EXISTS observations_by_patient ON observations (patient_id, at);
CREATE INDEX IF NOT EXISTS observations_by_source ON observations (source_id);

-- AI を呼んだ回数（日ごと）。日付と整数だけ（CA-022）。
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT PRIMARY KEY CHECK (length(day) = 10),
  calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0)
);
