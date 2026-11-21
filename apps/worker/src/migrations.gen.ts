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
  },
  {
    "name": "0003_organize",
    "statements": [
      "ALTER TABLE sources ADD COLUMN organized TEXT CHECK (organized IS NULL OR organized IN ('done', 'failed'))",
      "ALTER TABLE sources ADD COLUMN organized_version TEXT",
      "ALTER TABLE sources ADD COLUMN organize_report TEXT",
      "CREATE TABLE IF NOT EXISTS segments ( id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE, source_id TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE, label TEXT NOT NULL, span_start INTEGER NOT NULL, span_end INTEGER NOT NULL )",
      "CREATE INDEX IF NOT EXISTS segments_by_source ON segments (source_id, span_start)",
      "CREATE TABLE IF NOT EXISTS medications ( id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE, encounter_id TEXT NOT NULL REFERENCES encounters (id) ON DELETE CASCADE, source_id TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE, name TEXT NOT NULL, dose_text TEXT, action TEXT CHECK (action IS NULL OR action IN ('start', 'change', 'stop', 'continue')), at TEXT CHECK (at IS NULL OR length(at) IN (10, 16)), span_start INTEGER NOT NULL, span_end INTEGER NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('ai', 'self')) )",
      "CREATE INDEX IF NOT EXISTS medications_by_patient ON medications (patient_id, at)",
      "CREATE INDEX IF NOT EXISTS medications_by_source ON medications (source_id)",
      "CREATE TABLE IF NOT EXISTS events ( id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE, encounter_id TEXT NOT NULL REFERENCES encounters (id) ON DELETE CASCADE, source_id TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE, kind TEXT NOT NULL, title TEXT NOT NULL, at TEXT CHECK (at IS NULL OR length(at) IN (10, 16)), span_start INTEGER NOT NULL, span_end INTEGER NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('ai', 'self')) )",
      "CREATE INDEX IF NOT EXISTS events_by_patient ON events (patient_id, at)",
      "CREATE INDEX IF NOT EXISTS events_by_source ON events (source_id)",
      "CREATE TABLE IF NOT EXISTS problems ( id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE, encounter_id TEXT NOT NULL REFERENCES encounters (id) ON DELETE CASCADE, source_id TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE, name TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('problem', 'diagnosis', 'suspected', 'ruled_out')), at TEXT CHECK (at IS NULL OR length(at) IN (10, 16)), span_start INTEGER NOT NULL, span_end INTEGER NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('ai', 'self')) )",
      "CREATE INDEX IF NOT EXISTS problems_by_patient ON problems (patient_id, at)",
      "CREATE INDEX IF NOT EXISTS problems_by_source ON problems (source_id)"
    ]
  },
  {
    "name": "0004_threads",
    "statements": [
      "CREATE TABLE IF NOT EXISTS problem_threads ( id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE, display_name TEXT, merged_into TEXT )",
      "CREATE INDEX IF NOT EXISTS problem_threads_by_patient ON problem_threads (patient_id)",
      "ALTER TABLE problems ADD COLUMN thread_id TEXT",
      "ALTER TABLE problems ADD COLUMN thread_origin TEXT CHECK (thread_origin IS NULL OR thread_origin IN ('rule', 'ai', 'self'))",
      "ALTER TABLE problems ADD COLUMN activity TEXT CHECK (activity IS NULL OR activity IN ('resolved', 'inactive'))",
      "CREATE INDEX IF NOT EXISTS problems_by_thread ON problems (thread_id)",
      "CREATE TABLE IF NOT EXISTS history ( id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE, at TEXT NOT NULL CHECK (length(at) = 16), action TEXT NOT NULL CHECK (action IN ('move', 'merge', 'name')), target TEXT NOT NULL, before TEXT, after TEXT )",
      "CREATE INDEX IF NOT EXISTS history_by_patient ON history (patient_id, at)"
    ]
  },
  {
    "name": "0005_fact_edits",
    "statements": [
      "ALTER TABLE medications ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1))",
      "ALTER TABLE events ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1))",
      "ALTER TABLE observations ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1))",
      "CREATE TABLE IF NOT EXISTS fact_edits ( id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE, at TEXT NOT NULL CHECK (length(at) = 16), fact TEXT NOT NULL CHECK (fact IN ('medication', 'event', 'observation')), target TEXT NOT NULL, field TEXT NOT NULL CHECK (field IN ('excluded', 'action', 'kind', 'at')), before TEXT, after TEXT )",
      "CREATE INDEX IF NOT EXISTS fact_edits_by_patient ON fact_edits (patient_id, at)"
    ]
  },
  {
    "name": "0006_user_edits",
    "statements": [
      "ALTER TABLE problem_threads ADD COLUMN status_override TEXT CHECK (status_override IS NULL OR status_override IN ('problem', 'diagnosis', 'suspected', 'ruled_out'))",
      "ALTER TABLE problem_threads ADD COLUMN activity_override TEXT CHECK (activity_override IS NULL OR activity_override IN ('active', 'resolved', 'inactive'))",
      "ALTER TABLE problem_threads ADD COLUMN ord INTEGER",
      "ALTER TABLE problem_threads ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1))",
      "ALTER TABLE problem_threads ADD COLUMN typed_name TEXT",
      "ALTER TABLE segments ADD COLUMN origin TEXT NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai', 'self'))",
      "CREATE TABLE IF NOT EXISTS user_edits ( id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE, at TEXT NOT NULL CHECK (length(at) = 16), target_type TEXT NOT NULL CHECK (target_type IN ('source', 'segment', 'thread', 'problem', 'medication', 'event', 'observation')), target TEXT NOT NULL, field TEXT NOT NULL CHECK (field IN ('kind', 'at', 'author_role', 'label', 'status', 'activity', 'ord', 'excluded', 'unmerge', 'typed_name', 'name', 'text', 'added')), before TEXT, after TEXT )",
      "CREATE INDEX IF NOT EXISTS user_edits_by_patient ON user_edits (patient_id, at)"
    ]
  },
  {
    "name": "0007_ap_notes",
    "statements": [
      "CREATE TABLE IF NOT EXISTS ap_notes ( id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE, encounter_id TEXT NOT NULL REFERENCES encounters (id) ON DELETE CASCADE, thread_id TEXT NOT NULL, day TEXT NOT NULL CHECK (length(day) = 10), part TEXT NOT NULL CHECK (part IN ('assessment', 'plan')), plan_kind TEXT CHECK (plan_kind IS NULL OR plan_kind IN ('dx', 'tx', 'ex', 'other')), text TEXT NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('self', 'ai', 'ai_edited')), refs TEXT NOT NULL DEFAULT '[]', entered_at TEXT NOT NULL CHECK (length(entered_at) = 16), updated_at TEXT NOT NULL CHECK (length(updated_at) = 16) )",
      "CREATE INDEX IF NOT EXISTS ap_notes_by_encounter ON ap_notes (encounter_id, day)",
      "CREATE INDEX IF NOT EXISTS ap_notes_by_patient ON ap_notes (patient_id)",
      "CREATE TABLE IF NOT EXISTS ap_history ( id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE, at TEXT NOT NULL CHECK (length(at) = 16), note_id TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('add', 'edit', 'kind', 'delete')), origin TEXT CHECK (origin IS NULL OR origin IN ('self', 'ai', 'ai_edited')) )",
      "CREATE INDEX IF NOT EXISTS ap_history_by_patient ON ap_history (patient_id, at)"
    ]
  },
  {
    "name": "0008_next_day",
    "statements": [
      "ALTER TABLE sources ADD COLUMN next_day_from INTEGER CHECK (next_day_from IS NULL OR next_day_from >= 0)"
    ]
  },
  {
    "name": "0009_scale_links",
    "statements": [
      "CREATE TABLE IF NOT EXISTS scale_links ( id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60), unit_a TEXT NOT NULL CHECK (length(unit_a) <= 30), unit_b TEXT NOT NULL CHECK (length(unit_b) <= 30), created_at TEXT NOT NULL CHECK (length(created_at) = 16), removed_at TEXT CHECK (removed_at IS NULL OR length(removed_at) = 16) )"
    ]
  },
  {
    "name": "0010_documents",
    "statements": [
      "CREATE TABLE IF NOT EXISTS documents ( id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE, encounter_id TEXT NOT NULL REFERENCES encounters (id) ON DELETE CASCADE, type TEXT NOT NULL CHECK (type IN ('er_record', 'outpatient_first', 'outpatient_revisit', 'admission', 'progress', 'interim_summary', 'discharge_summary')), day TEXT NOT NULL CHECK (length(day) = 10), sections TEXT NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('self', 'ai', 'ai_edited')), entered_at TEXT NOT NULL CHECK (length(entered_at) = 16), updated_at TEXT NOT NULL CHECK (length(updated_at) = 16) )",
      "CREATE INDEX IF NOT EXISTS documents_by_encounter ON documents (encounter_id, day)",
      "CREATE INDEX IF NOT EXISTS documents_by_patient ON documents (patient_id)",
      "CREATE TABLE IF NOT EXISTS document_history ( id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE, at TEXT NOT NULL CHECK (length(at) = 16), document_id TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('add', 'edit', 'delete')), origin TEXT CHECK (origin IS NULL OR origin IN ('self', 'ai', 'ai_edited')) )",
      "CREATE INDEX IF NOT EXISTS document_history_by_patient ON document_history (patient_id, at)"
    ]
  }
];
