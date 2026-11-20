// carte で足した、定性だけの検査の名前。
// 取り込み元（clinical-playbook のカタログ）は、数で書く項目だけを持つ（Playbook の受け渡しの値が、数だけのため）。
// carte は記録なので、定性の結果（(-)・2+・陽性）も、書かれたとおりに持つ（docs/04 の 3.4）。そのための名前を、ここに足す。
//
// 【案。本人は未確認】名前・別名は、一般的な書き方から選んだ（2026-11-20）。足す・直すのは自由（判定に使う値は、ここに置かない）。
// 取り込んだ名前・別名と重ならないこと（試験が確かめる）。あいまいな別名（「潜血」だけ、など）は置かない。
import type { LabName } from './catalog.gen.ts';

const urine = (name: string, aliases: readonly string[] = []): LabName => ({ name, aliases, kind: 'lab', group: '尿定性', units: [] });
const stool = (name: string, aliases: readonly string[] = []): LabName => ({ name, aliases, kind: 'lab', group: '便', units: [] });
const infection = (name: string, aliases: readonly string[] = []): LabName => ({ name, aliases, kind: 'lab', group: '感染症（定性）', units: [] });

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
];
