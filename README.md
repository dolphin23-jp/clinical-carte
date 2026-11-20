# clinical-carte

自分用のカルテ。病院のカルテにある患者の情報を、本人が自分の手で写して持ち、AI が整理する。メインは記録。本人専用。

状態：段0（骨組み・入口の鍵・常時の帯）まで。患者・受診・取り込みは、まだない。

| 文書 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 作業のルール |
| [docs/00-concept.md](docs/00-concept.md) | 構想（何か・なぜ・層・取り込みの流れ・段階・危険） |
| [docs/01-privacy-and-rules.md](docs/01-privacy-and-rules.md) | 情報の境界（持つもの・持たないもの・匿名化の網・保存の守り） |
| [docs/03-architecture.md](docs/03-architecture.md) | 構成（core・worker・web）、入口、AI の呼び出し、作る順序 |
| [docs/04-data-model.md](docs/04-data-model.md) | データモデル（表・約束・AI の答えの確かめ方・書き込みの一覧。案） |
| [docs/05-deploy.md](docs/05-deploy.md) | 配る手順（Cloudflare。D1・合鍵・端末の登録） |
| [docs/11-decisions.md](docs/11-decisions.md) | 決めたこと（CA-xxx）と未決（CD-xxx） |

## セットアップ

```sh
pnpm install
git config core.hooksPath .githooks
pnpm check
```

- Node 22.18 以上、pnpm 10。
- E2E は、Chromium を playwright-core で動かす。別の Chromium を使うときは、環境変数 `CARTE_CHROMIUM_PATH` に実行ファイルを指定する。
