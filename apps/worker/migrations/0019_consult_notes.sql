-- 段M：相談の窓口（CA-081。docs/04 の 24）。先生が「残す」を押した答えだけを残す（CA-032 の改訂）。
-- text は、選別（C-1）を通した後の字。問いの文・前のやりとり・AI の答えそのもの・出典の本文は、持たない。
-- mode は、どちらの答えか（consult：書籍・ネットも踏まえた相談。record：記録だけからの答え）。
-- refs は、根拠の参照（記録の場所・書籍の題と頁・ネットの題と URL だけ。本文なし）。直す操作はない（消して、残し直す）。
CREATE TABLE IF NOT EXISTS consult_notes (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('consult', 'record')),
  text TEXT NOT NULL,
  refs TEXT NOT NULL,
  entered_at TEXT NOT NULL CHECK (length(entered_at) = 16)
);
CREATE INDEX IF NOT EXISTS consult_notes_by_patient ON consult_notes (patient_id, entered_at);
