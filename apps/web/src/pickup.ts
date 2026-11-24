// 読み込み直したあと（電話がページを捨てた・閉じて開き直した）に、預かった答えを拾う（段N2。CA-088）。画面のメモリだけ。
// - 患者の画面を初めて開いたときに1回、その患者の「動いている仕事と、受け取っていない答え」の一覧を読む（中身は含めない）
// - 拾う部品（相談の窓口・カルテ記載・指示簿）が、自分の種類・相手の仕事だけを、1つずつ受け取る（受け取ったら、預かった答えは消える）
// - この画面が自分で頼んでいる仕事（isKnownJob）は、拾わない（二重に受け取らない）
// - 保存する種類（整理など）の、受け取られずに残った成否は、ここで消す（結果は、もう記録にある）
import { type JobKind, type JobSummary, SHARED_JOB_KINDS } from '@clinical-carte/core';

import { dropJob, isKnownJob, listJobs } from './net/api.ts';

const lists = new Map<string, Promise<readonly JobSummary[]>>();
const claimed = new Set<string>();

/** その患者の一覧（画面を開いているあいだ、患者ごとに1回だけ読む） */
function listOf(patientId: string): Promise<readonly JobSummary[]> {
  const known = lists.get(patientId);
  if (known !== undefined) return known;
  const loading = listJobs(patientId).then((r) => (r.ok ? r.value : []));
  lists.set(patientId, loading);
  return loading;
}

/** 拾う：その患者の、kinds の種類で、target（受診・患者の id）が合う仕事のうち、まだ誰も受け取っていないもの。呼んだ部品が受け取る */
export async function claimJobs(patientId: string, kinds: readonly JobKind[], target: string): Promise<readonly JobSummary[]> {
  const list = await listOf(patientId);
  const mine = list.filter((j) => kinds.includes(j.kind) && j.target === target && !claimed.has(j.id) && !isKnownJob(j.id));
  for (const j of mine) claimed.add(j.id);
  return mine;
}

/** 保存する種類の、受け取られずに残った成否を消す（患者の画面を開いたとき） */
export async function dropLeftovers(patientId: string): Promise<void> {
  const list = await listOf(patientId);
  for (const j of list) {
    if (j.state !== 'done' || !SHARED_JOB_KINDS.includes(j.kind) || claimed.has(j.id) || isKnownJob(j.id)) continue;
    claimed.add(j.id);
    void dropJob(j.id);
  }
}
