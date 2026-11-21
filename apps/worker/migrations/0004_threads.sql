-- 段3a：問題の筋（docs/04 の 9。CA-024・CA-025）。
-- 記載ごとの問題（problems）を、患者ごとの「問題の筋」につなぐ。筋の表は、文の字を持たない（表示の名前だけは、書かれた名前から本人が選んだもの）。

-- 問題の筋：id は使い回さない。統合した筋は消さず、統合先を持つ
CREATE TABLE IF NOT EXISTS problem_threads (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  display_name TEXT,
  merged_into TEXT
);
CREATE INDEX IF NOT EXISTS problem_threads_by_patient ON problem_threads (patient_id);

-- 記載ごとの問題に、筋と、つないだ方法（rule：名前が同じ・ai：AI が指した・self：本人が直した）と、書かれた活動の状態（解決・非活動。書かれていなければ NULL）
ALTER TABLE problems ADD COLUMN thread_id TEXT;
ALTER TABLE problems ADD COLUMN thread_origin TEXT CHECK (thread_origin IS NULL OR thread_origin IN ('rule', 'ai', 'self'));
ALTER TABLE problems ADD COLUMN activity TEXT CHECK (activity IS NULL OR activity IN ('resolved', 'inactive'));
CREATE INDEX IF NOT EXISTS problems_by_thread ON problems (thread_id);

-- 本人が直した記録：何を（行の id）、どう（移す・統合・名前）、前と後（筋の id か、選んだ名前）。日時は日本の日時
CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  at TEXT NOT NULL CHECK (length(at) = 16),
  action TEXT NOT NULL CHECK (action IN ('move', 'merge', 'name')),
  target TEXT NOT NULL,
  before TEXT,
  after TEXT
);
CREATE INDEX IF NOT EXISTS history_by_patient ON history (patient_id, at);
