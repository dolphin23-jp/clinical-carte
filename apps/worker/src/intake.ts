// 取り込み（docs/00 の 5、docs/01 の 2）：打った文 → 整え → AI の選別（場所を指す）→ 決定論の置き換え → 形の検査 → 測定値の読み取り。
// **選別を通っていない文を、返さない**（保存するのは、ここが返した文だけ）。打った文そのものは、保存もログもしない。
// 整理（段2）は、保存のあとに、別の要求で行う（organize.ts。整理に失敗しても、文は保存されている）。
import { applySelection, cleanText, findShapes, type LabRow, type NewSource, READ_VALUES_KINDS, readLabText, replaceShapes, type SelectionProblem } from '@clinical-carte/core';

import type { Selector, SelectorFailure } from './selector.ts';

export type IntakeResult =
  | {
      readonly ok: true;
      /** 識別情報の場所を置き換えた後の文（保存する文） */
      readonly text: string;
      /** 置き換えた種類ごとの件数（整数だけ） */
      readonly replaced: Readonly<Record<string, number>>;
      /** 文字から読んだ測定値（種類が検査結果・バイタルのときだけ） */
      readonly rows: readonly LabRow[];
    }
  | { readonly ok: false; readonly reason: 'empty' }
  | { readonly ok: false; readonly reason: 'ai'; readonly failure: SelectorFailure }
  | { readonly ok: false; readonly reason: 'selection'; readonly problems: readonly SelectionProblem[] };

export async function intake(input: NewSource, selector: Selector): Promise<IntakeResult> {
  const clean = cleanText(input.text);
  if (clean === '') return { ok: false, reason: 'empty' };

  const selected = await selector.select(clean);
  if (!selected.ok) return { ok: false, reason: 'ai', failure: selected.reason };

  const applied = applySelection(clean, selected.answer);
  if (!applied.ok) return { ok: false, reason: 'selection', problems: applied.problems };

  // 最後の網：形で分かるもの（電話・メール・郵便番号・長い数字）が残っていれば、その場所だけを置き換える
  const shaped = replaceShapes(applied.text);
  // 置き換えた後の文に、形が残っていないこと（置き換えの語が、新しい形を作っていないこと）を確かめる
  if (findShapes(shaped.text).length > 0) return { ok: false, reason: 'selection', problems: ['bad_shape'] };

  const replaced: Record<string, number> = {};
  for (const [kind, n] of [...Object.entries(applied.counts), ...Object.entries(shaped.counts)]) if (n > 0) replaced[kind] = n;

  const rows = READ_VALUES_KINDS.includes(input.kind) ? readLabText(shaped.text).rows : [];
  return { ok: true, text: shaped.text, replaced, rows };
}
