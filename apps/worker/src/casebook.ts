// 段K10：Casebook へ送る（CA-058 の B1・CA-073。docs/04 の 22）。受診ごとの印（casebook_links）を読む・作る・直すだけ。
// パケットを作るのは画面（core の casebookCandidates・buildPacket）で、クリップボードに載せるだけ。サーバーは Casebook へ何も送らない（通信しない）。
// 印に入るのは、種（乱数から。英小文字 10 字）・症例コード（先生が打つ）・Casebook が取り込んだと先生が押した項目の鍵と中身の印と改訂・パケットの数だけ。文・日付・時刻は入れない。
import { addTaken, CasebookLink, type CasebookPatch, newCasebookSeed, readCaseCode } from '@clinical-carte/core';

import type { Db } from './db.ts';
import type { Runtime } from './runtime.ts';

export interface CasebookLinkRow extends CasebookLink {
  readonly encounterId: string;
}

/** 表の1行を読む（形が違えば null：黙って直さない） */
export function casebookLinkOf(row: Record<string, unknown> | null): CasebookLinkRow | null {
  if (row === null) return null;
  const { encounter_id: encounterId, seed, case_code: code, sent, packets } = row;
  if (typeof encounterId !== 'string' || typeof sent !== 'string') return null;
  let marks: unknown;
  try {
    marks = JSON.parse(sent);
  } catch {
    return null;
  }
  const parsed = CasebookLink.safeParse({ seed, code: code ?? null, sent: marks, packets });
  return parsed.success ? { encounterId, ...parsed.data } : null;
}

const COLUMNS = 'encounter_id, seed, case_code, sent, packets';

export async function casebookLinks(db: Db, patientId: string): Promise<CasebookLinkRow[]> {
  const rows = await db.prepare(`SELECT ${COLUMNS} FROM casebook_links WHERE patient_id = ? ORDER BY encounter_id`).bind(patientId).all();
  return rows.results.map(casebookLinkOf).filter((x): x is CasebookLinkRow => x !== null);
}

async function readLink(db: Db, encounterId: string): Promise<CasebookLinkRow | null> {
  return casebookLinkOf(await db.prepare(`SELECT ${COLUMNS} FROM casebook_links WHERE encounter_id = ?`).bind(encounterId).first());
}

/** 受診の印を用意する（なければ、新しい種で作る。あれば、そのまま） */
export async function ensureCasebookLink(db: Db, encounter: { readonly id: string; readonly patientId: string }, runtime: Runtime): Promise<CasebookLinkRow | null> {
  await db
    .prepare('INSERT OR IGNORE INTO casebook_links (encounter_id, patient_id, seed, case_code, sent, packets) VALUES (?, ?, ?, NULL, ?, 0)')
    .bind(encounter.id, encounter.patientId, newCasebookSeed(runtime.randomBytes(10)), '{}')
    .run();
  return readLink(db, encounter.id);
}

export type CasebookPatchOutcome = { readonly ok: true; readonly link: CasebookLinkRow } | { readonly ok: false; readonly reason: 'not_found' | 'bad_request' };

async function write(db: Db, encounterId: string, link: CasebookLink): Promise<void> {
  await db.prepare('UPDATE casebook_links SET seed = ?, case_code = ?, sent = ?, packets = ? WHERE encounter_id = ?').bind(link.seed, link.code, JSON.stringify(link.sent), link.packets, encounterId).run();
}

/** 症例コードを入れる・消す／Casebook が取り込んだ項目の印を付ける／最初からやり直す（新しい種。症例コードと印を消す） */
export async function patchCasebookLink(db: Db, encounterId: string, patch: CasebookPatch, runtime: Runtime): Promise<CasebookPatchOutcome> {
  const current = await readLink(db, encounterId);
  if (current === null) return { ok: false, reason: 'not_found' };
  const link: CasebookLink = { seed: current.seed, code: current.code, sent: current.sent, packets: current.packets };
  let next: CasebookLink;
  if ('code' in patch) {
    const code = patch.code === null ? null : readCaseCode(patch.code);
    if (patch.code !== null && code === null) return { ok: false, reason: 'bad_request' };
    next = { ...link, code };
  } else if ('taken' in patch) {
    const added = addTaken(link, patch.taken);
    if (added === null) return { ok: false, reason: 'bad_request' };
    next = added;
  } else {
    next = { seed: newCasebookSeed(runtime.randomBytes(10)), code: null, sent: {}, packets: 0 };
  }
  await write(db, encounterId, next);
  return { ok: true, link: { encounterId, ...next } };
}
