// 常時表示の帯の文（AGENTS.md の 1：「写し・最新とは限らない」。docs/01 の 2：主の網は「打たない」）。
// 画面のどこにいても出す。消すボタンは作らない。文はここの1か所で、試験が固定する。
export const BANNER = {
  /** carte は診療の正本ではない（docs/11 の 3） */
  copy: '写しです。最新とは限りません（正本は病院のカルテ）',
  /** 入口で匿名化する（CA-003）。打った文は、そのまま AI に届く（CA-013） */
  noIdentifiers: '氏名・ID・生年月日・連絡先は入れない',
} as const;

export const BANNER_LINES: readonly string[] = [BANNER.copy, BANNER.noIdentifiers];
