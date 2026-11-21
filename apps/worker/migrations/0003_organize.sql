-- 段2：AI の整理（docs/04 の 3 と 6）。区切り・投薬・できごと・問題。どの行も、取り込んだ文（sources）のどこから来たかを持つ。
-- 整理し直すときは、その文の行を入れ替える（文そのものは変えない）。

-- 整理の状態：NULL（まだ）・done・failed。版は、整理に使った AI への指示の版。report は、確かめられなかった件数（種類と理由ごとの整数だけの JSON）
ALTER TABLE sources ADD COLUMN organized TEXT CHECK (organized IS NULL OR organized IN ('done', 'failed'));
ALTER TABLE sources ADD COLUMN organized_version TEXT;
ALTER TABLE sources ADD COLUMN organize_report TEXT;

-- 文の区切り：見出しと、文の中の範囲（文字は持たない。文から切り出して表示する）
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  span_start INTEGER NOT NULL,
  span_end INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS segments_by_source ON segments (source_id, span_start);

-- 投薬：名前と用量は、文の字のまま（数に分けない）。動きは、書かれたものだけ（書かれていなければ NULL）
CREATE TABLE IF NOT EXISTS medications (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  encounter_id TEXT NOT NULL REFERENCES encounters (id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dose_text TEXT,
  action TEXT CHECK (action IS NULL OR action IN ('start', 'change', 'stop', 'continue')),
  at TEXT CHECK (at IS NULL OR length(at) IN (10, 16)),
  span_start INTEGER NOT NULL,
  span_end INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('ai', 'self'))
);
CREATE INDEX IF NOT EXISTS medications_by_patient ON medications (patient_id, at);
CREATE INDEX IF NOT EXISTS medications_by_source ON medications (source_id);

-- できごと：処置・手術・検査の実施・コンサルト・転棟・急変・説明
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  encounter_id TEXT NOT NULL REFERENCES encounters (id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  at TEXT CHECK (at IS NULL OR length(at) IN (10, 16)),
  span_start INTEGER NOT NULL,
  span_end INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('ai', 'self'))
);
CREATE INDEX IF NOT EXISTS events_by_patient ON events (patient_id, at);
CREATE INDEX IF NOT EXISTS events_by_source ON events (source_id);

-- 問題：記載ごとに1行（書かれた名前と、書かれた確からしさ）。同じ問題をまとめるのは、見るときの計算（保存しない）
CREATE TABLE IF NOT EXISTS problems (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  encounter_id TEXT NOT NULL REFERENCES encounters (id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('problem', 'diagnosis', 'suspected', 'ruled_out')),
  at TEXT CHECK (at IS NULL OR length(at) IN (10, 16)),
  span_start INTEGER NOT NULL,
  span_end INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('ai', 'self'))
);
CREATE INDEX IF NOT EXISTS problems_by_patient ON problems (patient_id, at);
CREATE INDEX IF NOT EXISTS problems_by_source ON problems (source_id);
