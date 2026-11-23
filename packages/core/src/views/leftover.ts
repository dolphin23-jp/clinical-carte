// 振り分けられなかった字（段K1。CA-058 の A1。CA-060。2026-11-23 改訂）：保存した文のうち、どこにも振り分けられていない部分を、決定論で求める。純関数。保存しない。
//
// 「振り分けられた」とは：整理した事実（値・投薬・できごと・問題・経過の出来事）の場所と、
// 「その他」以外の区切り（主訴・現病歴・身体所見・検査・A・P など。記録の各記載で見出しの下に出し、いまの「背景」「最新の所見」でも字をそのまま出す）の場所。
// それ以外の字のうち、見出し・記号・時の語・値の項目名だけのもの、値の横の短い補足（「室内気」「不整」）を除いたものを、行ごとに返す。
// 消してはいない（記載には残る）。改訂の理由：区切りに分けられた身体所見などまで数えて、1つの記載で 50 か所になり、本当に振り分けられていない字が埋もれたため。
import { LAB_NAMES } from '../labs/catalog.gen.ts';
import { EXTRA_LAB_NAMES } from '../labs/extra-names.ts';
import { SEGMENT_LABEL_NAMES, SEGMENT_LABELS, type SegmentLabel } from '../organize/answer.ts';

/** 区切りとして振り分けられたとみなす種類（「その他」以外のすべて） */
export const QUOTED_SEGMENT_LABELS: readonly SegmentLabel[] = SEGMENT_LABELS.filter((l) => l !== 'other');

export interface CoveredSpan {
  readonly start: number;
  readonly end: number;
}

export interface Leftover {
  readonly start: number;
  readonly end: number;
}

/** 前後から除く字（空白・句読点・括弧・記号） */
const EDGE = String.raw`\s・、。，．,.:：;；()（）【】[\]「」『』〔〕<>＜＞\-ー―─—–‐*＊/／|｜•●◦▪■□◆◇◎○→⇒`;
const LEAD = new RegExp(`^[${EDGE}]+`, 'u');
const TAIL = new RegExp(`[${EDGE}]+$`, 'u');
/** 見出しだけの行（【現病歴】・S)・O：・#1 だけ など） */
const HEADING_ONLY = /^(?:[SOAP]|[SOAP]\/[SOAP]|[#＃]\d{0,3}|\d{1,2})$/u;
/** 行頭の見出し */
const PREFIX = /^(?:[SOAP](?:\/[SOAP])?[)）:：]|【[^】]{0,20}】)\s*/u;
/** 日時だけの字（「昨日 BT 38.4」の「昨日」など。値・できごとの日時として読まれたもの） */
const TIME_ONLY = /^(?:(?:一昨日|昨日|本日|今日|明日|前日|当日|翌日|昨夜|今朝|朝|昼|夕方?|夜間?|深夜|未明|午前|午後|入院時|来院時|到着時|現着時|搬送時|受診時|\d{1,2}[/月]\d{1,2}日?|\d{1,2}[:：]\d{2}|\d+日前|\d+時間前|\d+病日目?)[\s・、]*)+$/u;
/** 見出しの語（【現病歴】・既往歴：など。括弧と記号を除いた字で比べる） */
const HEADING_WORDS = new Set<string>([...Object.values(SEGMENT_LABEL_NAMES), '主訴', '現病歴', '既往歴', '内服', '内服薬', '常用薬', '生活歴', '家族歴', 'アレルギー', '身体所見', '検査', '検査所見', '画像', '画像所見', '評価', '方針', '計画', '経過', 'プロブレムリスト', '申し送り', '項目', '値', '項目値', '項目値項目値', 'バイタル', 'バイタルサイン', 'ベッドサイド検査', '血液検査', '動脈血ガス', '血液ガス', '意識', '血圧', '脈拍', '心拍数', '呼吸数', '体温', '体重', '身長', 'SpO2', 'SpO₂']);
/** 値の項目名だけの字（「血圧」「SpO₂」。表の左の列。値は事実として読まれている） */
const LAB_LABELS = new Set<string>([...LAB_NAMES, ...EXTRA_LAB_NAMES].flatMap((e) => [e.name, ...e.aliases]).map((n) => n.normalize('NFKC').replace(/\s+/g, '').toLowerCase()));
/** 番号つきの短い見出しの行（「1. S（家族からの聴取」「0. 受け入れ要請（…」） */
const NUMBERED_HEADING = /^\d{1,2}[.．]\s*[^。]{1,30}[（(]/u;
/** 値の横の短い補足として、数えない長さ（同じ行に振り分けられた字があるときだけ） */
const SHORT_BESIDE = 4;

/** 振り分けられなかった字の場所（行ごと。見出し・記号だけのもの、1字だけのものは除く） */
export function leftovers(text: string, covered: readonly CoveredSpan[]): Leftover[] {
  const mark = new Uint8Array(text.length);
  for (const c of covered) {
    const s = Math.max(0, Math.min(text.length, c.start));
    const e = Math.max(s, Math.min(text.length, c.end));
    mark.fill(1, s, e);
  }
  const out: Leftover[] = [];
  const lineHasCovered = (from: number, to: number): boolean => {
    const ls = text.lastIndexOf('\n', from - 1) + 1;
    const nl = text.indexOf('\n', to);
    const le = nl < 0 ? text.length : nl;
    for (let i = ls; i < le; i += 1) if (mark[i] === 1) return true;
    return false;
  };
  const push = (from: number, to: number) => {
    const piece = text.slice(from, to);
    // 行頭の見出し（「S)」「O：」「【現病歴】」）と記号は、字に数えない
    const lead = piece.length - piece.replace(LEAD, '').replace(PREFIX, '').replace(LEAD, '').length;
    const body = piece.slice(lead).replace(TAIL, '');
    if (Array.from(body).length < 2 || HEADING_ONLY.test(body) || HEADING_WORDS.has(body) || HEADING_WORDS.has(body.replace(/\s+/g, '')) || TIME_ONLY.test(body) || /^【[^】]{0,20}】$/u.test(piece.trim())) return;
    if (LAB_LABELS.has(body.normalize('NFKC').replace(/\s+/g, '').toLowerCase())) return;
    if (NUMBERED_HEADING.test(body)) return;
    // 同じ行に振り分けられた字がある、短い補足（「SpO2 81%（室内気）」の「室内気」）
    if (Array.from(body).length <= SHORT_BESIDE && lineHasCovered(from, to)) return;
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
