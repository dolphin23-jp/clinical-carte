// このファイルは scripts/import_lab_names.mjs が作る。手で直さない。
// 出どころ：clinical-playbook の config/lab-catalog.yaml（コミット 05191212bee60b0456b9c2ec651e0fdf90f393a0）。 phi-guard: allow コミットの id
// 取り込んだのは、名前・別名・単位の書き方・群だけ（基準範囲・ありうる範囲・換算の倍率は取り込まない。carte は値を判定せず、換算もしない）。

export interface LabName {
  /** 正規の名前（推移の表で、同じ項目をまとめるのに使う） */
  readonly name: string;
  /** 別の書き方 */
  readonly aliases: readonly string[];
  readonly kind: 'lab' | 'vital';
  readonly group: string;
  /** この項目の単位の書き方（書かれた単位を、単位として読み分けるのに使う。換算には使わない） */
  readonly units: readonly string[];
}

export const LAB_NAMES_SOURCE_COMMIT = "05191212bee60b0456b9c2ec651e0fdf90f393a0"; // phi-guard: allow コミットの id

export const LAB_NAMES: readonly LabName[] = [
  {
    "name": "収縮期血圧",
    "aliases": [
      "SBP",
      "収縮期"
    ],
    "kind": "vital",
    "group": "バイタル",
    "units": [
      "mmHg"
    ]
  },
  {
    "name": "拡張期血圧",
    "aliases": [
      "DBP",
      "拡張期"
    ],
    "kind": "vital",
    "group": "バイタル",
    "units": [
      "mmHg"
    ]
  },
  {
    "name": "心拍数",
    "aliases": [
      "HR",
      "脈拍"
    ],
    "kind": "vital",
    "group": "バイタル",
    "units": [
      "/分"
    ]
  },
  {
    "name": "呼吸数",
    "aliases": [
      "RR"
    ],
    "kind": "vital",
    "group": "バイタル",
    "units": [
      "/分"
    ]
  },
  {
    "name": "SpO2",
    "aliases": [
      "経皮的酸素飽和度"
    ],
    "kind": "vital",
    "group": "バイタル",
    "units": [
      "%"
    ]
  },
  {
    "name": "体温",
    "aliases": [
      "BT"
    ],
    "kind": "vital",
    "group": "バイタル",
    "units": [
      "℃"
    ]
  },
  {
    "name": "酸素流量",
    "aliases": [
      "O2流量",
      "酸素投与量",
      "酸素",
      "O2"
    ],
    "kind": "vital",
    "group": "バイタル",
    "units": [
      "L/分",
      "L/min"
    ]
  },
  {
    "name": "体重",
    "aliases": [
      "BW",
      "Wt",
      "body weight"
    ],
    "kind": "vital",
    "group": "バイタル",
    "units": [
      "kg"
    ]
  },
  {
    "name": "尿量",
    "aliases": [
      "UO",
      "urine output",
      "1日尿量",
      "24時間尿量"
    ],
    "kind": "vital",
    "group": "バイタル",
    "units": [
      "mL/日"
    ]
  },
  {
    "name": "身長",
    "aliases": [
      "body height",
      "BH"
    ],
    "kind": "vital",
    "group": "バイタル",
    "units": [
      "cm"
    ]
  },
  {
    "name": "腹囲",
    "aliases": [
      "waist",
      "ウエスト"
    ],
    "kind": "vital",
    "group": "バイタル",
    "units": [
      "cm"
    ]
  },
  {
    "name": "WBC",
    "aliases": [
      "白血球"
    ],
    "kind": "lab",
    "group": "血算",
    "units": [
      "/μL",
      "/mm3",
      "千/μL",
      "10^3/μL",
      "×10^3/μL",
      "x10^3/μL",
      "10³/μL",
      "×10³/μL",
      "K/μL",
      "10^3/uL",
      "x10^3/uL",
      "10^9/L",
      "×10^9/L",
      "x10^9/L"
    ]
  },
  {
    "name": "RBC",
    "aliases": [
      "赤血球"
    ],
    "kind": "lab",
    "group": "血算",
    "units": [
      "万/μL",
      "万",
      "×10^6/μL",
      "10^6/μL",
      "x10^6/μL",
      "×10⁶/μL",
      "10⁶/μL",
      "百万/μL",
      "M/μL",
      "10^6/uL",
      "x10^6/uL",
      "10^12/L",
      "×10^12/L",
      "x10^12/L",
      "/μL",
      "/mm3"
    ]
  },
  {
    "name": "Hb",
    "aliases": [
      "ヘモグロビン"
    ],
    "kind": "lab",
    "group": "血算",
    "units": [
      "g/dL"
    ]
  },
  {
    "name": "Ht",
    "aliases": [
      "Hct",
      "ヘマトクリット"
    ],
    "kind": "lab",
    "group": "血算",
    "units": [
      "%"
    ]
  },
  {
    "name": "MCV",
    "aliases": [],
    "kind": "lab",
    "group": "血算",
    "units": [
      "fL"
    ]
  },
  {
    "name": "MCH",
    "aliases": [],
    "kind": "lab",
    "group": "血算",
    "units": [
      "pg"
    ]
  },
  {
    "name": "MCHC",
    "aliases": [],
    "kind": "lab",
    "group": "血算",
    "units": [
      "%"
    ]
  },
  {
    "name": "Plt",
    "aliases": [
      "血小板"
    ],
    "kind": "lab",
    "group": "血算",
    "units": [
      "万/μL",
      "万",
      "×10^3/μL",
      "10^3/μL",
      "x10^3/μL",
      "×10³/μL",
      "10³/μL",
      "千/μL",
      "K/μL",
      "10^3/uL",
      "x10^3/uL",
      "10^9/L",
      "×10^9/L",
      "x10^9/L",
      "/μL",
      "/mm3"
    ]
  },
  {
    "name": "Ret",
    "aliases": [
      "網赤血球",
      "Retic"
    ],
    "kind": "lab",
    "group": "血算",
    "units": [
      "%"
    ]
  },
  {
    "name": "ESR",
    "aliases": [
      "赤沈",
      "血沈"
    ],
    "kind": "lab",
    "group": "血算",
    "units": [
      "mm/h"
    ]
  },
  {
    "name": "ANC",
    "aliases": [
      "好中球数",
      "絶対好中球数"
    ],
    "kind": "lab",
    "group": "血算",
    "units": [
      "/μL"
    ]
  },
  {
    "name": "好酸球数",
    "aliases": [
      "AEC"
    ],
    "kind": "lab",
    "group": "血算",
    "units": [
      "/μL"
    ]
  },
  {
    "name": "Neut",
    "aliases": [
      "好中球"
    ],
    "kind": "lab",
    "group": "白血球分画",
    "units": [
      "%"
    ]
  },
  {
    "name": "桿状核球",
    "aliases": [
      "桿状核好中球",
      "Stab"
    ],
    "kind": "lab",
    "group": "白血球分画",
    "units": [
      "%"
    ]
  },
  {
    "name": "Lymph",
    "aliases": [
      "リンパ球",
      "Lym"
    ],
    "kind": "lab",
    "group": "白血球分画",
    "units": [
      "%"
    ]
  },
  {
    "name": "Mono",
    "aliases": [
      "単球"
    ],
    "kind": "lab",
    "group": "白血球分画",
    "units": [
      "%"
    ]
  },
  {
    "name": "Eos",
    "aliases": [
      "好酸球"
    ],
    "kind": "lab",
    "group": "白血球分画",
    "units": [
      "%"
    ]
  },
  {
    "name": "Baso",
    "aliases": [
      "好塩基球"
    ],
    "kind": "lab",
    "group": "白血球分画",
    "units": [
      "%"
    ]
  },
  {
    "name": "異型リンパ球",
    "aliases": [
      "Aty-Ly"
    ],
    "kind": "lab",
    "group": "白血球分画",
    "units": [
      "%"
    ]
  },
  {
    "name": "芽球",
    "aliases": [
      "Blast"
    ],
    "kind": "lab",
    "group": "白血球分画",
    "units": [
      "%"
    ]
  },
  {
    "name": "TP",
    "aliases": [
      "総蛋白"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "g/dL"
    ]
  },
  {
    "name": "Alb",
    "aliases": [
      "アルブミン"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "g/dL"
    ]
  },
  {
    "name": "AST",
    "aliases": [
      "GOT"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "U/L"
    ]
  },
  {
    "name": "ALT",
    "aliases": [
      "GPT"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "U/L"
    ]
  },
  {
    "name": "LDH",
    "aliases": [
      "LD"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "U/L"
    ]
  },
  {
    "name": "ALP",
    "aliases": [],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "U/L"
    ]
  },
  {
    "name": "γ-GTP",
    "aliases": [
      "γGTP",
      "GGT",
      "γ-GT"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "U/L"
    ]
  },
  {
    "name": "T-Bil",
    "aliases": [
      "TB"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "D-Bil",
    "aliases": [
      "DB",
      "直接ビリルビン"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "ChE",
    "aliases": [
      "コリンエステラーゼ"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "U/L"
    ]
  },
  {
    "name": "AMY",
    "aliases": [
      "アミラーゼ"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "U/L"
    ]
  },
  {
    "name": "リパーゼ",
    "aliases": [
      "Lipase"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "U/L"
    ]
  },
  {
    "name": "CK",
    "aliases": [
      "CPK"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "U/L"
    ]
  },
  {
    "name": "BUN",
    "aliases": [
      "UN",
      "尿素窒素"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "Cr",
    "aliases": [
      "sCr",
      "CRE",
      "クレアチニン"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "eGFR",
    "aliases": [],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mL/min/1.73m2"
    ]
  },
  {
    "name": "Cys-C",
    "aliases": [
      "シスタチンC",
      "CysC"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/L"
    ]
  },
  {
    "name": "UA",
    "aliases": [
      "尿酸"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "Na",
    "aliases": [
      "ナトリウム"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mEq/L"
    ]
  },
  {
    "name": "K",
    "aliases": [
      "カリウム"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mEq/L"
    ]
  },
  {
    "name": "Cl",
    "aliases": [
      "クロール"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mEq/L"
    ]
  },
  {
    "name": "Ca",
    "aliases": [
      "カルシウム"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "IP",
    "aliases": [
      "リン"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "Mg",
    "aliases": [
      "マグネシウム"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "Glu",
    "aliases": [
      "BS",
      "血糖",
      "Glucose"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "HbA1c",
    "aliases": [],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "%"
    ]
  },
  {
    "name": "GA",
    "aliases": [
      "グリコアルブミン"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "%"
    ]
  },
  {
    "name": "CRP",
    "aliases": [],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "T-Cho",
    "aliases": [
      "TC",
      "総コレステロール"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "LDL-C",
    "aliases": [
      "LDL"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "HDL-C",
    "aliases": [
      "HDL"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "TG",
    "aliases": [
      "中性脂肪",
      "トリグリセリド"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "NH3",
    "aliases": [
      "アンモニア"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "μg/dL"
    ]
  },
  {
    "name": "Fe",
    "aliases": [
      "血清鉄"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "μg/dL"
    ]
  },
  {
    "name": "TIBC",
    "aliases": [
      "総鉄結合能"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "μg/dL"
    ]
  },
  {
    "name": "UIBC",
    "aliases": [],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "μg/dL"
    ]
  },
  {
    "name": "フェリチン",
    "aliases": [
      "Ferritin"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "VitB12",
    "aliases": [
      "ビタミンB12"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "pg/mL"
    ]
  },
  {
    "name": "葉酸",
    "aliases": [
      "Folate"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "Zn",
    "aliases": [
      "亜鉛"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "μg/dL"
    ]
  },
  {
    "name": "Posm",
    "aliases": [
      "血漿浸透圧",
      "血清浸透圧"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mOsm/kg"
    ]
  },
  {
    "name": "I-Bil",
    "aliases": [
      "間接ビリルビン",
      "IB"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "胆汁酸",
    "aliases": [
      "TBA",
      "総胆汁酸"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "μmol/L"
    ]
  },
  {
    "name": "ハプトグロビン",
    "aliases": [
      "Hp"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "エリスロポエチン",
    "aliases": [
      "EPO"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mIU/mL"
    ]
  },
  {
    "name": "プレアルブミン",
    "aliases": [
      "PreAlb",
      "トランスサイレチン",
      "TTR"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "トランスフェリン",
    "aliases": [
      "Tf"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "Cu",
    "aliases": [
      "銅"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "μg/dL"
    ]
  },
  {
    "name": "P-AMY",
    "aliases": [
      "膵型アミラーゼ",
      "膵アミラーゼ"
    ],
    "kind": "lab",
    "group": "生化学",
    "units": [
      "U/L"
    ]
  },
  {
    "name": "CK-MB",
    "aliases": [],
    "kind": "lab",
    "group": "心筋",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "hs-TnT",
    "aliases": [
      "高感度トロポニンT",
      "TnT"
    ],
    "kind": "lab",
    "group": "心筋",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "hs-TnI",
    "aliases": [
      "高感度トロポニンI",
      "TnI"
    ],
    "kind": "lab",
    "group": "心筋",
    "units": [
      "pg/mL"
    ]
  },
  {
    "name": "BNP",
    "aliases": [],
    "kind": "lab",
    "group": "心筋",
    "units": [
      "pg/mL"
    ]
  },
  {
    "name": "NT-proBNP",
    "aliases": [
      "NTproBNP",
      "NT-pro-BNP"
    ],
    "kind": "lab",
    "group": "心筋",
    "units": [
      "pg/mL"
    ]
  },
  {
    "name": "ミオグロビン",
    "aliases": [
      "Mb",
      "血清ミオグロビン"
    ],
    "kind": "lab",
    "group": "心筋",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "H-FABP",
    "aliases": [
      "heart-FABP",
      "心臓型脂肪酸結合蛋白"
    ],
    "kind": "lab",
    "group": "心筋",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "PT",
    "aliases": [
      "PT秒"
    ],
    "kind": "lab",
    "group": "凝固・線溶",
    "units": [
      "秒"
    ]
  },
  {
    "name": "PT活性",
    "aliases": [
      "PT%"
    ],
    "kind": "lab",
    "group": "凝固・線溶",
    "units": [
      "%"
    ]
  },
  {
    "name": "PT-INR",
    "aliases": [
      "INR"
    ],
    "kind": "lab",
    "group": "凝固・線溶",
    "units": []
  },
  {
    "name": "PT比",
    "aliases": [],
    "kind": "lab",
    "group": "凝固・線溶",
    "units": []
  },
  {
    "name": "APTT",
    "aliases": [],
    "kind": "lab",
    "group": "凝固・線溶",
    "units": [
      "秒"
    ]
  },
  {
    "name": "Fib",
    "aliases": [
      "フィブリノゲン",
      "Fbg"
    ],
    "kind": "lab",
    "group": "凝固・線溶",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "FDP",
    "aliases": [],
    "kind": "lab",
    "group": "凝固・線溶",
    "units": [
      "μg/mL"
    ]
  },
  {
    "name": "D-dimer",
    "aliases": [
      "Dダイマー",
      "D-ダイマー",
      "DD"
    ],
    "kind": "lab",
    "group": "凝固・線溶",
    "units": [
      "μg/mL"
    ]
  },
  {
    "name": "AT",
    "aliases": [
      "AT-III",
      "ATIII",
      "アンチトロンビン"
    ],
    "kind": "lab",
    "group": "凝固・線溶",
    "units": [
      "%"
    ]
  },
  {
    "name": "TAT",
    "aliases": [
      "トロンビン・アンチトロンビン複合体"
    ],
    "kind": "lab",
    "group": "凝固・線溶",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "SF",
    "aliases": [
      "可溶性フィブリン"
    ],
    "kind": "lab",
    "group": "凝固・線溶",
    "units": [
      "μg/mL"
    ]
  },
  {
    "name": "PIC",
    "aliases": [
      "プラスミン・α2PI複合体",
      "プラスミンα2PI複合体"
    ],
    "kind": "lab",
    "group": "凝固・線溶",
    "units": [
      "μg/mL"
    ]
  },
  {
    "name": "抗Xa活性",
    "aliases": [
      "anti-Xa",
      "抗Xa"
    ],
    "kind": "lab",
    "group": "凝固・線溶",
    "units": [
      "IU/mL"
    ]
  },
  {
    "name": "pH",
    "aliases": [],
    "kind": "lab",
    "group": "血液ガス",
    "units": []
  },
  {
    "name": "pCO2",
    "aliases": [
      "PaCO2"
    ],
    "kind": "lab",
    "group": "血液ガス",
    "units": [
      "mmHg"
    ]
  },
  {
    "name": "pO2",
    "aliases": [
      "PaO2"
    ],
    "kind": "lab",
    "group": "血液ガス",
    "units": [
      "mmHg"
    ]
  },
  {
    "name": "FiO2",
    "aliases": [
      "吸入酸素濃度"
    ],
    "kind": "lab",
    "group": "血液ガス",
    "units": [
      "%"
    ]
  },
  {
    "name": "HCO3",
    "aliases": [
      "HCO3-",
      "重炭酸"
    ],
    "kind": "lab",
    "group": "血液ガス",
    "units": [
      "mEq/L"
    ]
  },
  {
    "name": "BE",
    "aliases": [
      "ABE"
    ],
    "kind": "lab",
    "group": "血液ガス",
    "units": [
      "mEq/L"
    ]
  },
  {
    "name": "SaO2",
    "aliases": [],
    "kind": "lab",
    "group": "血液ガス",
    "units": [
      "%"
    ]
  },
  {
    "name": "Lac",
    "aliases": [
      "乳酸"
    ],
    "kind": "lab",
    "group": "血液ガス",
    "units": [
      "mmol/L"
    ]
  },
  {
    "name": "iCa",
    "aliases": [
      "イオン化Ca"
    ],
    "kind": "lab",
    "group": "血液ガス",
    "units": [
      "mmol/L"
    ]
  },
  {
    "name": "COHb",
    "aliases": [],
    "kind": "lab",
    "group": "血液ガス",
    "units": [
      "%"
    ]
  },
  {
    "name": "MetHb",
    "aliases": [],
    "kind": "lab",
    "group": "血液ガス",
    "units": [
      "%"
    ]
  },
  {
    "name": "尿比重",
    "aliases": [
      "USG"
    ],
    "kind": "lab",
    "group": "尿定性",
    "units": []
  },
  {
    "name": "尿pH",
    "aliases": [],
    "kind": "lab",
    "group": "尿定性",
    "units": []
  },
  {
    "name": "尿沈渣RBC",
    "aliases": [
      "沈渣RBC"
    ],
    "kind": "lab",
    "group": "尿沈渣",
    "units": [
      "/HPF"
    ]
  },
  {
    "name": "尿沈渣WBC",
    "aliases": [
      "沈渣WBC"
    ],
    "kind": "lab",
    "group": "尿沈渣",
    "units": [
      "/HPF"
    ]
  },
  {
    "name": "硝子円柱",
    "aliases": [],
    "kind": "lab",
    "group": "尿沈渣",
    "units": [
      "/WF"
    ]
  },
  {
    "name": "顆粒円柱",
    "aliases": [],
    "kind": "lab",
    "group": "尿沈渣",
    "units": [
      "/WF"
    ]
  },
  {
    "name": "赤血球円柱",
    "aliases": [],
    "kind": "lab",
    "group": "尿沈渣",
    "units": [
      "/WF"
    ]
  },
  {
    "name": "尿Na",
    "aliases": [
      "UNa"
    ],
    "kind": "lab",
    "group": "尿生化学",
    "units": [
      "mEq/L"
    ]
  },
  {
    "name": "尿K",
    "aliases": [
      "UK"
    ],
    "kind": "lab",
    "group": "尿生化学",
    "units": [
      "mEq/L"
    ]
  },
  {
    "name": "尿Cl",
    "aliases": [
      "UCl"
    ],
    "kind": "lab",
    "group": "尿生化学",
    "units": [
      "mEq/L"
    ]
  },
  {
    "name": "尿Cr",
    "aliases": [
      "UCr"
    ],
    "kind": "lab",
    "group": "尿生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "尿UN",
    "aliases": [
      "UUN"
    ],
    "kind": "lab",
    "group": "尿生化学",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "尿Osm",
    "aliases": [
      "Uosm",
      "尿浸透圧"
    ],
    "kind": "lab",
    "group": "尿生化学",
    "units": [
      "mOsm/kg"
    ]
  },
  {
    "name": "尿蛋白",
    "aliases": [
      "UPCR"
    ],
    "kind": "lab",
    "group": "尿生化学",
    "units": [
      "g/gCr"
    ]
  },
  {
    "name": "UACR",
    "aliases": [
      "尿アルブミン/Cr比"
    ],
    "kind": "lab",
    "group": "尿生化学",
    "units": [
      "mg/gCr"
    ]
  },
  {
    "name": "尿β2MG",
    "aliases": [
      "尿β2-MG"
    ],
    "kind": "lab",
    "group": "尿生化学",
    "units": [
      "μg/L"
    ]
  },
  {
    "name": "尿NAG",
    "aliases": [
      "NAG"
    ],
    "kind": "lab",
    "group": "尿生化学",
    "units": [
      "U/L"
    ]
  },
  {
    "name": "胸水TP",
    "aliases": [],
    "kind": "lab",
    "group": "体液",
    "units": [
      "g/dL"
    ]
  },
  {
    "name": "胸水LDH",
    "aliases": [],
    "kind": "lab",
    "group": "体液",
    "units": [
      "U/L"
    ]
  },
  {
    "name": "胸水Glu",
    "aliases": [],
    "kind": "lab",
    "group": "体液",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "胸水pH",
    "aliases": [],
    "kind": "lab",
    "group": "体液",
    "units": []
  },
  {
    "name": "胸水ADA",
    "aliases": [],
    "kind": "lab",
    "group": "体液",
    "units": [
      "U/L"
    ]
  },
  {
    "name": "腹水Alb",
    "aliases": [],
    "kind": "lab",
    "group": "体液",
    "units": [
      "g/dL"
    ]
  },
  {
    "name": "腹水TP",
    "aliases": [],
    "kind": "lab",
    "group": "体液",
    "units": [
      "g/dL"
    ]
  },
  {
    "name": "髄液細胞数",
    "aliases": [],
    "kind": "lab",
    "group": "体液",
    "units": [
      "/μL"
    ]
  },
  {
    "name": "髄液蛋白",
    "aliases": [],
    "kind": "lab",
    "group": "体液",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "髄液糖",
    "aliases": [],
    "kind": "lab",
    "group": "体液",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "胸水細胞数",
    "aliases": [],
    "kind": "lab",
    "group": "体液",
    "units": [
      "/μL"
    ]
  },
  {
    "name": "胸水Alb",
    "aliases": [
      "胸水アルブミン"
    ],
    "kind": "lab",
    "group": "体液",
    "units": [
      "g/dL"
    ]
  },
  {
    "name": "腹水細胞数",
    "aliases": [],
    "kind": "lab",
    "group": "体液",
    "units": [
      "/μL"
    ]
  },
  {
    "name": "腹水好中球数",
    "aliases": [
      "腹水PMN"
    ],
    "kind": "lab",
    "group": "体液",
    "units": [
      "/μL"
    ]
  },
  {
    "name": "腹水LDH",
    "aliases": [],
    "kind": "lab",
    "group": "体液",
    "units": [
      "U/L"
    ]
  },
  {
    "name": "腹水Glu",
    "aliases": [],
    "kind": "lab",
    "group": "体液",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "髄液乳酸",
    "aliases": [
      "髄液Lac"
    ],
    "kind": "lab",
    "group": "体液",
    "units": [
      "mmol/L"
    ]
  },
  {
    "name": "関節液白血球数",
    "aliases": [
      "関節液WBC"
    ],
    "kind": "lab",
    "group": "体液",
    "units": [
      "/μL"
    ]
  },
  {
    "name": "TSH",
    "aliases": [],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "μIU/mL"
    ]
  },
  {
    "name": "FT4",
    "aliases": [
      "遊離T4"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "ng/dL"
    ]
  },
  {
    "name": "FT3",
    "aliases": [
      "遊離T3"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "pg/mL"
    ]
  },
  {
    "name": "TRAb",
    "aliases": [
      "TSHレセプター抗体"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "IU/L"
    ]
  },
  {
    "name": "抗TPO抗体",
    "aliases": [
      "TPOAb"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "IU/mL"
    ]
  },
  {
    "name": "抗Tg抗体",
    "aliases": [
      "TgAb"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "IU/mL"
    ]
  },
  {
    "name": "コルチゾール",
    "aliases": [
      "Cortisol"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "μg/dL"
    ]
  },
  {
    "name": "ACTH",
    "aliases": [],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "pg/mL"
    ]
  },
  {
    "name": "PRA",
    "aliases": [
      "レニン活性"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "ng/mL/h"
    ]
  },
  {
    "name": "PAC",
    "aliases": [
      "アルドステロン"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "pg/mL"
    ]
  },
  {
    "name": "iPTH",
    "aliases": [
      "intact-PTH",
      "PTH",
      "インタクトPTH"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "pg/mL"
    ]
  },
  {
    "name": "25(OH)D",
    "aliases": [
      "25-OHビタミンD"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "IRI",
    "aliases": [
      "インスリン"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "μU/mL"
    ]
  },
  {
    "name": "Cペプチド",
    "aliases": [
      "CPR",
      "C-ペプチド"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "GH",
    "aliases": [
      "成長ホルモン"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "IGF-1",
    "aliases": [
      "ソマトメジンC"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "PRL",
    "aliases": [
      "プロラクチン"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "ADH",
    "aliases": [
      "AVP",
      "バソプレシン"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "pg/mL"
    ]
  },
  {
    "name": "3-HB",
    "aliases": [
      "βHB",
      "β-ヒドロキシ酪酸"
    ],
    "kind": "lab",
    "group": "内分泌",
    "units": [
      "μmol/L"
    ]
  },
  {
    "name": "IgG",
    "aliases": [],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "IgA",
    "aliases": [],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "IgM",
    "aliases": [],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "IgE",
    "aliases": [],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "IU/mL"
    ]
  },
  {
    "name": "IgG4",
    "aliases": [],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "C3",
    "aliases": [],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "C4",
    "aliases": [],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "CH50",
    "aliases": [],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "RF",
    "aliases": [
      "リウマトイド因子"
    ],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "IU/mL"
    ]
  },
  {
    "name": "抗CCP抗体",
    "aliases": [
      "ACPA",
      "CCP抗体"
    ],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "ANA",
    "aliases": [
      "抗核抗体"
    ],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "倍"
    ]
  },
  {
    "name": "抗dsDNA抗体",
    "aliases": [
      "dsDNA"
    ],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "IU/mL"
    ]
  },
  {
    "name": "抗SS-A抗体",
    "aliases": [
      "SS-A",
      "抗Ro抗体"
    ],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "抗SS-B抗体",
    "aliases": [
      "SS-B",
      "抗La抗体"
    ],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "抗Sm抗体",
    "aliases": [],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "抗RNP抗体",
    "aliases": [
      "抗U1-RNP抗体"
    ],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "抗Scl-70抗体",
    "aliases": [],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "抗セントロメア抗体",
    "aliases": [],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "抗GBM抗体",
    "aliases": [],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "MPO-ANCA",
    "aliases": [
      "P-ANCA"
    ],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "PR3-ANCA",
    "aliases": [
      "C-ANCA"
    ],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "抗カルジオリピン抗体",
    "aliases": [
      "aCL"
    ],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "KL-6",
    "aliases": [],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "SP-D",
    "aliases": [],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "ACE",
    "aliases": [
      "アンジオテンシン変換酵素"
    ],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "U/L"
    ]
  },
  {
    "name": "ASO",
    "aliases": [],
    "kind": "lab",
    "group": "免疫・膠原病",
    "units": [
      "IU/mL"
    ]
  },
  {
    "name": "CEA",
    "aliases": [],
    "kind": "lab",
    "group": "腫瘍マーカー",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "CA19-9",
    "aliases": [
      "CA199"
    ],
    "kind": "lab",
    "group": "腫瘍マーカー",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "AFP",
    "aliases": [],
    "kind": "lab",
    "group": "腫瘍マーカー",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "PIVKA-II",
    "aliases": [
      "PIVKA2",
      "DCP"
    ],
    "kind": "lab",
    "group": "腫瘍マーカー",
    "units": [
      "mAU/mL"
    ]
  },
  {
    "name": "PSA",
    "aliases": [],
    "kind": "lab",
    "group": "腫瘍マーカー",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "CA125",
    "aliases": [
      "CA-125"
    ],
    "kind": "lab",
    "group": "腫瘍マーカー",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "CA15-3",
    "aliases": [],
    "kind": "lab",
    "group": "腫瘍マーカー",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "CYFRA",
    "aliases": [
      "シフラ",
      "CYFRA21-1"
    ],
    "kind": "lab",
    "group": "腫瘍マーカー",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "ProGRP",
    "aliases": [],
    "kind": "lab",
    "group": "腫瘍マーカー",
    "units": [
      "pg/mL"
    ]
  },
  {
    "name": "NSE",
    "aliases": [],
    "kind": "lab",
    "group": "腫瘍マーカー",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "SCC",
    "aliases": [
      "SCC抗原"
    ],
    "kind": "lab",
    "group": "腫瘍マーカー",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "sIL-2R",
    "aliases": [
      "可溶性IL-2受容体",
      "sIL2R"
    ],
    "kind": "lab",
    "group": "腫瘍マーカー",
    "units": [
      "U/mL"
    ]
  },
  {
    "name": "β2MG",
    "aliases": [
      "β2ミクログロブリン",
      "β2-MG"
    ],
    "kind": "lab",
    "group": "腫瘍マーカー",
    "units": [
      "mg/L"
    ]
  },
  {
    "name": "PCT",
    "aliases": [
      "プロカルシトニン"
    ],
    "kind": "lab",
    "group": "感染症",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "プレセプシン",
    "aliases": [
      "P-SEP"
    ],
    "kind": "lab",
    "group": "感染症",
    "units": [
      "pg/mL"
    ]
  },
  {
    "name": "β-Dグルカン",
    "aliases": [
      "βDグルカン",
      "BDG"
    ],
    "kind": "lab",
    "group": "感染症",
    "units": [
      "pg/mL"
    ]
  },
  {
    "name": "エンドトキシン",
    "aliases": [],
    "kind": "lab",
    "group": "感染症",
    "units": [
      "pg/mL"
    ]
  },
  {
    "name": "HBs抗体",
    "aliases": [
      "HBsAb"
    ],
    "kind": "lab",
    "group": "感染症",
    "units": [
      "mIU/mL"
    ]
  },
  {
    "name": "HBV-DNA",
    "aliases": [],
    "kind": "lab",
    "group": "感染症",
    "units": [
      "LogIU/mL"
    ]
  },
  {
    "name": "HCV-RNA",
    "aliases": [],
    "kind": "lab",
    "group": "感染症",
    "units": [
      "LogIU/mL"
    ]
  },
  {
    "name": "HBs抗原",
    "aliases": [
      "HBsAg"
    ],
    "kind": "lab",
    "group": "感染症",
    "units": [
      "IU/mL"
    ]
  },
  {
    "name": "VCM",
    "aliases": [
      "バンコマイシン",
      "バンコマイシン濃度"
    ],
    "kind": "lab",
    "group": "薬物濃度",
    "units": [
      "μg/mL"
    ]
  },
  {
    "name": "ジゴキシン",
    "aliases": [
      "DGX",
      "Dig",
      "ジゴキシン濃度"
    ],
    "kind": "lab",
    "group": "薬物濃度",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "テオフィリン",
    "aliases": [
      "テオフィリン濃度"
    ],
    "kind": "lab",
    "group": "薬物濃度",
    "units": [
      "μg/mL"
    ]
  },
  {
    "name": "バルプロ酸",
    "aliases": [
      "VPA",
      "バルプロ酸濃度"
    ],
    "kind": "lab",
    "group": "薬物濃度",
    "units": [
      "μg/mL"
    ]
  },
  {
    "name": "フェニトイン",
    "aliases": [
      "PHT",
      "フェニトイン濃度"
    ],
    "kind": "lab",
    "group": "薬物濃度",
    "units": [
      "μg/mL"
    ]
  },
  {
    "name": "カルバマゼピン",
    "aliases": [
      "CBZ"
    ],
    "kind": "lab",
    "group": "薬物濃度",
    "units": [
      "μg/mL"
    ]
  },
  {
    "name": "フェノバルビタール",
    "aliases": [
      "PB",
      "フェノバール"
    ],
    "kind": "lab",
    "group": "薬物濃度",
    "units": [
      "μg/mL"
    ]
  },
  {
    "name": "タクロリムス",
    "aliases": [
      "TAC",
      "FK506",
      "タクロリムス濃度"
    ],
    "kind": "lab",
    "group": "薬物濃度",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "シクロスポリン",
    "aliases": [
      "CyA",
      "CsA",
      "シクロスポリン濃度"
    ],
    "kind": "lab",
    "group": "薬物濃度",
    "units": [
      "ng/mL"
    ]
  },
  {
    "name": "リチウム",
    "aliases": [
      "Li",
      "リチウム濃度"
    ],
    "kind": "lab",
    "group": "薬物濃度",
    "units": [
      "mEq/L"
    ]
  },
  {
    "name": "アセトアミノフェン",
    "aliases": [
      "APAP",
      "アセトアミノフェン濃度"
    ],
    "kind": "lab",
    "group": "薬物濃度",
    "units": [
      "μg/mL"
    ]
  },
  {
    "name": "サリチル酸",
    "aliases": [
      "サリチル酸濃度"
    ],
    "kind": "lab",
    "group": "薬物濃度",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "エタノール",
    "aliases": [
      "EtOH",
      "アルコール濃度",
      "血中アルコール"
    ],
    "kind": "lab",
    "group": "薬物濃度",
    "units": [
      "mg/dL"
    ]
  },
  {
    "name": "QTc",
    "aliases": [
      "補正QT",
      "QTc間隔"
    ],
    "kind": "lab",
    "group": "心電図・心エコー・画像の計測値",
    "units": [
      "ms"
    ]
  },
  {
    "name": "PR間隔",
    "aliases": [
      "PQ間隔"
    ],
    "kind": "lab",
    "group": "心電図・心エコー・画像の計測値",
    "units": [
      "ms"
    ]
  },
  {
    "name": "QRS幅",
    "aliases": [
      "QRS時間"
    ],
    "kind": "lab",
    "group": "心電図・心エコー・画像の計測値",
    "units": [
      "ms"
    ]
  },
  {
    "name": "LVEF",
    "aliases": [
      "EF",
      "左室駆出率"
    ],
    "kind": "lab",
    "group": "心電図・心エコー・画像の計測値",
    "units": [
      "%"
    ]
  },
  {
    "name": "TRPG",
    "aliases": [
      "三尖弁圧較差"
    ],
    "kind": "lab",
    "group": "心電図・心エコー・画像の計測値",
    "units": [
      "mmHg"
    ]
  },
  {
    "name": "IVC径",
    "aliases": [
      "下大静脈径"
    ],
    "kind": "lab",
    "group": "心電図・心エコー・画像の計測値",
    "units": [
      "mm"
    ]
  },
  {
    "name": "CTR",
    "aliases": [
      "心胸郭比"
    ],
    "kind": "lab",
    "group": "心電図・心エコー・画像の計測値",
    "units": [
      "%"
    ]
  },
  {
    "name": "ABI",
    "aliases": [
      "足関節上腕血圧比"
    ],
    "kind": "lab",
    "group": "心電図・心エコー・画像の計測値",
    "units": []
  }
];
