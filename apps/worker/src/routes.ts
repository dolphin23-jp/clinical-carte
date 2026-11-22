// 記録の API（段1：患者・受診・取り込み）。ここに来るのは、入口（印の照合）を通った要求だけ（handler.ts）。
// 形の確かめは、core の型（zod）。誤りの答えは、名前だけ（何が起きたかの文・打った文を返さない）。
import {
  compareDateTime,
  AddFact,
  ApNotePatch,
  ApNotesNew,
  DocumentNew,
  DocumentPatch,
  DocumentBackingRequest,
  DocumentRequest,
  HandoffNew,
  HandoffPatch,
  EncounterPatch,
  ReviseRequest,
  ListPatch,
  SegmentPatch,
  SourcePatch,
  ScaleLinkNew,
  scaleLinkProblem,
  scaleUnitKey,
  SourceAppend,
  SourceTextPut,
  SupportRequest,
  AskRequest,
  findShapes,
  headline,
  SearchRequest,
  searchQueryProblem,
  searchRecords,
  PendingPatch,
  PlanPatch,
  FACT_KINDS,
  type FactKind,
  FactPatch,
  isUlid,
  nextDayPoint,
  japanDateTime,
  japanDay,
  NewEncounter,
  NewPatient,
  NewSource,
  PatientPatch,
  ProblemMove,
  TEXT_LIMIT,
  ThreadPatch,
  ulid,
  ULID_RANDOM_BYTES,
} from '@clinical-carte/core';
import type { z } from 'zod';

import type { Db } from './db.ts';
import { addApNotes, type ApOutcome, deleteApNote, patchApNote } from './ap.ts';
import { askRecord } from './ask.ts';
import { generateSupport } from './clinicalsupport.ts';
import { addDocument, addHandoff, type CallGate, deleteDocument, deleteHandoff, documentMaterialFor, patchHandoff, gatherReferences, generateDocument, patchDocument, reviseDocument, type SaveOutcome, talkHasShapes } from './documents.ts';
import { addFact, appendSource, patchSegment, patchSource, retypeSource } from './edits.ts';
import { patchFact } from './facts.ts';
import { intake } from './intake.ts';
import { organizeSource } from './organize.ts';
import type { Organizer } from './organizer.ts';
import type { BookSearcher } from './references.ts';
import { type EditOutcome, type LinkOutcome, linkPatient, moveMention, patchThread, setTypedName } from './problems.ts';
import { generatePending, markPending } from './pending.ts';
import { generatePlans, markPlan } from './plans.ts';
import { generateList, patchList } from './problemlist.ts';
import { ORGANIZE_PROMPTS, SELECT_PROMPT_VERSION } from './prompt.ts';
import {
  createEncounter,
  createPatient,
  deletePatient,
  deleteSource,
  type Encounter,
  getEncounter,
  getPatient,
  getRecord,
  latestHandoffs,
  listPatients,
  listScaleLinks,
  searchInput,
  type NewObservation,
  observationOf,
  type Patient,
  patchPatient,
  saveSource,
  sourceBySendKey,
  setEncounterEnd,
  setEncounterKind,
  type Source,
} from './records.ts';
import type { Runtime } from './runtime.ts';
import { OrganizeCheckRequest, organizeCheckCases, runOrganizeCheck, runSelfCheck, selfCheckCases, SelfCheckRequest } from './selfcheck.ts';
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
  /** AI の整理（段2）。鍵がなければ null：文は入れられないので、整理もない */
  readonly organizer: Organizer | null;
  /** 書籍の検索（段5。本人の clinical-RAG）。宛先と合鍵の設定がなければ null：書籍は参照元にしない */
  readonly books: BookSearcher | null;
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

const edited = (outcome: EditOutcome): Reply =>
  outcome.ok ? reply(200, { ok: true }) : outcome.error === 'not_found' ? missing() : outcome.error === 'conflict' ? reply(409, { error: 'conflict' }) : bad();

/** つなぎの結果のうち、画面に出すもの（数だけ） */
const linkSummary = (o: LinkOutcome) => ({ usedAi: o.usedAi, pendingLeft: o.pendingLeft, failure: o.failure, report: o.report });

