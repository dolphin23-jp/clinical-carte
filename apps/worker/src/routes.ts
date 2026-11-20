// 記録の API（段1：患者・受診・取り込み）。ここに来るのは、入口（印の照合）を通った要求だけ（handler.ts）。
// 形の確かめは、core の型（zod）。誤りの答えは、名前だけ（何が起きたかの文・打った文を返さない）。
import {
  compareDateTime,
  EncounterPatch,
  isUlid,
  japanDateTime,
  japanDay,
  NewEncounter,
  NewPatient,
  NewSource,
  PatientPatch,
  TEXT_LIMIT,
  ulid,
  ULID_RANDOM_BYTES,
} from '@clinical-carte/core';
import type { z } from 'zod';

import type { Db } from './db.ts';
import { intake } from './intake.ts';
import { SELECT_PROMPT_VERSION } from './prompt.ts';
import {
  createEncounter,
  createPatient,
  deletePatient,
  deleteSource,
  type Encounter,
  getEncounter,
  getPatient,
  getRecord,
  listPatients,
  type NewObservation,
  observationOf,
  type Patient,
  patchPatient,
  saveSource,
  setEncounterEnd,
  type Source,
} from './records.ts';
import type { Runtime } from './runtime.ts';
import { runSelfCheck, selfCheckCases, SelfCheckRequest } from './selfcheck.ts';
import type { Selector } from './selector.ts';
import { callsOn, countCall } from './usage.ts';

export interface RecordDeps {
  readonly db: Db;
  readonly runtime: Runtime;
  /** AI の選別。鍵（ANTHROPIC_API_KEY か CARTE_api_key）がなければ null：文は入れられない（選別を通っていない文を、保存しない） */
  readonly selector: Selector | null;
  /** AI を呼べる回数（1日。日本の日）。0 は、上限なし */
  readonly dailyAiLimit: number;
  /** 使っているモデルの名前（評価の画面に出すだけ） */
  readonly model: string;
}

export interface Reply {
  readonly status: number;
  readonly body: unknown;
}

const reply = (status: number, body: unknown): Reply => ({ status, body });
const bad = (): Reply => reply(400, { error: 'bad_request' });
const missing = (): Reply => reply(404, { error: 'not_found' });

/** 本文の上限（文字）。文の上限に、欄の名前などの余裕を足したもの */
export const BODY_LIMIT = TEXT_LIMIT * 2 + 2000;

async function readBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T> | null> {
  const raw = await request.text();
  if (raw.length > BODY_LIMIT) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

const newId = (runtime: Runtime): string => ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES));

