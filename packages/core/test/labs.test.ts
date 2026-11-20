// 検査値・バイタルを、文字から読む（AI を使わない）。値は架空。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { EXTRA_LAB_NAMES, LAB_NAMES, type LabRow, readLabText } from '../src/index.ts';

const brief = (rows: readonly LabRow[]): string[] => rows.map((r) => `${r.name ?? `?${r.nameRaw}`}=${r.comparator ?? ''}${r.valueText}${r.unit === null ? '' : ` ${r.unit}`}`);

describe('読めるもの', () => {
  test('名前と値を並べる（空白・改行・カンマ・読点で区切る）', () => {
    const r = readLabText('WBC 12.3 Hb 8.2, Plt 8.5、CRP 12.3\nNa 128 K 3.1 Cr 1.8');
    expect(brief(r.rows)).toEqual(['WBC=12.3', 'Hb=8.2', 'Plt=8.5', 'CRP=12.3', 'Na=128', 'K=3.1', 'Cr=1.8']);
    expect(r.unread).toEqual([]);
    expect(r.rows.find((x) => x.name === 'Na')).toMatchObject({ value: 128, kind: 'lab', nameRaw: 'Na' });
  });

  test('空白がなくても読める。全角でも読める。名前は書かれたまま残す', () => {
    expect(brief(readLabText('Na128K3.1').rows)).toEqual(['Na=128', 'K=3.1']);
    const wide = readLabText('ＷＢＣ １２．３');
    expect(wide.rows).toHaveLength(1);
    // 値は、書かれたまま（全角）を残し、数としても読む
    expect(wide.rows[0]).toMatchObject({ name: 'WBC', nameRaw: 'ＷＢＣ', valueText: '１２．３', value: 12.3 });
  });

  test('最長一致（PT-INR は PT より先）と、別名（正規の名前にそろえる）', () => {
    const r = readLabText('PT-INR 1.2 PT 12.5 脈拍 110 BT 38.5');
    expect(r.rows.map((x) => x.name)).toEqual(['PT-INR', 'PT', '心拍数', '体温']);
    expect(r.rows.map((x) => x.nameRaw)).toEqual(['PT-INR', 'PT', '脈拍', 'BT']);
  });

  test('血圧は、収縮期と拡張期の2行にする', () => {
    const r = readLabText('BP 78/40 HR 110');
    expect(brief(r.rows)).toEqual(['収縮期血圧=78', '拡張期血圧=40', '心拍数=110']);
    expect(r.rows[0]).toMatchObject({ value: 78, nameRaw: 'BP', kind: 'vital' });
  });

  test('単位は、書かれたものだけ（補わない・換算しない）', () => {
    const r = readLabText('WBC 12300 /μL CRP 12.3mg/dL Hb 8.2 SpO2 92%');
    expect(r.rows.map((x) => x.unit)).toEqual(['/μL', 'mg/dL', null, '%']);
    expect(r.rows[0]?.value).toBe(12300);
  });

  test('不等号つきの値を、書かれたとおりに持つ', () => {
    const r = readLabText('CRP <0.1 TnI > 50 PCT ≦0.05');
    expect(r.rows.map((x) => [x.comparator, x.value])).toEqual([
      ['<', 0.1],
      ['>', 50],
      ['<=', 0.05],
    ]);
    expect(r.unread).toEqual([]);
  });

  test('定性の結果を、書かれたとおりに持つ（数にしない）', () => {
    const r = readLabText('尿蛋白 2+ 尿潜血 (-) 尿糖 ± HBs抗原 陰性');
    expect(r.rows.map((x) => [x.valueText, x.value])).toEqual([
      ['2+', null],
      ['(-)', null],
      ['±', null],
      ['陰性', null],
    ]);
  });

  test('負の数は、数として読む（定性の「-」と取り違えない）', () => {
    expect(readLabText('BE -3.2').rows[0]).toMatchObject({ value: -3.2, valueText: '-3.2' });
  });

  test('桁区切りのカンマ', () => {
    expect(readLabText('WBC 12,300').rows[0]).toMatchObject({ value: 12300, valueText: '12,300' });
  });

  test('カタログにない名前は、「名前: 値」「名前=値」と書いたときだけ読む（書かれた名前のまま）', () => {
    const r = readLabText('架空マーカー: 12.3 別の項目=陽性 これは 5');
    expect(brief(r.rows)).toEqual(['?架空マーカー=12.3', '?別の項目=陽性']);
    expect(r.rows[0]).toMatchObject({ name: null, kind: null, value: 12.3 });
    expect(r.unread.map((u) => u.reason)).toEqual(['unknown']);
  });
});

