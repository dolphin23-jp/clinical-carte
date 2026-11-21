// carte で足した、検査・バイタルの名前（定性の検査と、経過表の段のためのバイタル）。
// 取り込み元（clinical-playbook のカタログ）は、数で書く項目だけを持つ（Playbook の受け渡しの値が、数だけのため）。
// carte は記録なので、定性の結果（(-)・2+・陽性）も、書かれたとおりに持つ（docs/04 の 3.4）。そのための名前を、ここに足す。
//
// 【案。本人は未確認】名前・別名は、一般的な書き方から選んだ（2026-11-20）。足す・直すのは自由（判定に使う値は、ここに置かない）。
// 取り込んだ名前・別名と重ならないこと（試験が確かめる）。あいまいな別名（「潜血」だけ、など）は置かない。
import type { LabName } from './catalog.gen.ts';

const urine = (name: string, aliases: readonly string[] = []): LabName => ({ name, aliases, kind: 'lab', group: '尿定性', units: [] });
const stool = (name: string, aliases: readonly string[] = []): LabName => ({ name, aliases, kind: 'lab', group: '便', units: [] });
const infection = (name: string, aliases: readonly string[] = []): LabName => ({ name, aliases, kind: 'lab', group: '感染症（定性）', units: [] });
const vital = (name: string, aliases: readonly string[] = [], units: readonly string[] = []): LabName => ({ name, aliases, kind: 'vital', group: 'バイタル', units });

export const EXTRA_LAB_NAMES: readonly LabName[] = [
  urine('尿潜血', ['尿OB']),
  urine('尿糖'),
  urine('尿ケトン体', ['尿ケトン']),
  urine('尿白血球反応', ['白血球エステラーゼ']),
  urine('尿亜硝酸塩', ['亜硝酸塩']),
  urine('尿ビリルビン'),
  urine('尿ウロビリノーゲン', ['ウロビリノーゲン']),
  stool('便潜血', ['FOBT']),
  infection('HCV抗体', ['HCVAb']),
  infection('HIV抗原抗体'),
  infection('RPR'),
  infection('TPHA', ['TP抗体']),
  infection('インフルエンザ抗原'),
  infection('新型コロナ抗原', ['COVID抗原']),
  infection('新型コロナPCR', ['COVID PCR', 'SARS-CoV-2 PCR']),
  infection('尿中肺炎球菌抗原'),
  infection('尿中レジオネラ抗原'),
  infection('CDトキシン', ['CD toxin']),
  // 経過表の段（2026-11-21 の本人の決定）。数を書かれたとおりに読むだけで、判定しない。
  // 【事実】MAP は平均血圧（mmHg）。JCS は Japan Coma Scale の書かれた数（0・1〜3・10〜30・100〜300）。GCS は合計点（3〜15）。
  // 出典：一般的な表記（確認日 2026-11-21）。範囲で値を確かめない（範囲の外でも、書かれたとおりに持つ）
  vital('MAP', ['平均血圧'], ['mmHg']),
  vital('JCS'),
  vital('GCS', [], ['点']),
];

/**
 * 取り込んだ名前に、carte で足す別名（取り込んだ表は手で直さないため、ここに置く）。
 * 酸素の器具の名前に続けて流量を書く書き方（「鼻カニュラ 2 L/min」）を、酸素流量として読む。器具の名前は、書かれた名前（nameRaw）に残る
 */
export const EXTRA_ALIASES: readonly { readonly name: string; readonly aliases: readonly string[] }[] = [
  { name: '酸素流量', aliases: ['鼻カニュラ', '鼻カヌラ', '経鼻カニュラ', '酸素マスク', 'リザーバーマスク', 'リザーバー付きマスク'] },
];

/** carte で足す単位の書き方（尿量の、時間あたり・体重あたり・合計の書き方を、混ぜずに分けるため。換算しない） */
export const EXTRA_UNITS: readonly string[] = ['mL', 'mL/hr', 'mL/h', 'mL/時', 'mL/kg/hr', 'mL/kg/h', 'mL/kg/時'];