/** 記録の API。当てはまる道がなければ null（呼ぶ側が 404 にする）。 */
export async function recordApi(request: Request, path: string, deps: RecordDeps): Promise<Reply | null> {
  const { db, runtime } = deps;
  const method = request.method;
  const today = japanDay(runtime.now());

  if (path === '/api/patients') {
    if (method === 'GET') return reply(200, { patients: await listPatients(db), today });
    if (method === 'POST') {
      const body = await readBody(request, NewPatient);
      if (body === null) return bad();
      const patient: Patient = { id: newId(runtime), age: body.age, ageOn: body.ageOn, sex: body.sex, createdOn: today };
      const encounter: Encounter = { id: newId(runtime), patientId: patient.id, kind: body.encounter.kind, start: body.encounter.start, end: null };
      await createPatient(db, patient, encounter);
      return reply(200, { patient, encounter });
    }
    return null;
  }

  const onePatient = /^\/api\/patients\/([^/]+)$/.exec(path);
  if (onePatient) {
    const id = onePatient[1] ?? '';
    if (!isUlid(id)) return bad();
    if (method === 'GET') {
      const record = await getRecord(db, id);
      return record === null ? missing() : reply(200, { ...record, today });
    }
    if (method === 'PATCH') {
      const body = await readBody(request, PatientPatch);
      if (body === null) return bad();
      if ((await patchPatient(db, id, body)) === 0) return missing();
      return reply(200, { patient: await getPatient(db, id) });
    }
    if (method === 'DELETE') return (await deletePatient(db, id)) === 0 ? missing() : reply(200, { removed: id });
    return null;
  }

  const patientEncounters = /^\/api\/patients\/([^/]+)\/encounters$/.exec(path);
  if (patientEncounters && method === 'POST') {
    const patientId = patientEncounters[1] ?? '';
    if (!isUlid(patientId)) return bad();
    const body = await readBody(request, NewEncounter);
    if (body === null) return bad();
    if ((await getPatient(db, patientId)) === null) return missing();
    const encounter: Encounter = { id: newId(runtime), patientId, kind: body.kind, start: body.start, end: null };
    await createEncounter(db, encounter);
    return reply(200, { encounter });
  }

  const oneEncounter = /^\/api\/encounters\/([^/]+)$/.exec(path);
  if (oneEncounter && method === 'PATCH') {
    const id = oneEncounter[1] ?? '';
    if (!isUlid(id)) return bad();
    const body = await readBody(request, EncounterPatch);
    if (body === null) return bad();
    const encounter = await getEncounter(db, id);
    if (encounter === null) return missing();
    // 終わりは、始まりより前にできない（日だけと、日時を比べるときは、日で比べる）
    if (body.end !== null && compareDateTime(body.end.slice(0, 10), encounter.start.slice(0, 10)) < 0) return bad();
    await setEncounterEnd(db, id, body.end);
    return reply(200, { encounter: { ...encounter, end: body.end } });
  }

  const encounterSources = /^\/api\/encounters\/([^/]+)\/sources$/.exec(path);
  if (encounterSources && method === 'POST') {
    const encounterId = encounterSources[1] ?? '';
    if (!isUlid(encounterId)) return bad();
    const body = await readBody(request, NewSource);
    if (body === null) return bad();
    const encounter = await getEncounter(db, encounterId);
    if (encounter === null) return missing();
    if (deps.selector === null) return reply(503, { error: 'no_ai' });
    if (deps.dailyAiLimit > 0 && (await callsOn(db, today)) >= deps.dailyAiLimit) return reply(429, { error: 'ai_limit' });
    await countCall(db, today);

    const result = await intake(body, deps.selector);
    if (!result.ok) {
      if (result.reason === 'empty') return bad();
      if (result.reason === 'ai') return result.failure === 'refused' ? reply(422, { error: 'ai_refused' }) : reply(502, { error: result.failure === 'unavailable' ? 'ai_unavailable' : 'ai_bad_answer' });
      return reply(422, { error: 'selection_failed', problems: result.problems });
    }
    const source: Source = {
      id: newId(runtime),
      patientId: encounter.patientId,
      encounterId,
      kind: body.kind,
      authorRole: body.authorRole,
      at: body.at,
      enteredAt: japanDateTime(runtime.now()),
      text: result.text,
      replaced: result.replaced,
    };
    const observations: NewObservation[] = result.rows.map((row) => ({ id: newId(runtime), row }));
    await saveSource(db, source, observations);
    return reply(200, { source, observations: observations.map((o) => observationOf(source, o)) });
  }

  const oneSource = /^\/api\/sources\/([^/]+)$/.exec(path);
  if (oneSource && method === 'DELETE') {
    const id = oneSource[1] ?? '';
    if (!isUlid(id)) return bad();
    return (await deleteSource(db, id)) === 0 ? missing() : reply(200, { removed: id });
  }

  // 選別の評価（selfcheck.ts）：架空の文だけを、本番と同じ鍵・指示・モデルで AI に送り、漏れを数える
  if (path === '/api/selfcheck') {
    if (method === 'GET') return reply(200, { cases: selfCheckCases(), promptVersion: SELECT_PROMPT_VERSION, model: deps.model, ready: deps.selector !== null });
    if (method === 'POST') {
      const body = await readBody(request, SelfCheckRequest);
      if (body === null) return bad();
      if (deps.selector === null) return reply(503, { error: 'no_ai' });
      if (deps.dailyAiLimit > 0 && (await callsOn(db, today)) >= deps.dailyAiLimit) return reply(429, { error: 'ai_limit' });
      await countCall(db, today);
      const result = await runSelfCheck(body.id, body.seed, deps.selector);
      return result === null ? missing() : reply(200, { result });
    }
    return null;
  }

  return null;
}
