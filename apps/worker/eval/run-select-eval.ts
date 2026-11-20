// 選別の評価を、手元の計算機で動かす（開発用。架空の文だけを、Anthropic の API に送る）。
// 本人は、carte の画面の「選別の評価」から、配ってあるサーバーの鍵・指示・モデルで動かす（src/selfcheck.ts）。
//
//   node eval/run-select-eval.ts --dry-run            … 何を送るかの数だけを出す（通信しない）
//   node eval/run-select-eval.ts --oracle             … 答えを知っている代役で、道具そのものを確かめる（通信しない）
//   ANTHROPIC_API_KEY=… node eval/run-select-eval.ts --local [--model claude-opus-5-5] [--seeds 3]
//                                                     … 本物の API で測る（鍵は、環境変数だけ。画面・ファイル・リポジトリに出さない）
//
// 出すのは、数と、文の id だけ（文そのもの・AI の答えは出さない）。目標は、漏れ 0。
import { createAnthropicSelector, DEFAULT_MODEL } from '../src/anthropic.ts';
import { SELECT_PROMPT_VERSION } from '../src/prompt.ts';
import type { Selector } from '../src/selector.ts';
import { CASES } from './cases.ts';
import { build, type BuiltCase, type CaseScore, checkCases, oracleSelector, score, summarize } from './lib.ts';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const cases = checkCases(CASES);
const seeds = Math.max(1, Math.min(10, Number(option('--seeds') ?? '1') || 1));
const built: BuiltCase[] = [];
for (let seed = 1; seed <= seeds; seed++) for (const c of cases) built.push(build(c, seed * 1000 + cases.indexOf(c)));

if (flag('--dry-run')) {
  out(`文 ${String(built.length)} 件（${String(cases.length)} 種 × 種 ${String(seeds)}）、合わせて ${String(built.reduce((n, b) => n + b.text.length, 0))} 字。混ぜた識別情報 ${String(built.reduce((n, b) => n + b.planted.length, 0))} か所。`);
  out(`指示の版：${SELECT_PROMPT_VERSION}。通信はしていません。`);
  process.exit(0);
}

let selector: Selector;
let label: string;
if (flag('--oracle')) {
  selector = oracleSelector(cases);
  label = '答えを知っている代役（通信なし）';
} else if (flag('--local')) {
  const apiKey = process.env['ANTHROPIC_API_KEY']?.trim() ?? '';
  if (apiKey === '') {
    process.stderr.write('環境変数 ANTHROPIC_API_KEY がありません。\n');
    process.exit(2);
  }
  const model = option('--model') ?? DEFAULT_MODEL;
  selector = createAnthropicSelector({ apiKey, model });
  label = `Anthropic の API（${model}）`;
} else {
  process.stderr.write('使い方：--dry-run ｜ --oracle ｜ --local [--model <名前>] [--seeds <1〜10>]\n');
  process.exit(2);
}

const scores: CaseScore[] = [];
for (const b of built) scores.push(await score(b, selector));
const s = summarize(scores);
out(`選別の評価：${label}、指示の版 ${SELECT_PROMPT_VERSION}`);
out(`文 ${String(s.cases)} 件`);
out(`  漏れ（識別情報が残った）：${String(s.leakedCases)} 件・${String(s.leakedSlots)} か所  ← 目標 0`);
out(`  選別が通らなかった（保存されない）：${String(s.failed)} 件`);
out(`  指しすぎ（残すべき語が消えた）：${String(s.lostCases)} 件`);
out(`  混ぜた場所のほかも置き換えた：${String(s.inexact)} 件`);
for (const x of scores) {
  const notes = [x.failed === null ? null : `通らず(${x.failed})`, x.leaked.length > 0 ? `漏れ[${x.leaked.join(',')}]` : null, x.lost.length > 0 ? `消えた語 ${String(x.lost.length)}` : null, x.exact === false ? 'ほかも置き換え' : null].filter((n) => n !== null);
  if (notes.length > 0) out(`  - ${x.id}：${notes.join('、')}`);
}
process.exit(s.leakedSlots > 0 ? 1 : 0);
