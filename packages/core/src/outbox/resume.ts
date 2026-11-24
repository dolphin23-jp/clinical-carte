// 画面を離れて切れた整理を、戻ったときに続ける規則（CA-086）。純関数：時計・タイマーを持たない（いまの時刻は引数）。
// - iPhone でほかのアプリへ移ると、Safari が止まって、つながりが切れる。サーバーは、切れたあと 30 秒まで仕事を続けられる（Cloudflare の ctx.waitUntil。
//   資料の値。2026-11 確認）。なので、切れた整理は、サーバーが仕上げたかもしれない：猶予（RESUME_GRACE_MS）のあいだは待って記録を読み直し、
//   それでも整理されていなければ、画面が自動で続ける（同じ文を、もう一度整理する。1日の上限に数える）
// - 自動で続けるのは、1つの文に RESUME_ATTEMPTS 回まで（画面を開いているあいだ）。それでもだめなら、これまでどおり、記録の「整理する」を押す
// - 整理に失敗した文（organized = 'failed'：AI が断った・答えが読めない）は、自動で続けない（同じ失敗を繰り返さない）

/** 切れたあと、サーバーが仕事を続けられる時間（30 秒）に、余裕を足したもの（ミリ秒） */
export const RESUME_GRACE_MS = 35_000;
/** 1つの文を、自動で続ける回数の上限（画面を開いているあいだ） */
export const RESUME_ATTEMPTS = 2;

/** 画面が知っている、整理の頼みの様子 */
export type OrganizeJob =
  /** 頼んで、答えを待っている（auto は、自動で続けたもの） */
  | { readonly state: 'running'; readonly since: number; readonly auto: boolean }
  /** つながりが切れて、答えを受け取れなかった（at は、切れたと分かった時刻） */
  | { readonly state: 'lost'; readonly at: number }
  /** 答えを受け取った（整理できた・できなかった）。記録の読み直しが追いつくまで、頼み直さない */
  | { readonly state: 'finished' };

export interface ResumeInput {
  /** この患者の文（organized が null のものが、まだ整理されていない） */
  readonly sources: readonly { readonly id: string; readonly organized: string | null }[];
  readonly jobs: ReadonlyMap<string, OrganizeJob>;
  /** 自動で続けた回数（文ごと） */
  readonly attempts: ReadonlyMap<string, number>;
  readonly now: number;
}

export interface ResumePlan {
  /** いま自動で続ける文 */
  readonly run: readonly string[];
  /** サーバーが仕上げるのを待っている文（猶予のあいだ） */
  readonly waiting: readonly string[];
  /** 自動で続けている途中の文 */
  readonly resuming: readonly string[];
  /** 次に記録を読み直す時刻（待っている文があるとき） */
  readonly recheckAt: number | null;
}

/**
 * まだ整理されていない文ごとに、待つか・自動で続けるかを決める。
 * - 頼んで答えを待っている → 何もしない（自動で続けたものは resuming）
 * - 答えを受け取った → 何もしない（記録の読み直しが追いつくのを待つ。整理できなかったものは、先生が「整理する」を押す）
 * - 切れた → 猶予のあいだは待つ（recheckAt に読み直す）。猶予を過ぎたら、回数の上限まで続ける
 * - 画面が知らない（読み込み直した・送り待ちから送った）→ 回数の上限まで続ける（切れた整理か、まだ頼んでいない整理）
 */
export function resumeOrganize(input: ResumeInput): ResumePlan {
  const run: string[] = [];
  const waiting: string[] = [];
  const resuming: string[] = [];
  let recheckAt: number | null = null;
  for (const source of input.sources) {
    if (source.organized !== null) continue;
    const job = input.jobs.get(source.id);
    const tried = input.attempts.get(source.id) ?? 0;
    if (job?.state === 'running') {
      if (job.auto) resuming.push(source.id);
      continue;
    }
    if (job?.state === 'finished') continue;
    if (job?.state === 'lost' && input.now < job.at + RESUME_GRACE_MS) {
      waiting.push(source.id);
      recheckAt = Math.min(recheckAt ?? Number.POSITIVE_INFINITY, job.at + RESUME_GRACE_MS);
      continue;
    }
    if (tried < RESUME_ATTEMPTS) run.push(source.id);
  }
  return { run, waiting, resuming, recheckAt };
}
