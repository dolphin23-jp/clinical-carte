-- 単位の「同じ目盛り」（CA-051。全患者に共通。docs/04 の 14）：検査の項目ごとに、先生が「この2つの単位の書き方は、同じ目盛りで並べてよい」と決めた組。
-- 患者に付かない（項目の名前と単位の書き方だけ。どちらも検査名の表にあるものから選ぶ。'' は単位の記載なし）。換算の倍率は持たない。
-- 外すときは、行を消さず removed_at を入れる（決めた記録を残す）
CREATE TABLE IF NOT EXISTS scale_links (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  unit_a TEXT NOT NULL CHECK (length(unit_a) <= 30),
  unit_b TEXT NOT NULL CHECK (length(unit_b) <= 30),
  created_at TEXT NOT NULL CHECK (length(created_at) = 16),
  removed_at TEXT CHECK (removed_at IS NULL OR length(removed_at) = 16)
);
