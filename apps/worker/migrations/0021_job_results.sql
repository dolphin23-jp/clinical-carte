-- 段N2：通信から切り離した AI の仕事（CA-087）の答えを、受け取るまで預かる（CA-088。docs/04 の 25）。
-- body は、保存しない答えの種類（相談・記録に聞く・記載を出す・AI に頼む・指示簿の写しと案）の、確かめた後の答えだけ。保存する種類は {}。誤りは名前だけ。
-- 問い・頼みの字は入れない（サーバーのメモリにだけ渡す）。受け取ったら消す・預かる時間を過ぎたら消す・患者を消すと消える。
CREATE TABLE IF NOT EXISTS job_results (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('organize', 'problem_list', 'support', 'pending', 'plans', 'consult', 'ask', 'document', 'revise', 'order_transcribe', 'order_propose')),
  target TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  made_at TEXT NOT NULL CHECK (length(made_at) = 16)
);
CREATE INDEX IF NOT EXISTS job_results_by_patient ON job_results (patient_id, made_at);
