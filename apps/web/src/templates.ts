// 入力を手軽にするための、ひな形と項目の並び（臨床の値は持たない：見出しと、項目の名前だけ）。
// 項目の名前は、値の読み取り（core の readLabText）が読める名前だけ（試験 test/templates.test.ts が確かめる）。
import type { SourceKind } from '@clinical-carte/core';

/** よく使う種類（チップで出す。ほかは「ほかの種類」から選ぶ） */
export const COMMON_KINDS: readonly SourceKind[] = ['progress_note', 'vital', 'lab', 'admission_note', 'er_note', 'nursing', 'memo', 'unsorted'];

/** チップに出す、短い名前 */
export const KIND_CHIP_LABELS: Partial<Record<SourceKind, string>> = {
  progress_note: '経過',
  vital: 'バイタル',
  lab: '検査結果',
  admission_note: '入院時',
  er_note: '救急',
  nursing: '看護',
  memo: 'メモ',
  unsorted: '未分類',
};

export interface Template {
  readonly label: string;
  readonly text: string;
}

const lines = (...items: string[]): string => `${items.join('\n')}\n`;

/** 種類ごとの、見出しのひな形（欄に差し込む。中身は、本人が書く） */
export const TEMPLATES: Partial<Record<SourceKind, readonly Template[]>> = {
  progress_note: [
    { label: 'SOAP', text: lines('S) ', 'O) ', 'A) ', 'P) ') },
    { label: '#問題', text: '#1 ' },
  ],
  admission_note: [
    { label: '入院時の見出し', text: lines('【主訴】', '【現病歴】', '【既往歴】', '【内服】', '【アレルギー】', '【生活歴】', '【家族歴】', '【身体所見】', '【検査】', '【アセスメント】', '【プラン】') },
    { label: '#問題', text: '#1 ' },
  ],
  er_note: [{ label: '救急の見出し', text: lines('【主訴】', '【現病歴】', '【既往歴】', '【内服】', '【身体所見】', '【検査】', '【評価】', '【方針】') }],
  outpatient_first: [{ label: '初診の見出し', text: lines('【主訴】', '【現病歴】', '【既往歴】', '【内服】', '【身体所見】', '【検査】', '【評価】', '【方針】') }],
  outpatient_revisit: [{ label: 'SOAP', text: lines('S) ', 'O) ', 'A) ', 'P) ') }],
  interim_summary: [{ label: '中間サマリーの見出し', text: lines('【診断】', '【入院までの経過】', '【入院後の経過】', '【現在の問題】', '【今後の方針】') }],
  discharge_summary: [{ label: '退院サマリーの見出し', text: lines('【診断】', '【主訴】', '【入院までの経過】', '【入院後の経過】', '【退院時処方】', '【転帰】', '【退院後の方針】') }],
  memo: [{ label: '迷い・仮説', text: lines('考えたこと：', '迷ったこと：', '次に確かめること：') }],
};

export interface QuickField {
  /** 文にするときの名前（読み取りが読める名前） */
  readonly name: string;
  /** 欄の見出し */
  readonly label: string;
  readonly unit: string;
}

/** バイタルの入力欄（血圧は、上と下の2つの欄） */
export const VITAL_FIELDS: readonly QuickField[] = [
  { name: 'BT', label: '体温', unit: '℃' },
  { name: 'HR', label: '心拍数', unit: '/分' },
  { name: 'SBP', label: '血圧（上）', unit: 'mmHg' },
  { name: 'DBP', label: '血圧（下）', unit: 'mmHg' },
  { name: 'RR', label: '呼吸数', unit: '/分' },
  { name: 'SpO2', label: 'SpO2', unit: '%' },
  { name: 'O2', label: '酸素', unit: 'L/分' },
];

export interface LabSet {
  readonly label: string;
  readonly items: readonly string[];
}

/** 検査値の入力欄の組（よく出る項目。足りない項目は、文の欄に打つ） */
export const LAB_SETS: readonly LabSet[] = [
  { label: '血算', items: ['WBC', 'Hb', 'Plt'] },
  { label: '生化学', items: ['TP', 'Alb', 'AST', 'ALT', 'LDH', 'ALP', 'γ-GTP', 'T-Bil', 'BUN', 'Cr', 'eGFR', 'Na', 'K', 'Cl', 'Ca', 'Glu', 'CRP'] },
  { label: '凝固', items: ['PT-INR', 'APTT', 'Fib', 'D-dimer'] },
  { label: '血ガス', items: ['pH', 'PaO2', 'PaCO2', 'HCO3-', 'BE', 'Lac'] },
  { label: '心筋・炎症', items: ['CK', 'hs-TnT', 'BNP', 'PCT'] },
];

/** 欄に入れた値：数（小数）か、不等号つきの数 */
export const QUICK_VALUE = /^[<>≦≧]?\s*\d+(?:\.\d+)?$/u;

/** 全角の数字・記号を半角に（iPhone の日本語の入力で、全角になることがある） */
export function halfWidth(text: string): string {
  return text.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
}

/**
 * 欄の値から、文を作る（「BT 37.2 HR 88 BP 120/80 SpO2 97%」）。空の欄は書かない（補わない）。
 * 血圧は、上と下の両方があれば「BP 上/下」、片方だけなら「SBP 上」「DBP 下」。
 * 形の違う値があれば、その欄の名前を返す（文は作らない）。
 */
export function composeValues(fields: readonly QuickField[] | readonly string[], values: Readonly<Record<string, string>>): { text: string } | { bad: string[] } {
  const named = fields.map((f) => (typeof f === 'string' ? { name: f, label: f, unit: '' } : f));
  const bad: string[] = [];
  const filled = new Map<string, string>();
  for (const f of named) {
    const v = halfWidth(values[f.name] ?? '');
    if (v === '') continue;
    if (!QUICK_VALUE.test(v)) bad.push(f.label);
    else filled.set(f.name, v.replace(/\s+/g, ''));
  }
  if (bad.length > 0) return { bad };
  const parts: string[] = [];
  for (const f of named) {
    const v = filled.get(f.name);
    if (v === undefined) continue;
    if (f.name === 'SBP' && filled.has('DBP')) {
      parts.push(`BP ${v}/${filled.get('DBP') ?? ''}`);
      continue;
    }
    if (f.name === 'DBP' && filled.has('SBP')) continue;
    parts.push(f.name === 'SpO2' ? `SpO2 ${v}%` : `${f.name} ${v}`);
  }
  return { text: parts.join(' ') };
}

/** 欄の、カーソルの位置に文を差し込む（前後の改行を整える）。新しい文と、カーソルの位置を返す */
export function insertAt(text: string, start: number, end: number, insert: string): { text: string; cursor: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const glue = before === '' || before.endsWith('\n') || insert.startsWith(' ') ? '' : insert.includes('\n') ? '\n' : ' ';
  const next = before + glue + insert + after;
  return { text: next, cursor: (before + glue + insert).length };
}
