// 振り分けられなかった字（段K1。CA-058 の A1）：保存した文のうち、どの見方にも出ていない部分を、決定論で求める。純関数。保存しない。
//
// 「見方に出ている」とは：整理した事実（値・投薬・できごと・問題・経過の出来事）の場所と、
// 区切りの引用で出すもの（背景・A・P。いま・問題のタブが、区切りの字をそのまま出す）の場所。
// それ以外の字のうち、見出し・記号だけの行を除いたものを、行ごとに返す。消してはいない（記載には残る）。
import { SEGMENT_LABEL_NAMES, type SegmentLabel } from '../organize/answer.ts';
import { BACKGROUND_LABELS } from './state.ts';

/** 区切りの字をそのまま見方に出す種類（いまの背景・問題の A・P・記載全体の P） */
export const QUOTED_SEGMENT_LABELS: readonly SegmentLabel[] = [...BACKGROUND_LABELS, 'assessment', 'plan', 'assessment_plan'];

export interface CoveredSpan {
  readonly start: number;
  readonly end: number;
}

export interface Leftover {
  readonly start: number;
  readonly end: number;
}

/** 前後から除く字（空白・句読点・括弧・記号） */
const EDGE = String.raw`\s・、。，．,.:：;；()（）【】[\]「」『』〔〕<>＜＞\-ー―─—*＊/／|｜`;
const LEAD = new RegExp(`^[${EDGE}]+`, 'u');
const TAIL = new RegExp(`[${EDGE}]+$`, 'u');
/** 見出しだけの行（【現病歴】・S)・O：・#1 だけ など） */
const HEADING_ONLY = /^(?:[SOAP]|[SOAP]\/[SOAP]|[#＃]\d{0,3}|\d{1,2})$/u;
/** 行頭の見出し */
const PREFIX = /^(?:[SOAP](?:\/[SOAP])?[)）:：]|【[^】]{0,20}】)\s*/u;
/** 日時だけの字（「昨日 BT 38.4」の「昨日」など。値・できごとの日時として読まれたもの） */
const TIME_ONLY = /^(?:(?:一昨日|昨日|本日|今日|明日|昨夜|今朝|朝|昼|夕方?|夜間?|深夜|未明|午前|午後|入院時|来院時|\d{1,2}[/月]\d{1,2}日?|\d{1,2}[:：]\d{2}|\d+日前|\d+時間前|\d+病日目?)[\s・、]*)+$/u;
/** 見出しの語（【現病歴】・既往歴：など。括弧と記号を除いた字で比べる） */
const HEADING_WORDS = new Set<string>([...Object.values(SEGMENT_LABEL_NAMES), '主訴', '現病歴', '既往歴', '内服', '内服薬', '常用薬', '生活歴', '家族歴', 'アレルギー', '身体所見', '検査', '検査所見', '画像', '画像所見', '評価', '方針', '計画', '経過', 'プロブレムリスト', '申し送り']);

/** 振り分けられなかった字の場所（行ごと。見出し・記号だけのもの、1字だけのものは除く） */
export function leftovers(text: string, covered: readonly CoveredSpan[]): Leftover[] {
  const mark = new Uint8Array(text.length);
  for (const c of covered) {
    const s = Math.max(0, Math.min(text.length, c.start));
    const e = Math.max(s, Math.min(text.length, c.end));
    mark.fill(1, s, e);
  }
  const out: Leftover[] = [];
  const push = (from: number, to: number) => {
    const piece = text.slice(from, to);
    // 行頭の見出し（「S)」「O：」「【現病歴】」）と記号は、字に数えない
    const lead = piece.length - piece.replace(LEAD, '').replace(PREFIX, '').replace(LEAD, '').length;
    const body = piece.slice(lead).replace(TAIL, '');
    if (Array.from(body).length < 2 || HEADING_ONLY.test(body) || HEADING_WORDS.has(body) || TIME_ONLY.test(body) || /^【[^】]{0,20}】$/u.test(piece.trim())) return;
    out.push({ start: from + lead, end: from + lead + body.length });
  };
  let from = -1;
  for (let i = 0; i <= text.length; i += 1) {
    const free = i < text.length && mark[i] === 0 && text[i] !== '\n' && text[i] !== '\r';
    if (free && from < 0) from = i;
    else if (!free && from >= 0) {
      push(from, i);
      from = -1;
    }
  }
  return out;
}
