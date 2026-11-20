import { describe, expect, test } from 'vitest';

import { ageNow, compareDateTime, daysBetween, headline, hospitalDay, isDateTime, NewPatient, NewSource, TEXT_LIMIT, timeOf } from '../src/index.ts';

describe('日時', () => {
  test('日、または、日と時刻（分まで）だけ', () => {
    expect(isDateTime('2026-11-20')).toBe(true);
    expect(isDateTime('2026-11-20T08:30')).toBe(true);
    for (const bad of ['2026-11-20T24:00', '2026-11-20T8:30', '2026-11-20 08:30', '2026-11-20T08:30:00', '2026-02-30T08:30', '', null, 1]) expect(isDateTime(bad)).toBe(false);
    expect(timeOf('2026-11-20T08:30')).toBe('08:30');
    expect(timeOf('2026-11-20')).toBeNull();
  });
  test('並べる順：古い順。日時のないものは最後', () => {
    const list = ['2026-11-21', null, '2026-11-20T09:00', '2026-11-20', '2026-11-20T08:00'];
    expect([...list].sort(compareDateTime)).toEqual(['2026-11-20', '2026-11-20T08:00', '2026-11-20T09:00', '2026-11-21', null]);
  });
  test('日数と病日（入院の日が第1病日）', () => {
    expect(daysBetween('2026-11-18', '2026-11-20')).toBe(2);
    expect(hospitalDay('2026-11-18T22:10', '2026-11-18')).toBe(1);
    expect(hospitalDay('2026-11-18T22:10', '2026-11-20T06:00')).toBe(3);
    expect(hospitalDay('2026-11-18', '2026-11-17')).toBeNull();
  });
});

describe('自動の見出し（CA-014）', () => {
  test('年齢・性別・いちばん新しい受診。呼び名・病室は持たない', () => {
    expect(headline({ age: 72, ageOn: '2026-11-18', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-18T22:10', end: null } }, '2026-11-20')).toBe('72歳 男 ｜ 入院 2026-11-18〜');
    expect(headline({ age: 72, ageOn: '2026-11-18', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-18', end: '2026-12-01T10:00' } }, '2026-12-02')).toBe('72歳 男 ｜ 入院 2026-11-18〜2026-12-01');
    expect(headline({ age: 58, ageOn: '2026-11-20', sex: 'female', encounter: { kind: 'outpatient', start: '2026-11-20' } as never }, '2026-11-20')).toBe('58歳 女 ｜ 外来 2026-11-20');
    expect(headline({ age: 0, ageOn: '2026-11-20', sex: 'other', encounter: null }, '2026-11-20')).toBe('0歳 性別その他・不明');
  });
  test('いまの年齢は概算：記録した日からの満年数を足す。さかのぼって入れたときは、記録した年齢のまま', () => {
    expect(ageNow(72, '2026-11-18', '2027-11-17')).toBe(72);
    expect(ageNow(72, '2026-11-18', '2027-11-19')).toBe(73);
    expect(ageNow(72, '2026-11-18', '2031-12-01')).toBe(77);
    expect(ageNow(72, '2026-11-18', '2025-01-01')).toBe(72);
  });
});

describe('入力の形', () => {
  const patient = { age: 72, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-20T10:00' } };
  test('患者：年齢・性別・最初の受診だけ。名前・ID・生年月日の欄は、受け付けない', () => {
    expect(NewPatient.safeParse(patient).success).toBe(true);
    for (const extra of [{ name: 'x' }, { id: '1' }, { birth: ['1954', '01', '01'].join('-') }, { room: '512' }, { label: 'x' }]) {
      expect(NewPatient.safeParse({ ...patient, ...extra }).success, Object.keys(extra)[0]).toBe(false);
    }
    expect(NewPatient.safeParse({ ...patient, age: 131 }).success).toBe(false);
    expect(NewPatient.safeParse({ ...patient, age: 72.5 }).success).toBe(false);
    expect(NewPatient.safeParse({ ...patient, ageOn: '2026-02-30' }).success).toBe(false);
  });
  test('取り込む文：種類・著者の役割・日時（なければ null）・文', () => {
    const source = { kind: 'progress_note', authorRole: 'self', at: '2026-11-20T09:00', text: '解熱。' };
    expect(NewSource.safeParse(source).success).toBe(true);
    expect(NewSource.safeParse({ ...source, at: null }).success).toBe(true);
    expect(NewSource.safeParse({ ...source, text: '' }).success).toBe(false);
    expect(NewSource.safeParse({ ...source, text: 'あ'.repeat(TEXT_LIMIT + 1) }).success).toBe(false);
    expect(NewSource.safeParse({ ...source, author: 'x' }).success).toBe(false);
    expect(NewSource.safeParse({ ...source, at: '2026-11-20 09:00' }).success).toBe(false);
  });
});
