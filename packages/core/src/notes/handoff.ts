// 段K7：申し送り（CA-067。CA-058 の A5。I-PASS の形）。純関数。
//
// - I（重症度）：**先生が選ぶ**（安定・要注意・不安定）。AI には書かせない・資料からも推し量らない。既定の値はない（選ぶまで残せない）。
//   残す先は `handoffs` の severity の列（記載の文とは別の欄）。AI の答えに重症度の行があれば、checkDocument が出さずに数える。
// - P（患者の要約）・A（やること）・S（起こりうることと対応）：カルテ記載と同じ流れで、AI が記録から書く（DOC_SECTIONS.handoff）。
// - S（受け手の確認）：受け手が言い直して確かめる欄。画面のメモリだけで、残さない。
// - 資料（handoffContext）：いまの状態（patientState。記録の上で最後の日時まで）から、1行の要約・問題ごとの最後の A/P・記載全体の P・
//   結果待ち・デバイスと薬の日数・24時間に入ったことを、決定論で行にする（作文しない）。
import { z } from 'zod';

import { EVENT_KIND_NAMES, MEDICATION_ACTION_NAMES } from '../organize/answer.ts';
import type { PendingItem } from '../pending/pending.ts';
import { Day } from '../record/schema.ts';
import { dayNumber } from '../views/days.ts';
import type { PatientState } from '../views/state.ts';
import { DOC_ORIGINS, type DocOrigin, type HandoffContext, SavedSection } from './document.ts';

export const HANDOFF_SEVERITIES = ['stable', 'watcher', 'unstable'] as const;
export type HandoffSeverity = (typeof HANDOFF_SEVERITIES)[number];
/** 重症度の名前（I-PASS の stable・watcher・unstable）。先生が選ぶ。色は画面の印で、名前と一緒に出す */
export const HANDOFF_SEVERITY_NAMES: Readonly<Record<HandoffSeverity, string>> = { stable: '安定', watcher: '要注意', unstable: '不安定' };

/** AI が書かない、申し送りの見出し（I と、受け手の S） */
export const HANDOFF_HEADINGS = { severity: '重症度（先生が選ぶ）', synthesis: '受け手の確認' } as const;

/** 申し送りを残す（重症度は必ず先生が選んだもの。文は選別を通す） */
export const HandoffNew = z.strictObject({
  day: Day,
  severity: z.enum(HANDOFF_SEVERITIES),
  sections: z.array(SavedSection).min(1).max(20),
  origin: z.enum(['ai', 'self']),
  edited: z.boolean(),
});
export type HandoffNew = z.infer<typeof HandoffNew>;

/** 残した申し送りを直す（重症度を選び直すのも、ここ） */
export const HandoffPatch = z.strictObject({ severity: z.enum(HANDOFF_SEVERITIES), sections: z.array(SavedSection).min(1).max(20) });
export type HandoffPatch = z.infer<typeof HandoffPatch>;

export interface SavedHandoff {
  readonly id: string;
  readonly encounterId: string;
  readonly day: string;
  readonly severity: HandoffSeverity;
  readonly sections: readonly SavedSection[];
  readonly origin: DocOrigin;
  readonly enteredAt: string;
  readonly updatedAt: string;
}

export const isHandoffSeverity = (v: unknown): v is HandoffSeverity => typeof v === 'string' && (HANDOFF_SEVERITIES as readonly string[]).includes(v);
export const isDocOrigin = (v: unknown): v is DocOrigin => typeof v === 'string' && (DOC_ORIGINS as readonly string[]).includes(v);

/** いちばん新しい申し送り（日 → 直した日時 → id の順で新しいもの） */
export function latestHandoff<T extends Pick<SavedHandoff, 'day' | 'updatedAt' | 'id'>>(list: readonly T[]): T | null {
  return [...list].sort((a, b) => a.day.localeCompare(b.day) || a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id)).at(-1) ?? null;
}

const showAt = (at: string | null): string => (at === null ? '日時不明' : at.replace('T', ' '));

/**
 * 申し送りの資料：いまの状態から、決定論で行にする。字は記録の字（保存した文の、その場所）と、整理した事実のまま。
 * text(sourceId) は保存した文（識別情報を置き換えた後）
 */
export function handoffContext(state: PatientState, text: (sourceId: string) => string | null, pending: readonly PendingItem[]): HandoffContext {
  const slice = (sourceId: string, start: number, end: number): string => (text(sourceId) ?? '').slice(start, end).trim();
  const problems = state.current.map((c) => ({
    name: c.thread.name,
    at: c.notes[0]?.at ?? null,
    note: c.notes
      .map((n) => slice(n.sourceId, n.start, n.end))
      .filter((t) => t !== '')
      .join('\n'),
  }));
  const sharedPlan = state.sharedPlan === null ? '' : state.sharedPlan.parts.map((p) => slice(p.sourceId, p.start, p.end)).filter((t) => t !== '').join('\n');
  const until = state.asOf;
  const pendingLines = pending
    .filter((p) => p.state === 'pending' && p.mark === 'none')
    .map((p) => {
      const n = p.at !== null && until !== null ? dayNumber(p.at, until) : null;
      return `${showAt(p.at)}${p.atApprox === null ? '' : `（${p.atApprox}）`} ${p.name}（結果の記載なし${n === null ? '' : `・提出から ${String(n)} 日目`}）`;
    });
  const devices = state.devices.filter((d) => d.removedAt === null).map((d) => `${d.name} ${showAt(d.placedAt)}〜${d.day === null ? '' : `（${String(d.day)} 日目）`}`);
  const medications = state.medications.map((m) => {
    const action = m.action === null ? '動きの記載なし' : MEDICATION_ACTION_NAMES[m.action];
    const days = m.days.day === null ? '' : `・開始から ${String(m.days.day)} 日目`;
    return `${m.name}${m.doseText === null ? '' : ` ${m.doseText}`}（最後の記載 ${showAt(m.at)} ${action}${days}）`;
  });
  const recent = (state.recent?.items ?? []).map((item) => {
    switch (item.type) {
      case 'problem_new':
        return `${showAt(item.at)} 問題：${item.name}（はじめて書かれた）`;
      case 'problem_activity':
        return `${showAt(item.at)} 問題：${item.name}（${item.activity === 'resolved' ? '解決' : '非活動'}と書かれた）`;
      case 'medication':
        return `${showAt(item.at)} 薬：${item.name} ${MEDICATION_ACTION_NAMES[item.action]}${item.doseText === null ? '' : ` ${item.doseText}`}`;
      case 'event':
        return `${showAt(item.at)} ${EVENT_KIND_NAMES[item.kind]}：${item.title}`;
      case 'lab':
        return `${showAt(item.at)} 検査：${item.name} ${item.comparator ?? ''}${item.valueText}${item.unit === null ? '' : ` ${item.unit}`}`;
    }
  });
  return { oneLiner: state.oneLiner, asOf: state.asOf, problems, sharedPlan, pending: pendingLines, devices, medications, recent };
}
