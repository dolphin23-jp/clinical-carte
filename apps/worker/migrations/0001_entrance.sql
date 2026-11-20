-- 入口（CA-016・CA-019）。docs/04 の 3.8 と 6（書き込みの一覧）。
-- 端末の印：合鍵そのもの・端末の秘密そのものは持たない（照合用の値だけ）。日は、日本の日（YYYY-MM-DD）だけで、時刻を持たない。
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('iphone', 'ipad', 'pc', 'other')),
  secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64),
  registered_on TEXT NOT NULL CHECK (length(registered_on) = 10),
  last_used_on TEXT NOT NULL CHECK (length(last_used_on) = 10)
);

-- 合鍵の間違いの数（日ごと）。日付と整数だけ。
CREATE TABLE IF NOT EXISTS entrance_daily (
  day TEXT PRIMARY KEY CHECK (length(day) = 10),
  failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0)
);
