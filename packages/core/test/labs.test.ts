// 検査値・バイタルを、文字から読む（AI を使わない）。値は架空。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { EXTRA_ALIASES, EXTRA_LAB_NAMES, LAB_NAMES, type LabRow, readLabText } from '../src/index.ts';

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

  test('下付き・上付きの文字（SpO₂・pCO₂・HCO₃⁻）を読む。書かれた名前は、そのまま残す', () => {
    const r = readLabText('SpO₂ 96%、pCO₂ 30 mmHg、HCO₃⁻ 11 mmol/L');
    expect(r.rows.map((x) => [x.name, x.nameRaw, x.valueText])).toEqual([
      ['SpO2', 'SpO₂', '96'],
      ['pCO2', 'pCO₂', '30'],
      ['HCO3', 'HCO₃⁻', '11'],
    ]);
  });

  test('「℃」の付いた体温を読む（全角の記号でも、空白をはさんでも）', () => {
    expect(brief(readLabText('BT 39.2℃ 体温 37.8 ℃ BT 38.0°C').rows)).toEqual(['体温=39.2 ℃', '体温=37.8 ℃', '体温=38.0 °C']);
  });

  test('値のすぐ後ろの括弧（全角・半角）で、値を捨てない。括弧の中の項目も読む', () => {
    const r = readLabText('BP 84/40（MAP 約55） ALP 597（IFCC法） WBC 20,500/μL（Neut 91%） PT 62%(PT-INR 1.38)');
    expect(brief(r.rows)).toEqual(['収縮期血圧=84', '拡張期血圧=40', 'ALP=597', 'WBC=20,500 /μL', 'Neut=91 %', 'PT=62 %', 'PT-INR=1.38']);
    expect(brief(readLabText('HBs抗原（−） 顆粒円柱(+)').rows)).toEqual(['HBs抗原=（−）', '顆粒円柱=(+)']);
    expect(brief(readLabText('【血ガス】pH 7.31【血算】WBC 18,200').rows)).toEqual(['pH=7.31', 'WBC=18,200']);
    // 括弧のあとの「：」は、つなぎの字
    expect(brief(readLabText('健診（2026年6月）：Cr 0.86、Plt 21万（紹介状）').rows)).toEqual(['Cr=0.86', 'Plt=21 万']);
  });

  test('時刻・比・式の「:」「=」と、単位だけの語を、カタログにない名前と読まない', () => {
    for (const text of ['【腎臓内科の意見（11:35、電話）】', '次回は翌日11:00、23:20', 'E3V4M6＝13', '0.05 μg/kg/min ＝ 3.2 mL/hr', 'mL/hr: 40']) {
      expect(readLabText(text).rows, text).toEqual([]);
    }
    expect(brief(readLabText('架空マーカー: 12.3 P/F比: 200').rows)).toEqual(['?架空マーカー=12.3', '?P/F比=200']);
  });

  test('経過表のための名前：MAP・JCS（「Ⅱ-10」の書き方も）・GCS（合計が書かれていれば、その数。E・V・M から足さない）', () => {
    expect(brief(readLabText('BP 98/52（MAP 67） JCS Ⅱ-10 JCS 3 GCS E3V4M6＝13 GCS 14').rows)).toEqual(['収縮期血圧=98', '拡張期血圧=52', 'MAP=67', 'JCS=10', 'JCS=3', 'GCS=13', 'GCS=14']);
    const noTotal = readLabText('GCS E4V4M6');
    expect(noTotal.rows).toEqual([]);
    expect(noTotal.unread.map((u) => u.reason)).toContain('no_value');
  });

  test('酸素の器具の名前に続く流量を、酸素流量として読む（器具の名前は、書かれた名前に残る）。尿量は、書かれた単位のまま', () => {
    const r = readLabText('SpO2 96%（鼻カニュラ2 L/min） 尿量 25 mL 尿量 0.43 mL/kg/hr');
    expect(brief(r.rows)).toEqual(['SpO2=96 %', '酸素流量=2 L/min', '尿量=25 mL', '尿量=0.43 mL/kg/hr']);
    expect(r.rows[1]?.nameRaw).toBe('鼻カニュラ');
  });

  test('尿の検査の引用（specimen = urine）は、「尿」のない名前も尿の項目として読む。ふだんは血液の項目（CD-023）', () => {
    const text = '比重 1.012、pH 5.5、蛋白 2+、潜血 2+、糖 1+、白血球 1+、Na 58、K 32';
    expect(brief(readLabText(text, { specimen: 'urine' }).rows)).toEqual(['尿比重=1.012', '尿pH=5.5', '尿蛋白=2+', '尿潜血=2+', '尿糖=1+', '尿白血球反応=1+', '尿Na=58', '尿K=32']);
    expect(brief(readLabText('pH 7.31 WBC 18,200 Na 131').rows)).toEqual(['pH=7.31', 'WBC=18,200', 'Na=131']);
    expect(brief(readLabText('沈渣：RBC 5 WBC 10', { specimen: 'urine' }).rows)).toEqual(['尿沈渣RBC=5', '尿沈渣WBC=10']);
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

describe('よく書かれる書き方（2026-11-21 に足した）', () => {
  const rowsOf = (text: string) => readLabText(text).rows.map((r) => [r.name, r.valueText, r.unit]);
  test('名前の連記：名前と値が同じ数のときだけ、順に読む（単位は読まない）', () => {
    expect(rowsOf('Na/K/Cl 138/4.1/102')).toEqual([
      ['Na', '138', null],
      ['K', '4.1', null],
      ['Cl', '102', null],
    ]);
    expect(rowsOf('AST/ALT 32/28 BUN/Cre 18.2/0.92')).toEqual([
      ['AST', '32', null],
      ['ALT', '28', null],
      ['BUN', '18.2', null],
      ['Cr', '0.92', null],
    ]);
    // 数が合わない・名前でない語がまじる：連記として読まない（読めない部分は、理由つきで出る）
    expect(rowsOf('Na/K 138')).toEqual([]);
    expect(readLabText('Na/K 138').unread.length).toBeGreaterThan(0);
    // 血圧（組の名前）は、これまでどおり
    expect(rowsOf('BP 120/80')).toEqual([
      ['収縮期血圧', '120', null],
      ['拡張期血圧', '80', null],
    ]);
  });
  test('値の後ろの印（H・L・↑・↓）：値は読み、印は flag として出す（判定に使わない）', () => {
    const r = readLabText('WBC 12300 H CRP 12.4↑ Hb 9.8 L');
    expect(r.rows.map((x) => [x.name, x.valueText])).toEqual([
      ['WBC', '12300'],
      ['CRP', '12.4'],
      ['Hb', '9.8'],
    ]);
    expect(r.unread.map((u) => u.reason)).toEqual(['flag', 'flag', 'flag']);
  });
  test('単位と名前の足し分', () => {
    expect(rowsOf('HR 72bpm RR 20回/分 体温 37.2度 KT 37.0')).toEqual([
      ['心拍数', '72', 'bpm'],
      ['呼吸数', '20', '回/分'],
      ['体温', '37.2', '度'],
      ['体温', '37.0', null],
    ]);
    expect(rowsOf('Plt 21.3×10^4/μL WBC 89×10^2')).toEqual([
      ['Plt', '21.3', '×10^4/μL'],
      ['WBC', '89', '×10^2'],
    ]);
    expect(readLabText('随時血糖 268 空腹時血糖 110 FBS 98').rows.map((x) => [x.name, x.nameRaw])).toEqual([
      ['Glu', '随時血糖'],
      ['Glu', '空腹時血糖'],
      ['Glu', 'FBS'],
    ]);
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
          if (!covered[i]) expect([' ', '\n', ',', '、', ';', '。', ':', '=', '　', '(', ')', '【', '】'], `位置 ${String(i)}「${text}」`).toContain(text[i]);
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

  test('carte で足した別名（酸素の器具）は、取り込んだ名前に付き、ほかの名前・別名と重ならない', () => {
    const key = (n: string): string => n.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    const all = new Set([...LAB_NAMES, ...EXTRA_LAB_NAMES].flatMap((e) => [e.name, ...e.aliases].map(key)));
    for (const extra of EXTRA_ALIASES) {
      expect(LAB_NAMES.some((e) => e.name === extra.name), extra.name).toBe(true);
      for (const a of extra.aliases) {
        expect(all.has(key(a)), a).toBe(false);
        expect(readLabText(`${a} 2`).rows[0]?.name, a).toBe(extra.name);
      }
    }
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
