-- 段K5：AI の臨床支援（CA-059・CA-064。docs/04 の 17）。患者ごとに1つ。
-- body は、確かめた後の支援の JSON（問題ごとの疑う疾患・確かめる検査の候補・ガイドラインとの照合・表にない基準の補い・補足。
-- 根拠は資料の短い名前、出典は題・頁・URL だけで、書籍・ページの本文は入れない。数の印〔※〕の場所。理由ごとの、出さなかった数）。
-- AI に送った資料・AI の答えそのものは入れない。basis は、組み直すかを決める記録の印（記録の印とプロブレムリストを組んだ日時）
CREATE TABLE IF NOT EXISTS clinical_support (
  patient_id TEXT PRIMARY KEY REFERENCES patients (id) ON DELETE CASCADE,
  made_at TEXT NOT NULL CHECK (length(made_at) = 16),
  prompt_version TEXT NOT NULL,
  basis TEXT NOT NULL,
  body TEXT NOT NULL
);
