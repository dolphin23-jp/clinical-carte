// 問題以外の事実（投薬・できごと・測定値）を、本人が直す（段3e。docs/04 の 10）。直した行は origin を self にし、
// 整理し直しでも引き継ぐ（organize.ts）。直すたびに fact_edits に残す（選んだ値・日時・印だけ。文は入らない）。
import { type FactKind, type FactPatch, japanDateTime, patchFits, ulid, ULID_RANDOM_BYTES } from '@clinical-carte/core';

import type { Db } from './db.ts';
import type { Runtime } from './runtime.ts';

const TABLE: Readonly<Record<FactKind, string>> = { medication: 'medications', event: 'events', observation: 'observations' };

export type FactOutcome = { readonly ok: true } | { readonly ok: false; readonly error: 'not_found' | 'bad_request' };

export async function patchFact(db: Db, fact: FactKind, id: string, patch: FactPatch, runtime: Runtime): Promise<FactOutcome> {
  if (!patchFits(fact, patch)) return { ok: false, error: 'bad_request' };
  const table = TABLE[fact];
  const field = 'excluded' in patch ? 'excluded' : 'action' in patch ? 'action' : 'kind' in patch ? 'kind' : 'at';
  const row = await db.prepare(`SELECT patient_id, ${field} AS current FROM ${table} WHERE id = ?`).bind(id).first();
  const patientId = row?.['patient_id'];
  if (row === null || typeof patientId !== 'string') return { ok: false, error: 'not_found' };
  const value: string | number | null = 'excluded' in patch ? (patch.excluded ? 1 : 0) : 'action' in patch ? patch.action : 'kind' in patch ? patch.kind : patch.at;
  const current = row['current'];
  const before = typeof current === 'string' || typeof current === 'number' ? String(current) : null;
  const after = value === null ? null : String(value);
  await db.batch([
    db.prepare(`UPDATE ${table} SET ${field} = ?, origin = 'self' WHERE id = ?`).bind(value, id),
    db
      .prepare('INSERT INTO fact_edits (id, patient_id, at, fact, target, field, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES)), patientId, japanDateTime(runtime.now()), fact, id, field, before, after),
  ]);
  return { ok: true };
}
