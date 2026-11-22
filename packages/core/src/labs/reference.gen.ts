// このファイルは scripts/import_lab_names.mjs が作る。手で直さない。
// 出どころ：clinical-playbook の config/lab-catalog.yaml（コミット 05191212bee60b0456b9c2ec651e0fdf90f393a0）の reference と sources。 phi-guard: allow コミットの id
// 基準範囲は、健常者の測定値の中央 95%の区間で、診断・治療の臨床判断値ではない。施設・測定法で違うことがある（CA-059。本人の確認まで「未確認」）。

export interface ReferenceSource {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  /** 出典を確かめた日（Playbook の記録） */
  readonly checkedOn: string | null;
  readonly note: string | null;
}

export interface ReferenceRange {
  readonly sex: 'any' | 'M' | 'F';
  readonly low: number;
  readonly high: number;
}

export interface LabReference {
  /** カタログの正規の名前 */
  readonly name: string;
  /** 基準範囲の単位（カタログの単位。換算しない） */
  readonly unit: string;
  readonly source: string;
  readonly ranges: readonly ReferenceRange[];
  readonly note: string | null;
}

/** 本人が、自分の施設の基準範囲と照らして確かめたか（Playbook の confirmed）。false の間は、画面に「未確認の目安」と出す */
export const REFERENCE_CONFIRMED = false;
/** 表全体の注意 */
export const REFERENCE_NOTE = "基準範囲は JCCLS 共用基準範囲（健常者の中央 95%の区間）の目安です。施設や測定法で違うことがあり、臨床判断値ではありません（未確認）。";
/** 基準範囲を使う最小の年齢（成人の範囲。小児には出さない） */
export const REFERENCE_MIN_AGE = 18;

export const REFERENCE_SOURCES: readonly ReferenceSource[] = [
  {
    "id": "JCCLS-2022",
    "title": "日本における主要な臨床検査項目の共用基準範囲 ―解説と利用の手引き―（2022/10/01 版。JCCLS 基準範囲共用化委員会 編）の表1-1",
    "url": "https://www.jccls.org/wp-content/uploads/2022/10/kijyunhani20221031.pdf",
    "checkedOn": "2026-10-07",
    "note": "性差の指数（SDR）が 0.5 以上の項目は、男女別。それ以外は男女共通。採血は、10 時間以上の絶食後の午前、座位安静後（表1-1 の条件）"
  }
];

