# clinical-carte

自分用のカルテ。病院のカルテにある患者の情報を、本人が自分の手で写して持ち、AI が整理する。メインは記録。本人専用。

状態：段2（AI の整理：文の区切り・投薬・できごと・問題・測定値と、その見方）と、見方の洗練（経過表〔温度板・投薬・できごと〕・検査の推移・入力のチップとひな形）、段3a（問題の筋：POMR のプロブレムリスト）、段3b（いまの状態）、段3c（問題に書かれた値・薬）、段3d（回診リスト）、段3e（事実を直す操作）、本人の調節（問題・記載・事実を、選ぶ・なぞって足す・打って直す〔選別を通す〕）、段4 のはじめ（入院後経過の草案）、段5（記載：日ごとの S・O と A/P。A/P は自分で書くか AI の案から選ぶ。参照元は書籍〔clinical-RAG〕とネットのガイドライン。AI との議論は保存しない）まで。直す操作と履歴は、まだない。**実データを入れるのは、選別の評価（docs/05 の 2.8）を動かしてから**。

| 文書 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 作業のルール |
| [docs/00-concept.md](docs/00-concept.md) | 構想（何か・なぜ・層・取り込みの流れ・段階・危険） |
| [docs/01-privacy-and-rules.md](docs/01-privacy-and-rules.md) | 情報の境界（持つもの・持たないもの・匿名化の網・保存の守り） |
| [docs/03-architecture.md](docs/03-architecture.md) | 構成（core・worker・web）、入口、AI の呼び出し、作る順序 |
| [docs/04-data-model.md](docs/04-data-model.md) | データモデル（表・約束・AI の答えの確かめ方・書き込みの一覧。案） |
| [docs/05-deploy.md](docs/05-deploy.md) | 配る手順（iPhone の画面だけで。D1・Worker・合鍵・端末の登録・AI の鍵・評価） |
| [docs/11-decisions.md](docs/11-decisions.md) | 決めたこと（CA-xxx）と未決（CD-xxx） |

## セットアップ

```sh
pnpm install
git config core.hooksPath .githooks
pnpm check
```

- Node 22.18 以上、pnpm 10。
- E2E は、Chromium を playwright-core で動かす。別の Chromium を使うときは、環境変数 `CARTE_CHROMIUM_PATH` に実行ファイルを指定する。