describe('読まないもの（黙って捨てず、理由つきで返す）', () => {
  const read = (text: string) => {
    const r = readLabText(text);
    return { rows: brief(r.rows), unread: r.unread.map((u) => [u.reason, text.slice(u.start, u.end)]) };
  };

  test('名前のない語・文', () => {
    expect(read('昨日より改善 WBC 9.8')).toEqual({ rows: ['WBC=9.8'], unread: [['unknown', '昨日より改善']] });
  });
  test('値のない名前', () => {
    expect(read('CRP 上昇')).toEqual({ rows: [], unread: [['no_value', 'CRP'], ['unknown', '上昇']] });
  });
  test('値の後ろに読めない文字（一部だけ読んで、残りを捨てない）', () => {
    expect(read('Na 1e3 K 3.1')).toEqual({ rows: ['K=3.1'], unread: [['trailing', 'Na 1e3']] });
  });
  test('血圧の書き方が違う', () => {
    expect(read('BP 78')).toEqual({ rows: [], unread: [['bad_pair', 'BP'], ['unknown', '78']] });
  });
  test('不等号の後ろに数がない', () => {
    expect(read('CRP < 上限')).toMatchObject({ rows: [], unread: [['bad_comparator', 'CRP <'], ['unknown', '上限']] });
  });
  test('語の途中の名前は読まない（「Kg」の K、「mmHg」の Hg）', () => {
    expect(read('60Kg').rows).toEqual([]);
    expect(read('SpK 3').rows).toEqual([]);
  });
});

describe('性質', () => {
  const unit = fc.constantFrom('N', 'a', 'K', 'W', 'B', 'C', 'P', '1', '2', '8', '.', ' ', '\n', ',', '/', '<', '+', '-', '(', ')', ':', '=', '熱', '尿', '蛋', '白', '%');

  test('黙って捨てない：文のすべての文字は、行の範囲・読めなかった部分の範囲・区切りのどれかに入る', () => {
    fc.assert(
      fc.property(fc.string({ unit, maxLength: 60 }), (text) => {
        const r = readLabText(text);
        const covered = new Array<boolean>(text.length).fill(false);
        for (const s of [...r.rows, ...r.unread]) for (let i = s.start; i < s.end; i++) covered[i] = true;
        for (let i = 0; i < text.length; i++) {
          if (!covered[i]) expect([' ', '\n', ',', '、', ';', '。', ':', '=', '　'], `位置 ${String(i)}「${text}」`).toContain(text[i]);
        }
      }),
      { numRuns: 500 },
    );
  });

  test('行と、読めなかった部分は、文の範囲の中にあり、後戻りしない', () => {
    fc.assert(
      fc.property(fc.string({ unit, maxLength: 60 }), (text) => {
        const r = readLabText(text);
        const spans = [...r.rows, ...r.unread].sort((a, b) => a.start - b.start || a.end - b.end);
        let last = 0;
        for (const s of spans) {
          expect(s.start).toBeGreaterThanOrEqual(0);
          expect(s.end).toBeLessThanOrEqual(text.length);
          expect(s.end).toBeGreaterThan(s.start);
          // 血圧の2行だけは、同じ範囲を持つ
          expect(s.start >= last || spans.some((o) => o !== s && o.start === s.start && o.end === s.end)).toBe(true);
          last = Math.max(last, s.end);
        }
      }),
      { numRuns: 500 },
    );
  });

  test('読んだ数は、文に書かれた数字そのもの（作らない）', () => {
    fc.assert(
      fc.property(fc.string({ unit, maxLength: 60 }), (text) => {
        for (const row of readLabText(text).rows) {
          expect(text.slice(row.start, row.end)).toContain(row.valueText);
          if (row.value !== null) expect(Number(row.valueText.replace(/,/g, ''))).toBe(row.value);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('取り込んだ名前（Playbook のカタログ）', () => {
  test('すべての名前・別名が、その名前の項目として読める', () => {
    const failed: string[] = [];
    for (const entry of [...LAB_NAMES, ...EXTRA_LAB_NAMES]) {
      for (const n of [entry.name, ...entry.aliases]) {
        const row = readLabText(`${n} 1`).rows[0];
        if (row?.name !== entry.name || row.valueText !== '1') failed.push(n);
      }
    }
    expect(failed).toEqual([]);
  });

  test('carte で足した名前は、取り込んだ名前・別名と重ならない', () => {
    const key = (n: string): string => n.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    const seen = new Set<string>();
    const twice: string[] = [];
    for (const entry of [...LAB_NAMES, ...EXTRA_LAB_NAMES]) {
      for (const n of [entry.name, ...entry.aliases]) {
        if (seen.has(key(n))) twice.push(n);
        seen.add(key(n));
      }
    }
    expect(twice).toEqual([]);
  });

  test('判定に使うもの（基準範囲・ありうる範囲・倍率）を、取り込んでいない', () => {
    const keys = new Set([...LAB_NAMES, ...EXTRA_LAB_NAMES].flatMap((e) => Object.keys(e)));
    expect([...keys].sort()).toEqual(['aliases', 'group', 'kind', 'name', 'units']);
  });
});
