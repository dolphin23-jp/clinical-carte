# AGENTS.md

このリポジトリで作業するエージェント（と人）へのルールです。clinical-carte は、自分用のカルテです。病院のカルテにある患者の情報を、本人が自分の手で写して持ち、AI が整理します。メインは記録で、本人専用です。

状態：段0（骨組み・入口の鍵・常時の帯）まで実装した。患者・受診・取り込みは、まだない（[docs/03-architecture.md](docs/03-architecture.md) の 5）。

作業の前に、次の順で読んでください。

1. このファイル
2. [docs/01-privacy-and-rules.md](docs/01-privacy-and-rules.md)（情報の境界）
3. [docs/00-concept.md](docs/00-concept.md)（構想）と [docs/11-decisions.md](docs/11-decisions.md)（決めたこと CA-xxx と未決 CD-xxx）
4. [docs/04-data-model.md](docs/04-data-model.md)（データモデルと書き込みの一覧）と [docs/03-architecture.md](docs/03-architecture.md)（構成と作る順序）

## 1. 絶対ルール

機能の要求より優先します。要求がこれとぶつかるときは、実装せずに本人に確認してください。

- **決めたこと（CA-xxx）は変えない**。変える必要があると考えたら、実装の前に理由を示して本人に確認する。変えるときは、[docs/11-decisions.md](docs/11-decisions.md) に行を足し、古い行は消さずに「改訂」と書く。
- **未決のこと（CD-xxx）を、推測で埋めない**。仮の値を入れるときは、仮であることが、コードと docs の両方で分かるようにする。
- **持たないもの**：患者ID、氏名、イニシャル、生年月日、住所、電話番号、メール、施設の実名、医療者の個人名。患者ID と記録の対応（台帳）は、どこにも作らない。
- **取り込まないもの**：カルテ画面の撮影、スクリーンショット、OCR、画像・波形そのもの。
- **実データの置き場所**：実在の患者に由来するデータは、リポジトリの作業ツリーに置かない。.gitignore に頼らない。テストと見本は架空症例だけ（`synthetic: true`）。
- **貼った・打った原文は、保存もログもしない**。保存するのは、識別情報を置き換えた後の文と、そこから整理した事実だけ（docs/01 の 2）。
- **AI は、保存する文を書き換えない**。識別情報は、AI が場所を指し、サーバーが決定論で置き換える。**数値は AI に写させない**（決定論で読む）。AI の答えは、機械で確かめられたものだけを事実にし、確かめられなかったものは黙って捨てず、「整理できなかった部分」として残す。
- **書かれていないことを補わない**。入れていない項目は空欄のまま。陰性・正常にしない。
- **判定しない**：値の色分け、正常範囲の判定、警告、診断の提案を作らない。carte は記録で、正本は病院のカルテ。画面に常時「写し・最新とは限らない」を出す。
- **外へ出るのは、Anthropic の API だけ**。解析、テレメトリ、外部フォント、CDN は使わない。共有・公開は作らない。API キーは、サーバーの側だけ。
- **入口は本人だけ**。使うたびのログインは求めない（CA-016）が、入口の鍵がまったくない作りにはしない。鍵の設定がないときは、すべてを断る（鍵なしで動かさない）。記録の中身をログに出さない。
- **選別を通っていない文を、保存しない**。AI の選別が失敗したら、その文は保存せず、画面に残してもう一度送れるようにする。
- **GitHub 上の文書**：実在の施設名は書かない。

### エージェント自身への約束

- 実データらしきものを見つけたら、作業を止めて本人に知らせる。その文字列を引用・要約・ログ出力しない。
- 本人に実データを貼ってもらう、読ませてもらう、という手順を提案しない。再現には架空症例を使う。
- 作業ツリーの外を探索しない。姉妹のリポジトリ（clinical-casebook・clinical-playbook・clinical-RAG）は、部品と考え方の出どころとして読んでよい。それぞれのリポジトリの規則に従う。
- 実在の患者を思わせる具体的な記述を、コード・コメント・テスト・コミットメッセージに書かない。

## 2. 構成の約束

詳しくは [docs/03-architecture.md](docs/03-architecture.md)。