export const LAB_REFERENCES: readonly LabReference[] = [
  {
    "name": "WBC",
    "unit": "/μL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 3300,
        "high": 8600
      }
    ],
    "note": "JCCLS は 3.3〜8.6（10^3/μL）。/μL に換算（×1000）"
  },
  {
    "name": "RBC",
    "unit": "万/μL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "M",
        "low": 435,
        "high": 555
      },
      {
        "sex": "F",
        "low": 386,
        "high": 492
      }
    ],
    "note": "JCCLS は 男 4.35〜5.55、女 3.86〜4.92（10^6/μL）。万/μL に換算（×100）"
  },
  {
    "name": "Hb",
    "unit": "g/dL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "M",
        "low": 13.7,
        "high": 16.8
      },
      {
        "sex": "F",
        "low": 11.6,
        "high": 14.8
      }
    ],
    "note": null
  },
  {
    "name": "Ht",
    "unit": "%",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "M",
        "low": 40.7,
        "high": 50.1
      },
      {
        "sex": "F",
        "low": 35.1,
        "high": 44.4
      }
    ],
    "note": null
  },
  {
    "name": "MCV",
    "unit": "fL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 83.6,
        "high": 98.2
      }
    ],
    "note": null
  },
  {
    "name": "MCH",
    "unit": "pg",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 27.5,
        "high": 33.2
      }
    ],
    "note": null
  },
  {
    "name": "MCHC",
    "unit": "%",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 31.7,
        "high": 35.3
      }
    ],
    "note": "JCCLS は g/dL。g/dL と % は同じ数（100 mL あたりの g）"
  },
  {
    "name": "Plt",
    "unit": "万/μL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 15.8,
        "high": 34.8
      }
    ],
    "note": "JCCLS は 158〜348（10^3/μL）。万/μL に換算（÷10）"
  },
  {
    "name": "TP",
    "unit": "g/dL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 6.6,
        "high": 8.1
      }
    ],
    "note": null
  },
  {
    "name": "Alb",
    "unit": "g/dL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 4.1,
        "high": 5.1
      }
    ],
    "note": null
  },
  {
    "name": "AST",
    "unit": "U/L",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 13,
        "high": 30
      }
    ],
    "note": null
  },
  {
    "name": "ALT",
    "unit": "U/L",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "M",
        "low": 10,
        "high": 42
      },
      {
        "sex": "F",
        "low": 7,
        "high": 23
      }
    ],
    "note": null
  },
  {
    "name": "LDH",
    "unit": "U/L",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 124,
        "high": 222
      }
    ],
    "note": null
  },
  {
    "name": "γ-GTP",
    "unit": "U/L",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "M",
        "low": 13,
        "high": 64
      },
      {
        "sex": "F",
        "low": 9,
        "high": 32
      }
    ],
    "note": null
  },
  {
    "name": "T-Bil",
    "unit": "mg/dL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 0.4,
        "high": 1.5
      }
    ],
    "note": null
  },
  {
    "name": "ChE",
    "unit": "U/L",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "M",
        "low": 240,
        "high": 486
      },
      {
        "sex": "F",
        "low": 201,
        "high": 421
      }
    ],
    "note": null
  },
  {
    "name": "AMY",
    "unit": "U/L",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 44,
        "high": 132
      }
    ],
    "note": null
  },
  {
    "name": "CK",
    "unit": "U/L",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "M",
        "low": 59,
        "high": 248
      },
      {
        "sex": "F",
        "low": 41,
        "high": 153
      }
    ],
    "note": null
  },
  {
    "name": "BUN",
    "unit": "mg/dL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 8,
        "high": 20
      }
    ],
    "note": null
  },
  {
    "name": "Cr",
    "unit": "mg/dL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "M",
        "low": 0.65,
        "high": 1.07
      },
      {
        "sex": "F",
        "low": 0.46,
        "high": 0.79
      }
    ],
    "note": null
  },
  {
    "name": "UA",
    "unit": "mg/dL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "M",
        "low": 3.7,
        "high": 7.8
      },
      {
        "sex": "F",
        "low": 2.6,
        "high": 5.5
      }
    ],
    "note": null
  },
  {
    "name": "Na",
    "unit": "mEq/L",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 138,
        "high": 145
      }
    ],
    "note": "JCCLS は mmol/L。1価のイオンなので mEq/L と同じ数"
  },
  {
    "name": "K",
    "unit": "mEq/L",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 3.6,
        "high": 4.8
      }
    ],
    "note": "JCCLS は mmol/L。1価のイオンなので mEq/L と同じ数"
  },
  {
    "name": "Cl",
    "unit": "mEq/L",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 101,
        "high": 108
      }
    ],
    "note": "JCCLS は mmol/L。1価のイオンなので mEq/L と同じ数"
  },
  {
    "name": "Ca",
    "unit": "mg/dL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 8.8,
        "high": 10.1
      }
    ],
    "note": null
  },
  {
    "name": "IP",
    "unit": "mg/dL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 2.7,
        "high": 4.6
      }
    ],
    "note": null
  },
  {
    "name": "HbA1c",
    "unit": "%",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 4.9,
        "high": 6
      }
    ],
    "note": null
  },
  {
    "name": "CRP",
    "unit": "mg/dL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 0,
        "high": 0.14
      }
    ],
    "note": null
  },
  {
    "name": "Fe",
    "unit": "μg/dL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 40,
        "high": 188
      }
    ],
    "note": null
  },
  {
    "name": "IgG",
    "unit": "mg/dL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 861,
        "high": 1747
      }
    ],
    "note": null
  },
  {
    "name": "IgA",
    "unit": "mg/dL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 93,
        "high": 393
      }
    ],
    "note": null
  },
  {
    "name": "IgM",
    "unit": "mg/dL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "M",
        "low": 33,
        "high": 183
      },
      {
        "sex": "F",
        "low": 50,
        "high": 269
      }
    ],
    "note": null
  },
  {
    "name": "C3",
    "unit": "mg/dL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 73,
        "high": 138
      }
    ],
    "note": null
  },
  {
    "name": "C4",
    "unit": "mg/dL",
    "source": "JCCLS-2022",
    "ranges": [
      {
        "sex": "any",
        "low": 11,
        "high": 31
      }
    ],
    "note": null
  }
];
