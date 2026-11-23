-- 段K10：Casebook へ送る（CA-058 の B1・CA-073。docs/04 の 22）。受診ごとに1つ。パケットはクリップボードに載せるだけで、Casebook へは何も送らない（通信しない）。
-- seed は項目の ID の元（英小文字 10 字。乱数から。患者の情報ではない）。case_code は、Casebook が新しい症例を取り込んだときに出した症例コード（先生が打つ。6 字）。
-- sent は、Casebook が取り込んだと先生が押した項目の印の JSON（{ 項目の鍵: { h: 送った中身の印〔英小文字 8 字〕, r: 改訂 } }。鍵は記録の id と決まった字だけ）。
-- packets は、取り込んだと押したパケットの数。文・日付・時刻は入れない
CREATE TABLE IF NOT EXISTS casebook_links (
  encounter_id TEXT PRIMARY KEY REFERENCES encounters (id) ON DELETE CASCADE,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  seed TEXT NOT NULL CHECK (length(seed) = 10),
  case_code TEXT CHECK (case_code IS NULL OR length(case_code) = 6),
  sent TEXT NOT NULL,
  packets INTEGER NOT NULL CHECK (packets >= 0)
);
CREATE INDEX IF NOT EXISTS casebook_links_by_patient ON casebook_links (patient_id);
