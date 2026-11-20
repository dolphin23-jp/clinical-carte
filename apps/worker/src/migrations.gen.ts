// このファイルは scripts/build_migrations.mjs が作る。手で直さない。正本は apps/worker/migrations/*.sql。

export interface Migration {
  readonly name: string;
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    "name": "0000_schema",
    "statements": [
      "CREATE TABLE IF NOT EXISTS schema_migrations ( name TEXT PRIMARY KEY )"
    ]
  },
  {
    "name": "0001_entrance",
    "statements": [
      "CREATE TABLE IF NOT EXISTS devices ( id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('iphone', 'ipad', 'pc', 'other')), secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64), registered_on TEXT NOT NULL CHECK (length(registered_on) = 10), last_used_on TEXT NOT NULL CHECK (length(last_used_on) = 10) )",
      "CREATE TABLE IF NOT EXISTS entrance_daily ( day TEXT PRIMARY KEY CHECK (length(day) = 10), failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0) )"
    ]
  },
  {
    "name": "0002_records",
    "statements": [
      "CREATE TABLE IF NOT EXISTS patients ( id TEXT PRIMARY KEY, age INTEGER NOT NULL CHECK (age BETWEEN 0 AND 130), age_on TEXT NOT NULL CHECK (length(age_on) = 10), sex TEXT NOT NULL CHECK (sex IN ('male', 'female', 'other')), created_on TEXT NOT NULL CHECK (length(created_on) = 10) )",
      "CREATE TABLE IF NOT EXISTS encounters ( id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('er', 'outpatient', 'inpatient')), started TEXT NOT NULL CHECK (length(started) IN (10, 16)), ended TEXT CHECK (ended IS NULL OR length(ended) IN (10, 16)) )",
      "CREATE INDEX IF NOT EXISTS encounters_by_patient ON encounters (patient_id, started)",
      "CREATE TABLE IF NOT EXISTS sources ( id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE, encounter_id TEXT NOT NULL REFERENCES encounters (id) ON DELETE CASCADE, kind TEXT NOT NULL, author_role TEXT NOT NULL, at TEXT CHECK (at IS NULL OR length(at) IN (10, 16)), entered_at TEXT NOT NULL CHECK (length(entered_at) = 16), text TEXT NOT NULL, replaced TEXT NOT NULL )",
      "CREATE INDEX IF NOT EXISTS sources_by_patient ON sources (patient_id, at)",
      "CREATE TABLE IF NOT EXISTS observations ( id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE, encounter_id TEXT NOT NULL REFERENCES encounters (id) ON DELETE CASCADE, source_id TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE, at TEXT CHECK (at IS NULL OR length(at) IN (10, 16)), name TEXT, name_raw TEXT NOT NULL, kind TEXT CHECK (kind IS NULL OR kind IN ('lab', 'vital')), value REAL, comparator TEXT CHECK (comparator IS NULL OR comparator IN ('<', '>', '<=', '>=')), value_text TEXT NOT NULL, unit TEXT, span_start INTEGER NOT NULL, span_end INTEGER NOT NULL, ord INTEGER NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('parser', 'ai', 'self')) )",
      "CREATE INDEX IF NOT EXISTS observations_by_patient ON observations (patient_id, at)",
      "CREATE INDEX IF NOT EXISTS observations_by_source ON observations (source_id)",
      "CREATE TABLE IF NOT EXISTS usage_daily ( day TEXT PRIMARY KEY CHECK (length(day) = 10), calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0) )"
    ]
  }
];
