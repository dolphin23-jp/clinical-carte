// 基準範囲の印（段K3。CA-059）の見せ方：H・L の字と色。色だけに頼らず、字と、押したときの範囲・出典で示す。判定は core の referenceMark の1か所。
import { rangeText, REFERENCE_CONFIRMED, type ReferenceMark, referenceMark, type Sex } from '@clinical-carte/core';

export interface RefPatient {
  readonly age: number;
  readonly sex: Sex;
}

export const refLetter = (m: ReferenceMark): string => (m.state === 'high' ? 'H' : m.state === 'low' ? 'L' : '');
export const refClass = (m: ReferenceMark): string => (m.state === 'high' ? 'ref-high' : m.state === 'low' ? 'ref-low' : '');

/** 本人が施設の範囲と照らして確かめるまで、未確認の目安と添える */
const REFERENCE_NOTE_SHORT: string = (REFERENCE_CONFIRMED as boolean) ? '' : '。未確認の目安';

/** 押したとき・指を置いたときに出す説明（範囲・出典・未確認） */
export function refTitle(m: ReferenceMark): string {
  if (m.range === null) return '';
  return `基準範囲 ${rangeText(m)}（${m.source?.title.split('（')[0] ?? '出典'}${REFERENCE_NOTE_SHORT}）`;
}

export const markFor = (v: { name: string | null; value: number | null; comparator: string | null; unit: string | null }, patient: RefPatient | null): ReferenceMark | null => (patient === null ? null : referenceMark(v, patient));

export const REF_NOTE = 'H・L は、基準範囲（JCCLS 共用基準範囲 2022。健常者の中央 95%で、臨床判断値ではありません）の外の値です。未確認の目安で、施設の範囲と違うことがあります。単位が表と違う値・単位のない WBC・RBC・Plt・18歳未満には付けていません。';