/** AI の失敗を、名前だけの答えにする */
const aiFailed = (failure: 'refused' | 'unavailable' | 'bad_answer'): Reply => (failure === 'refused' ? reply(422, { error: 'ai_refused' }) : reply(502, { error: failure === 'unavailable' ? 'ai_unavailable' : 'ai_bad_answer' }));

const apReply = (r: ApOutcome): Reply => {
  if (r.ok) return reply(200, { ids: r.ids });
  if (r.error === 'not_found') return missing();
  if (r.error === 'bad_request' || r.error === 'empty') return bad();
  if (r.error === 'ai') return aiFailed(r.failure);
  return reply(422, { error: 'selection_failed' });
};

const docReply = (r: SaveOutcome): Reply => {
  if (r.ok) return reply(200, { id: r.id });
  if (r.error === 'not_found') return missing();
  if (r.error === 'bad_request' || r.error === 'empty') return bad();
  if (r.error === 'ai') return aiFailed(r.failure);
  return reply(422, { error: 'selection_failed' });
};

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

  // 受け持ち全員の申し送り（段K7）：患者ごとに、いちばん新しい受診の、いちばん新しい残した申し送り（読むだけ。AI は呼ばない）
  if (path === '/api/handoffs' && method === 'GET') return reply(200, { handoffs: await latestHandoffs(db) });

  // 受け持ちを横断する検索（段K8。CA-070）：決定論で、AI を使わない。読むだけ（何も書かない）。
  // 問いは保存しない・ログに出さない・外へ送らない（本文で受ける：道の字に問いを載せない）。識別情報の形の問いは、画面と同じ関数で断る
  if (path === '/api/search') {
    if (method !== 'POST') return null;
    const body = await readBody(request, SearchRequest);
    if (body === null) return bad();
    const problem = searchQueryProblem(body.q);
    if (problem === 'shape') return reply(422, { error: 'shape' });
    if (problem !== null) return bad();
    const result = searchRecords(await searchInput(db), body.q);
    return reply(200, {
      today,
      total: result.total,
      shown: result.shown,
      patients: result.patients.map((p) => ({ ...p, headline: headline({ ...p.patient, encounter: p.encounter }, today) })),
    });
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
    // 種類を変える（救急・外来 → 入院 など）。開始・終わりの日時は、そのまま
    if ('kind' in body) {
      await setEncounterKind(db, id, body.kind);
      return reply(200, { encounter: { ...encounter, kind: body.kind } });
    }
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
    // 送る鍵（段K9。CA-072）：同じ受診に同じ鍵の文がもう保存されていれば、保存し直さずに、その文を返す（答えが戻らずに送り直したとき。AI は呼ばない）
    const sendKey = body.sendKey ?? null;
    if (sendKey !== null) {
      const saved = await sourceBySendKey(db, encounterId, sendKey);
      if (saved !== null) return reply(200, { source: saved.source, observations: saved.observations, again: true });
    }
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
      organized: null,
      organizedVersion: null,
      organizeReport: {},
      // 日をまたいだ場所は、保存する文（置き換えた後）で決め直す（打った文の位置は、置き換えでずれる）
      nextDayFrom: body.nextDay === true ? (nextDayPoint(result.text)?.at ?? null) : null,
    };
    const observations: NewObservation[] = result.rows.map((row) => ({ id: newId(runtime), row }));
    try {
      await saveSource(db, source, observations, sendKey);
    } catch (error) {
      // 同じ鍵の送り直しが、先の要求と同時に届いた（鍵の重なりで保存できなかった）：先に保存した文を返す
      const saved = sendKey === null ? null : await sourceBySendKey(db, encounterId, sendKey);
      if (saved === null) throw error;
      return reply(200, { source: saved.source, observations: saved.observations, again: true });
    }
    return reply(200, { source, observations: observations.map((o) => observationOf(source, o)) });
  }

  // 整理（段2）：保存した文を、AI に整理させる（文を入れたあと、画面が続けて呼ぶ。整理し直すときも、これ）
  const organize = /^\/api\/sources\/([^/]+)\/organize$/.exec(path);
  if (organize && method === 'POST') {
    const id = organize[1] ?? '';
    if (!isUlid(id)) return bad();
    if (deps.organizer === null) return reply(503, { error: 'no_ai' });
    if (deps.dailyAiLimit > 0 && (await callsOn(db, today)) >= deps.dailyAiLimit) return reply(429, { error: 'ai_limit' });
    await countCall(db, today);
    const result = await organizeSource(db, id, deps.organizer, runtime);
    if (!result.ok) {
      if (result.reason === 'not_found') return missing();
      return result.failure === 'refused' ? reply(422, { error: 'ai_refused' }) : reply(502, { error: result.failure === 'unavailable' ? 'ai_unavailable' : 'ai_bad_answer' });
    }
    // 続けて、問題の筋につなぐ（段3a）。AI に聞くのは、1日の上限の内のときだけ（超えていれば、つながないまま残す）
    const aiOk = deps.dailyAiLimit === 0 || (await callsOn(db, today)) < deps.dailyAiLimit;
    const link = await linkPatient(db, result.source.patientId, aiOk ? deps.organizer : null, runtime);
    if (link.usedAi) await countCall(db, today);
    return reply(200, { source: result.source, link: linkSummary(link) });
  }

  // 問題の筋のつなぎ直し（段3a）：つないでいない記載を、もう一度つなぐ（AI を使う）
  const linkProblems = /^\/api\/patients\/([^/]+)\/problems\/link$/.exec(path);
  if (linkProblems && method === 'POST') {
    const patientId = linkProblems[1] ?? '';
    if (!isUlid(patientId)) return bad();
    if ((await getPatient(db, patientId)) === null) return missing();
    if (deps.organizer === null) return reply(503, { error: 'no_ai' });
    if (deps.dailyAiLimit > 0 && (await callsOn(db, today)) >= deps.dailyAiLimit) return reply(429, { error: 'ai_limit' });
    const link = await linkPatient(db, patientId, deps.organizer, runtime);
    if (link.usedAi) await countCall(db, today);
    if (link.failure !== null) return link.failure === 'refused' ? reply(422, { error: 'ai_refused' }) : reply(502, { error: link.failure === 'unavailable' ? 'ai_unavailable' : 'ai_bad_answer' });
    return reply(200, { link: linkSummary(link) });
  }

  // 本人の直す操作（段3a）：記載を別の筋へ移す・分ける
  const oneProblem = /^\/api\/problems\/([^/]+)$/.exec(path);
  if (oneProblem && method === 'PATCH') {
    const id = oneProblem[1] ?? '';
    if (!isUlid(id)) return bad();
    const body = await readBody(request, ProblemMove);
    if (body === null) return bad();
    return edited(await moveMention(db, id, body, runtime));
  }

  // AI を呼ぶ回数の確かめ：呼ぶたびに数える（上限なら呼ばない）
  const gate: CallGate = {
    take: async () => {
      if (deps.dailyAiLimit > 0 && (await callsOn(db, today)) >= deps.dailyAiLimit) return false;
      await countCall(db, today);
      return true;
    },
  };

  // 書籍の参照元（clinical-RAG）のつながりを確かめる。設定がなければ off。送るのは決めた一般の語だけ
  if (path === '/api/references' && method === 'GET') {
    return reply(200, { books: deps.books === null ? 'off' : await deps.books.check() });
  }

  // A/P を残す（段5。CA-031・034）：本人が書いた・AI の案から採用した、決まったことだけ。文は選別（C-1）を通す。まとめて1回の選別
  const apNew = /^\/api\/encounters\/([^/]+)\/ap-notes$/.exec(path);
  if (apNew && method === 'POST') {
    const encounterId = apNew[1] ?? '';
    if (!isUlid(encounterId)) return bad();
    const body = await readBody(request, ApNotesNew);
    if (body === null || body.notes.some((n) => n.encounterId !== encounterId)) return bad();
    if (deps.selector === null) return reply(503, { error: 'no_ai' });
    if (!(await gate.take())) return reply(429, { error: 'ai_limit' });
    return apReply(await addApNotes(db, body.notes, deps.selector, runtime));
  }
  const oneAp = /^\/api\/ap-notes\/([^/]+)$/.exec(path);
  if (oneAp && method === 'PATCH') {
    const id = oneAp[1] ?? '';
    if (!isUlid(id)) return bad();
    const body = await readBody(request, ApNotePatch);
    if (body === null) return bad();
    if ('text' in body) {
      if (deps.selector === null) return reply(503, { error: 'no_ai' });
      if (!(await gate.take())) return reply(429, { error: 'ai_limit' });
    }
    return apReply(await patchApNote(db, id, body, deps.selector, runtime));
  }
  if (oneAp && method === 'DELETE') {
    const id = oneAp[1] ?? '';
    if (!isUlid(id)) return bad();
    return (await deleteApNote(db, id, runtime)) ? reply(200, { removed: id }) : missing();
  }

  // カルテ記載（段I。CA-054）：出す（generate）・相談して直す（revise）は、保存しない。記録が空なら、AI を呼ばない
  const docAi = /^\/api\/encounters\/([^/]+)\/documents\/(generate|revise)$/.exec(path);
  if (docAi && method === 'POST') {
    const encounterId = docAi[1] ?? '';
    if (!isUlid(encounterId)) return bad();
    const body = docAi[2] === 'revise' ? await readBody(request, ReviseRequest) : await readBody(request, DocumentRequest);
    if (body === null) return bad();
    const talk = 'instruction' in body ? (body as ReviseRequest) : null;
    const material = await documentMaterialFor(db, encounterId, body.type, body.day);
    if (material === null) return missing();
    if (material.records.length === 0) return reply(422, { error: 'document_empty' });
    if (deps.organizer === null) return reply(503, { error: 'no_ai' });
    if (talk !== null && talkHasShapes(talk)) return reply(422, { error: 'shape' });
    const refs = await gatherReferences(material.problemNames, { web: body.web, books: deps.books, organizer: deps.organizer, gate });
    if (talk !== null) {
      const r = await reviseDocument(material, talk, refs, deps.organizer, gate);
      if (!r.ok) return r.reason === 'ai_limit' ? reply(429, { error: 'ai_limit' }) : aiFailed(r.failure);
      return reply(200, { reply: r.reply, document: r.document, backing: r.backing, refs: r.refs, material: r.material, webFailed: r.webFailed });
    }
    const r = await generateDocument(material, refs, deps.organizer, gate);
    if (!r.ok) return r.reason === 'ai_limit' ? reply(429, { error: 'ai_limit' }) : aiFailed(r.failure);
    return reply(200, { document: r.document, backing: r.backing, refs: r.refs, material: r.material, webFailed: r.webFailed });
  }

  // AI のプロブレムリスト（CA-057）：組む（AI の 1 回。記録が空なら呼ばない）・先生が直す（名前は選別 C-1 を通す）
  const plist = /^\/api\/patients\/([^/]+)\/problem-list$/.exec(path);
  if (plist && method === 'POST') {
    const patientId = plist[1] ?? '';
    if (!isUlid(patientId)) return bad();
    if (deps.organizer === null) return reply(503, { error: 'no_ai' });
    const r = await generateList(db, patientId, deps.organizer, gate, runtime);
    if (!r.ok) {
      if (r.reason === 'not_found') return missing();
      if (r.reason === 'empty') return reply(422, { error: 'list_empty' });
      if (r.reason === 'ai_limit') return reply(429, { error: 'ai_limit' });
      return aiFailed(r.failure);
    }
    return reply(200, { items: r.items, rejected: r.rejected, shapes: r.shapes });
  }
  if (plist && method === 'PATCH') {
    const patientId = plist[1] ?? '';
    if (!isUlid(patientId)) return bad();
    const body = await readBody(request, ListPatch);
    if (body === null) return bad();
    if ('name' in body) {
      if (deps.selector === null) return reply(503, { error: 'no_ai' });
      if (!(await gate.take())) return reply(429, { error: 'ai_limit' });
    }
    const r = await patchList(db, patientId, body, deps.selector, runtime);
    if (r.ok) return reply(200, { ok: true });
    if (r.error === 'not_found') return missing();
    if (r.error === 'empty') return bad();
    if (r.error === 'ai') return aiFailed(r.failure);
    return reply(422, { error: 'selection_failed' });
  }

  // AI の臨床支援（段K5。CA-064）：組み直す（書籍・ネットの検索には問題の名前だけ。AI の 1 回〔ネットを頼めば、もう 1 回〕。活動中の問題がなければ呼ばない）
  const support = /^\/api\/patients\/([^/]+)\/support$/.exec(path);
  if (support && method === 'POST') {
    const patientId = support[1] ?? '';
    if (!isUlid(patientId)) return bad();
    const body = await readBody(request, SupportRequest);
    if (body === null) return bad();
    if (deps.organizer === null) return reply(503, { error: 'no_ai' });
    const r = await generateSupport(db, patientId, { web: body.web, organizer: deps.organizer, books: deps.books, gate, runtime, today });
    if (!r.ok) {
      if (r.reason === 'not_found') return missing();
      if (r.reason === 'empty') return reply(422, { error: 'support_empty' });
      if (r.reason === 'ai_limit') return reply(429, { error: 'ai_limit' });
      return aiFailed(r.failure);
    }
    return reply(200, { support: r.body });
  }

  // 結果待ち（段K6。CA-065）：組み直す（AI の 1 回。提出の候補がなければ、AI を呼ばずに空の一覧を残す）・先生の印（ボタンだけ）
  const pending = /^\/api\/patients\/([^/]+)\/pending$/.exec(path);
  if (pending && method === 'POST') {
    const patientId = pending[1] ?? '';
    if (!isUlid(patientId)) return bad();
    if (deps.organizer === null) return reply(503, { error: 'no_ai' });
    const r = await generatePending(db, patientId, deps.organizer, gate, runtime);
    if (!r.ok) {
      if (r.reason === 'not_found') return missing();
      if (r.reason === 'ai_limit') return reply(429, { error: 'ai_limit' });
      return aiFailed(r.failure);
    }
    return reply(200, { pending: r.body });
  }
  if (pending && method === 'PATCH') {
    const patientId = pending[1] ?? '';
    if (!isUlid(patientId)) return bad();
    const body = await readBody(request, PendingPatch);
    if (body === null) return bad();
    return (await markPending(db, patientId, body, runtime)) ? reply(200, { ok: true }) : missing();
  }

  // 予定と実施（段K9。CA-071）：組み直す（AI の 1 回。予定の行がなければ、AI を呼ばずに空の一覧を残す）・先生の印（ボタンだけ）
  const plans = /^\/api\/patients\/([^/]+)\/plans$/.exec(path);
  if (plans && method === 'POST') {
    const patientId = plans[1] ?? '';
    if (!isUlid(patientId)) return bad();
    if (deps.organizer === null) return reply(503, { error: 'no_ai' });
    const r = await generatePlans(db, patientId, deps.organizer, gate, runtime);
    if (!r.ok) {
      if (r.reason === 'not_found') return missing();
      if (r.reason === 'ai_limit') return reply(429, { error: 'ai_limit' });
      return aiFailed(r.failure);
    }
    return reply(200, { plans: r.body });
  }
  if (plans && method === 'PATCH') {
    const patientId = plans[1] ?? '';
    if (!isUlid(patientId)) return bad();
    const body = await readBody(request, PlanPatch);
    if (body === null) return bad();
    return (await markPlan(db, patientId, body, runtime)) ? reply(200, { ok: true }) : missing();
  }

  // 記録への質問（段K6。CA-066）：保存しない（問い・答えとも）。問いに識別情報の形があれば送らない（相談の頼みと同じ）。AI の 1 回
  const ask = /^\/api\/patients\/([^/]+)\/ask$/.exec(path);
  if (ask && method === 'POST') {
    const patientId = ask[1] ?? '';
    if (!isUlid(patientId)) return bad();
    const body = await readBody(request, AskRequest);
    if (body === null) return bad();
    if (deps.organizer === null) return reply(503, { error: 'no_ai' });
    if (findShapes(body.question).length > 0) return reply(422, { error: 'shape' });
    const r = await askRecord(db, patientId, body.question, { organizer: deps.organizer, gate, today });
    if (!r.ok) {
      if (r.reason === 'not_found') return missing();
      if (r.reason === 'empty') return reply(422, { error: 'ask_empty' });
      if (r.reason === 'ai_limit') return reply(429, { error: 'ai_limit' });
      return aiFailed(r.failure);
    }
    return reply(200, { answer: r.reply });
  }

  // 数の印の照らし合わせの表（段I）：AI を使わない（残した記載を開いたときの印に使う）。数だけを返す
  const docBacking = /^\/api\/encounters\/([^/]+)\/documents\/backing$/.exec(path);
  if (docBacking && method === 'POST') {
    const encounterId = docBacking[1] ?? '';
    if (!isUlid(encounterId)) return bad();
    const body = await readBody(request, DocumentBackingRequest);
    if (body === null) return bad();
    const material = await documentMaterialFor(db, encounterId, body.type, body.day);
    return material === null ? missing() : reply(200, { backing: material.backing });
  }

  // カルテ記載を残す・直す・消す（段I）：本人が「保存する」を押したものだけ。文は選別（C-1）を通す（1回の選別）
  const docNew = /^\/api\/encounters\/([^/]+)\/documents$/.exec(path);
  if (docNew && method === 'POST') {
    const encounterId = docNew[1] ?? '';
    if (!isUlid(encounterId)) return bad();
    const body = await readBody(request, DocumentNew);
    if (body === null) return bad();
    if (deps.selector === null) return reply(503, { error: 'no_ai' });
    if (!(await gate.take())) return reply(429, { error: 'ai_limit' });
    return docReply(await addDocument(db, encounterId, body, deps.selector, runtime));
  }
  const oneDoc = /^\/api\/documents\/([^/]+)$/.exec(path);
  if (oneDoc && method === 'PATCH') {
    const id = oneDoc[1] ?? '';
    if (!isUlid(id)) return bad();
    const body = await readBody(request, DocumentPatch);
    if (body === null) return bad();
    if (deps.selector === null) return reply(503, { error: 'no_ai' });
    if (!(await gate.take())) return reply(429, { error: 'ai_limit' });
    return docReply(await patchDocument(db, id, body, deps.selector, runtime));
  }
  if (oneDoc && method === 'DELETE') {
    const id = oneDoc[1] ?? '';
    if (!isUlid(id)) return bad();
    return (await deleteDocument(db, id, runtime)) ? reply(200, { removed: id }) : missing();
  }

  // 申し送りを残す・直す・消す（段K7。CA-067）：重症度は先生が選んだもの。文は選別（C-1）を通す（1回の選別）
  const handoffNew = /^\/api\/encounters\/([^/]+)\/handoffs$/.exec(path);
  if (handoffNew && method === 'POST') {
    const encounterId = handoffNew[1] ?? '';
    if (!isUlid(encounterId)) return bad();
    const body = await readBody(request, HandoffNew);
    if (body === null) return bad();
    if (deps.selector === null) return reply(503, { error: 'no_ai' });
    if (!(await gate.take())) return reply(429, { error: 'ai_limit' });
    return docReply(await addHandoff(db, encounterId, body, deps.selector, runtime));
  }
  const oneHandoff = /^\/api\/handoffs\/([^/]+)$/.exec(path);
  if (oneHandoff && method === 'PATCH') {
    const id = oneHandoff[1] ?? '';
    if (!isUlid(id)) return bad();
    const body = await readBody(request, HandoffPatch);
    if (body === null) return bad();
    if (deps.selector === null) return reply(503, { error: 'no_ai' });
    if (!(await gate.take())) return reply(429, { error: 'ai_limit' });
    return docReply(await patchHandoff(db, id, body, deps.selector, runtime));
  }
  if (oneHandoff && method === 'DELETE') {
    const id = oneHandoff[1] ?? '';
    if (!isUlid(id)) return bad();
    return (await deleteHandoff(db, id, runtime)) ? reply(200, { removed: id }) : missing();
  }

  // 問題以外の事実を直す（段3e）：外す・戻す、投薬の動き・できごとの種類・日時を選び直す
  const oneFact = /^\/api\/facts\/([a-z]+)\/([^/]+)$/.exec(path);
  if (oneFact && method === 'PATCH') {
    const fact = oneFact[1] ?? '';
    const id = oneFact[2] ?? '';
    if (!(FACT_KINDS as readonly string[]).includes(fact) || !isUlid(id)) return bad();
    const body = await readBody(request, FactPatch);
    if (body === null) return bad();
    const outcome = await patchFact(db, fact as FactKind, id, body, runtime);
    return outcome.ok ? reply(200, { ok: true }) : outcome.error === 'not_found' ? missing() : bad();
  }

  // 筋を直す：統合する・表示の名前を選ぶ
  const oneThread = /^\/api\/threads\/([^/]+)$/.exec(path);
  if (oneThread && method === 'PATCH') {
    const id = oneThread[1] ?? '';
    if (!isUlid(id)) return bad();
    const body = await readBody(request, ThreadPatch);
    if (body === null) return bad();
    if ('typedName' in body) {
      // 打って直す名前（C-1）：入れるときと同じ選別を通し、置き換えた後の字だけを保存する。やめる（null）ときは AI を使わない
      if (body.typedName === null) return edited(await setTypedName(db, id, null, runtime));
      if (deps.selector === null) return reply(503, { error: 'no_ai' });
      if (deps.dailyAiLimit > 0 && (await callsOn(db, today)) >= deps.dailyAiLimit) return reply(429, { error: 'ai_limit' });
      await countCall(db, today);
      const selected = await intake({ kind: 'memo', authorRole: 'self', at: null, text: body.typedName }, deps.selector);
      if (!selected.ok) {
        if (selected.reason === 'empty') return bad();
        if (selected.reason === 'ai') return selected.failure === 'refused' ? reply(422, { error: 'ai_refused' }) : reply(502, { error: selected.failure === 'unavailable' ? 'ai_unavailable' : 'ai_bad_answer' });
        return reply(422, { error: 'selection_failed' });
      }
      return edited(await setTypedName(db, id, selected.text, runtime));
    }
    return edited(await patchThread(db, id, body, runtime));
  }

  const oneSource = /^\/api\/sources\/([^/]+)$/.exec(path);
  if (oneSource && method === 'DELETE') {
    const id = oneSource[1] ?? '';
    if (!isUlid(id)) return bad();
    return (await deleteSource(db, id)) === 0 ? missing() : reply(200, { removed: id });
  }
  // 記載の種類・日時・書いた人を直す（CA-029 の A）
  if (oneSource && method === 'PATCH') {
    const id = oneSource[1] ?? '';
    if (!isUlid(id)) return bad();
    const body = await readBody(request, SourcePatch);
    if (body === null) return bad();
    const r = await patchSource(db, id, body, runtime);
    return r.ok ? reply(200, { ok: true }) : r.error === 'not_found' ? missing() : bad();
  }

  // 単位の「同じ目盛り」（CA-051。全患者に共通）：組を決める・外す。字は打たない（項目・単位は表から選ぶ）ので、選別を通さない
  if (path === '/api/scale-links' && method === 'POST') {
    const body = await readBody(request, ScaleLinkNew);
    if (body === null || scaleLinkProblem(body) !== null) return bad();
    const existing = (await listScaleLinks(db)).find(
      (l) => l.name === body.name && [scaleUnitKey(l.unitA || null), scaleUnitKey(l.unitB || null)].sort().join('\u0000') === [scaleUnitKey(body.unitA || null), scaleUnitKey(body.unitB || null)].sort().join('\u0000'),
    );
    if (existing !== undefined) return reply(200, { id: existing.id });
    const id = newId(runtime);
    await db.prepare('INSERT INTO scale_links (id, name, unit_a, unit_b, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, body.name, body.unitA, body.unitB, japanDateTime(runtime.now())).run();
    return reply(200, { id });
  }
  const oneScaleLink = /^\/api\/scale-links\/([^/]+)$/.exec(path);
  if (oneScaleLink && method === 'DELETE') {
    const id = oneScaleLink[1] ?? '';
    if (!isUlid(id)) return bad();
    const r = await db.prepare('UPDATE scale_links SET removed_at = ? WHERE id = ? AND removed_at IS NULL').bind(japanDateTime(runtime.now()), id).run();
    return (r.meta?.changes ?? 0) === 0 ? missing() : reply(200, { ok: true });
  }

  // 続きを足す（CA-050）：足す文だけを、入れるときと同じ選別に通す。AI の1回に数える。続けて、画面が整理し直す
  const sourceAppend = /^\/api\/sources\/([^/]+)\/append$/.exec(path);
  if (sourceAppend && method === 'POST') {
    const id = sourceAppend[1] ?? '';
    if (!isUlid(id)) return bad();
    const body = await readBody(request, SourceAppend);
    if (body === null) return bad();
    if (deps.selector === null) return reply(503, { error: 'no_ai' });
    if (deps.dailyAiLimit > 0 && (await callsOn(db, today)) >= deps.dailyAiLimit) return reply(429, { error: 'ai_limit' });
    await countCall(db, today);
    const r = await appendSource(db, id, body.text, deps.selector, runtime, body.nextDay);
    if (!r.ok) {
      if (r.error === 'not_found') return missing();
      if (r.error === 'empty') return bad();
      if (r.error === 'too_long') return reply(400, { error: 'too_long' });
      if (r.error === 'ai') return r.failure === 'refused' ? reply(422, { error: 'ai_refused' }) : reply(502, { error: r.failure === 'unavailable' ? 'ai_unavailable' : 'ai_bad_answer' });
      return reply(422, { error: 'selection_failed' });
    }
    return reply(200, { ok: true });
  }

  // 文を打ち直す（C-1）：入れるときと同じ選別を通す。AI の1回に数える。続けて、画面が整理し直す
  const sourceText = /^\/api\/sources\/([^/]+)\/text$/.exec(path);
  if (sourceText && method === 'PUT') {
    const id = sourceText[1] ?? '';
    if (!isUlid(id)) return bad();
    const body = await readBody(request, SourceTextPut);
    if (body === null) return bad();
    if (deps.selector === null) return reply(503, { error: 'no_ai' });
    if (deps.dailyAiLimit > 0 && (await callsOn(db, today)) >= deps.dailyAiLimit) return reply(429, { error: 'ai_limit' });
    await countCall(db, today);
    const r = await retypeSource(db, id, body.text, deps.selector, runtime, body.nextDay);
    if (!r.ok) {
      if (r.error === 'not_found') return missing();
      if (r.error === 'empty') return bad();
      if (r.error === 'ai') return r.failure === 'refused' ? reply(422, { error: 'ai_refused' }) : reply(502, { error: r.failure === 'unavailable' ? 'ai_unavailable' : 'ai_bad_answer' });
      return reply(422, { error: 'selection_failed' });
    }
    return reply(200, { lost: r.lost });
  }

  // なぞって足す（CA-029 の B）：保存した文の一部を、問題・投薬・できごと・値・区切りとして足す
  const sourceAdd = /^\/api\/sources\/([^/]+)\/facts$/.exec(path);
  if (sourceAdd && method === 'POST') {
    const id = sourceAdd[1] ?? '';
    if (!isUlid(id)) return bad();
    const body = await readBody(request, AddFact);
    if (body === null) return bad();
    const r = await addFact(db, id, body, runtime);
    if (r.ok) return reply(200, { ok: true });
    return r.error === 'not_found' ? missing() : reply(422, { error: 'bad_span', problem: r.problem });
  }

  // 区切りの見出しを選び直す（CA-029 の A）
  const oneSegment = /^\/api\/segments\/([^/]+)$/.exec(path);
  if (oneSegment && method === 'PATCH') {
    const id = oneSegment[1] ?? '';
    if (!isUlid(id)) return bad();
    const body = await readBody(request, SegmentPatch);
    if (body === null) return bad();
    const r = await patchSegment(db, id, body, runtime);
    return r.ok ? reply(200, { ok: true }) : r.error === 'not_found' ? missing() : bad();
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

  // 整理の評価（selfcheck.ts）：架空の文だけを、本番と同じ鍵・モデルで、いまの版か前の版の指示で整理し、決まりで数える
  if (path === '/api/selfcheck/organize') {
    if (method === 'GET') {
      return reply(200, {
        cases: organizeCheckCases(),
        versions: { current: ORGANIZE_PROMPTS.current.version, previous: ORGANIZE_PROMPTS.previous.version },
        model: deps.model,
        ready: deps.organizer !== null,
      });
    }
    if (method === 'POST') {
      const body = await readBody(request, OrganizeCheckRequest);
      if (body === null) return bad();
      if (deps.organizer === null) return reply(503, { error: 'no_ai' });
      if (deps.dailyAiLimit > 0 && (await callsOn(db, today)) >= deps.dailyAiLimit) return reply(429, { error: 'ai_limit' });
      await countCall(db, today);
      const result = await runOrganizeCheck(body.id, body.prompt, deps.organizer);
      return result === null ? missing() : reply(200, { result });
    }
    return null;
  }

  return null;
}
