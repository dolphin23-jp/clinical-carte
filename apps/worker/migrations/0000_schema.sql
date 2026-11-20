-- 適用した migrations の名前（サーバーが、自分で表を用意するための控え。docs/03 の 1）。名前だけを持つ。
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY
);
