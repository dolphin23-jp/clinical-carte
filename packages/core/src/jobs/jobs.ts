// 仕事を通信から切り離す（段N2。CA-087）と、保存しない答えを受け取るまで預かる（CA-088）の決まり。純関数：時計・通信を持たない。
// - AI を呼ぶ頼み（整理・プロブレムリスト・臨床支援・結果待ち・予定と実施・相談・記録に聞く・記載を出す・AI に頼む・指示簿の写しと案）は、
//   画面が「仕事として」頼むと、サーバーが仕事の番号をすぐ返し、仕事は通信と切り離して続ける（Cloudflare の Durable Objects。頼みの中身は
//   メモリにだけ渡し、ディスクに書かない：打った問いの字は保存しない決まりのまま）。画面は、番号で様子を聞き、答えを受け取る
// - 終わった仕事の答えは、受け取るまで保存先（job_results）に預かる。預かるのは、確かめた後の答えだけ（保存しない答えの種類）。
//   保存する種類（整理など）は、結果がもう記録にあるので、答えの中身は預からず、成否の名前だけ。問い・頼みの字は、どちらも預からない
// - 受け取ったら消す。受け取られないものは JOB_HOLD_HOURS で消す。患者を消すと消える

/** 仕事にできる頼みの種類 */
export const JOB_KINDS = [
  'organize',
  'problem_list',
  'support',
  'pending',
  'plans',
  'consult',
  'ask',
  'document',
  'revise',
  'order_transcribe',
  'order_propose',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_KIND_NAMES: Readonly<Record<JobKind, string>> = {
  organize: '整理',
  problem_list: 'プロブレムリスト',
  support: '臨床支援',
  pending: '結果待ち',
  plans: '予定と実施',
  consult: '相談',
  ask: '記録に聞く',
  document: 'カルテ記載を出す',
  revise: 'カルテ記載を AI に頼む',
  order_transcribe: '指示簿の写し',
  order_propose: '指示簿の案',
};

/** 答えを預かる種類（保存しない答え：受け取るまで、確かめた後の答えを預かる。CA-088） */
export const HELD_JOB_KINDS: readonly JobKind[] = ['consult', 'ask', 'document', 'revise', 'order_transcribe', 'order_propose'];

/** 同じ相手に、同じ種類の仕事が動いていれば、新しく始めずに、その仕事につなぐ種類（保存する種類：二重に AI を呼ばない・二重に書かない） */
export const SHARED_JOB_KINDS: readonly JobKind[] = ['organize', 'problem_list', 'support', 'pending', 'plans'];

/** 受け取られない答えを預かる時間（時間）【仮の値】本人の決定は「受け取るまで預かってよい」。長く残さないための上限で、使って決める */
export const JOB_HOLD_HOURS = 24;

/** 仕事の相手：どの患者の・何についての仕事か（target は、文・受診・患者の id） */
export interface JobTarget {
  readonly kind: JobKind;
  readonly target: string;
  /** target が何の id か */
  readonly targetType: 'source' | 'encounter' | 'patient';
}

const PATTERNS: readonly (readonly [RegExp, (m: RegExpExecArray) => JobTarget | null])[] = [
  [/^\/api\/sources\/([^/]+)\/organize$/u, (m) => ({ kind: 'organize', target: m[1] ?? '', targetType: 'source' })],
  [/^\/api\/patients\/([^/]+)\/problem-list$/u, (m) => ({ kind: 'problem_list', target: m[1] ?? '', targetType: 'patient' })],
  [/^\/api\/patients\/([^/]+)\/support$/u, (m) => ({ kind: 'support', target: m[1] ?? '', targetType: 'patient' })],
  [/^\/api\/patients\/([^/]+)\/pending$/u, (m) => ({ kind: 'pending', target: m[1] ?? '', targetType: 'patient' })],
  [/^\/api\/patients\/([^/]+)\/plans$/u, (m) => ({ kind: 'plans', target: m[1] ?? '', targetType: 'patient' })],
  [/^\/api\/patients\/([^/]+)\/consult$/u, (m) => ({ kind: 'consult', target: m[1] ?? '', targetType: 'patient' })],
  [/^\/api\/patients\/([^/]+)\/ask$/u, (m) => ({ kind: 'ask', target: m[1] ?? '', targetType: 'patient' })],
  [/^\/api\/encounters\/([^/]+)\/documents\/(generate|revise)$/u, (m) => ({ kind: m[2] === 'revise' ? 'revise' : 'document', target: m[1] ?? '', targetType: 'encounter' })],
  [/^\/api\/encounters\/([^/]+)\/orders\/(transcribe|propose)$/u, (m) => ({ kind: m[2] === 'propose' ? 'order_propose' : 'order_transcribe', target: m[1] ?? '', targetType: 'encounter' })],
];

/** 仕事にできる頼みか（POST の、決めた道だけ）。できなければ null */
export function jobTargetOf(method: string, path: string): JobTarget | null {
  if (method !== 'POST') return null;
  for (const [re, make] of PATTERNS) {
    const m = re.exec(path);
    if (m !== null) return make(m);
  }
  return null;
}

/** 終わった仕事の答え（画面が受け取る形。status は HTTP の数、body はその答えの本文） */
export interface JobOutcome {
  readonly status: number;
  readonly body: unknown;
}

/**
 * 預かる答えにする：保存しない答えの種類は、そのまま（確かめた後の答え）。保存する種類は、中身を落とし、成否の名前だけ（結果は記録にある）。
 * 誤りの答えは、どの種類も、名前だけ
 */
export function heldOutcome(kind: JobKind, outcome: JobOutcome): JobOutcome {
  const error = typeof outcome.body === 'object' && outcome.body !== null ? (outcome.body as Record<string, unknown>)['error'] : undefined;
  if (outcome.status >= 400) return { status: outcome.status, body: { error: typeof error === 'string' ? error : 'server' } };
  return HELD_JOB_KINDS.includes(kind) ? outcome : { status: outcome.status, body: {} };
}

/** 動いている仕事の様子（画面が聞く）。events は、少しずつ出す答えの出来事（相談の段階と、確かめた後の文） */
export type JobProgress =
  | { readonly state: 'running'; readonly kind: JobKind; readonly events: readonly unknown[]; readonly next: number }
  | { readonly state: 'done'; readonly kind: JobKind; readonly outcome: JobOutcome }
  /** 知らない仕事（番号が違う・預かる時間を過ぎた・受け取った後・サーバーの仕事が途中で消えた） */
  | { readonly state: 'unknown' };

/** 患者の仕事の一覧の1つ（読み込み直したあと、受け取っていない答えと、動いている仕事を拾うため。中身は含めない） */
export interface JobSummary {
  readonly id: string;
  readonly kind: JobKind;
  readonly target: string;
  readonly state: 'running' | 'done';
  readonly status: number | null;
  readonly madeAt: string | null;
}