- TypeScript（strict）。pnpm workspaces：`packages/core`（純関数）、`apps/worker`（Cloudflare Workers。API・保存・AI の呼び出し）、`apps/web`（React＋Vite の画面。iPhone・iPad・PC）。
- **core は DOM、ストレージ、通信、時計、乱数、暗号に触れない**。時刻と乱数は引数で受け取る。同じ入力には同じ出力を返す。境界は `eslint.config.js` と `packages/core/tsconfig.src.json`（DOM・Node の型なし）で止める。
- **検査・確かめの関数は core に1つだけ**置き、画面とサーバーが同じ関数を使う（別々に書いて揃える「双子」を作らない）。
- **サーバー**：時計・乱数・暗号に触れるのは `apps/worker/src/runtime.ts` だけ。**ログを出さない**（`console` を使わない）。誤りの答えは名前だけで、何が起きたかの文を返さない。**書き込む表は、[docs/04-data-model.md](docs/04-data-model.md) の 6 の一覧だけ**（表を足すときは、先に一覧を直す。`apps/worker/test/writes.test.ts` が見張る）。表を作る SQL は `apps/worker/migrations/` にだけ置く。
- **入口**（`apps/worker/src/entrance.ts`・`handler.ts`）：合鍵の設定がない・弱いときは、`/api/health` も含めて、すべてを断る。登録していない端末に答えるのは、`/api/health` と端末の登録だけ。合鍵・端末の秘密そのものを、保存先・答え・ログに置かない。変えるときは、同じ変更で `apps/worker/test/entrance.test.ts` を直す。
- **画面**：通信は `apps/web/src/net/api.ts` だけで、宛先は自分のオリジンの `/api/` だけ（Anthropic の API を呼ぶのはサーバー）。**端末の保存先（localStorage・sessionStorage・IndexedDB・Cookie・Cache Storage・Service Worker）を使わない**。インラインの style・script を使わない（CSP）。`apps/web/test/boundary.test.ts` が見張る。
- **常時表示の帯**（`packages/core/src/banner.ts`・`apps/web/src/Banner.tsx`）：どの画面でも出す。消すボタンは作らない。
- 検証は zod。ID は ULID。試験は Vitest と fast-check。画面の E2E は playwright-core（`apps/web/e2e/`。手元のサーバー `apps/worker/test/devserver.ts` が、ビルドした画面と本物の API の処理を、メモリの中の保存先で動かす）。
- 依存を増やすときは、PR に理由を書く。実行時にネットワークへ出る依存（解析、フォント、CDN）は入れない。複数のパッケージで使う依存の版は `pnpm-workspace.yaml` の catalog でそろえる。
- ディレクトリ名に `data` と `exports` を使わない（phi-guard が止める）。`.sqlite`・`.db` のファイルを置かない（試験の保存先は、メモリの中）。

## 3. タスクの進め方

- 仕様を変えるときは、先に docs を直す（同じ PR でよい）。
- 臨床の事実（単位・基準・語彙）を足すときは、出典と確認日を付ける。【事実】【推論】【未確認】を区別する。
- 振る舞いを変える変更は、同じ変更の中に試験を足す。入力の検査、書き込みの一覧、AI への必須の指示は、試験で固定する。
- マージは、本人が確かめてから（エージェントはマージしない）。

## 4. 完了条件

PR を出す前に、次がすべてローカルで通ること。`pnpm check` で5つを順に動かせる。GitHub Actions の CI は置いていない（姉妹のリポジトリと同じく、完了条件は手元の検査）。

| 検査 | コマンド | 中身 |
|---|---|---|
| 型検査 | `pnpm typecheck` | 各パッケージの `tsc`。core・worker・web の src は、それぞれの環境の型だけでも検査する |
| リンタ | `pnpm lint` | ルートで `eslint .`（core の境界、画面の通信と保存先、サーバーのログの規則を含む） |
| ビルド | `pnpm build` | 画面を `apps/web/dist/` にビルドし、`_headers` を作る |
| テスト | `pnpm test` | 各パッケージの Vitest（画面は、単体と E2E）と `node --test 'scripts/*.test.mjs'`（phi-guard） |
| phi-guard | `pnpm phi-guard` | `node scripts/phi-guard.mjs --all` がエラー0 |

- E2E のブラウザ：手元で別の Chromium を使うときは、環境変数 `CARTE_CHROMIUM_PATH` に実行ファイルを指定する。
- フックは `git config core.hooksPath .githooks` で有効にする（pre-commit・pre-merge-commit・commit-msg・pre-push。Casebook から写した）。`--no-verify` で飛ばさない。
- phi-guard の誤検知は、その行に `phi-guard: allow` と理由を書いて許可する。理由のない allow はエラーになる。見つけた文字列そのものは出力されない。規則は、Casebook の `AGENTS.md` の 5 と同じ（`scripts/phi-guard.mjs` は Casebook からの写し。直すときは、Casebook の側と合わせる）。
- 画面を変えたときは、ビルドして、ブラウザ（電話の幅と PC の幅）で開いて確かめる。
- 配る手順は [docs/05-deploy.md](docs/05-deploy.md)。
