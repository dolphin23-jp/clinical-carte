-- 段K9：電波のないときの入力（CA-058 の B4・CA-072。docs/04 の 21）。文の送る鍵（画面が送るボタンを押したときに作る ULID。患者の情報ではない）。
-- 同じ受診に同じ鍵の文があれば、サーバーは保存し直さずに、その文を返す（答えが戻らずに送り直しても、二重に保存しない）。鍵のない文（これまでの文）は NULL
ALTER TABLE sources ADD COLUMN send_key TEXT CHECK (send_key IS NULL OR length(send_key) = 26);
CREATE UNIQUE INDEX IF NOT EXISTS sources_send_key ON sources (encounter_id, send_key);
