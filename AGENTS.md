# AGENTS.md

このリポジトリで作業するエージェント（と人）へのルールです。clinical-carte は、自分用のカルテです。病院のカルテにある患者の情報を、本人が自分の手で写して持ち、AI が整理します。メインは記録で、本人専用です。

状態：段2（AI の整理：文の区切り・投薬・できごと・問題・測定値の取り出しと、その見方）と、見方の洗練（経過表・検査の推移・入力のチップ。[docs/03-architecture.md](docs/03-architecture.md) の 3）、段3a（問題の筋：つなぎ・名前の移り変わり・解決と非活動・問題ごとの A/P と、筋を直す操作・履歴）、段3b（いまの状態：1行の要約〔決定論〕・いまの問題と最後の A/P・24時間・投薬・背景）、段3c（問題の記載の範囲に書かれた値・薬・できごと。決定論）、段3d（回診リスト）、段3e（記録の種類の絞り込み・問題以外の事実を直す操作と履歴）、段4 のはじめ（AI の草案：入院後経過。保存しない）まで実装した（[docs/03-architecture.md](docs/03-architecture.md) の 5）。

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
- **AI の文は、記録に入れない**。AI が文を書くのは、段4 の草案（CA-023）だけ：保存しない・ログに残さない・画面のメモリだけ。文ごとに根拠の引用の記号を付けさせ、core の `checkDraft` が、記号・その問題の引用か・文の中の数が根拠の引用にあるか・識別情報の形を確かめ、通らない文は出さずに数だけを出す。病院のカルテへ戻す向き（コピーのボタンなど）は作らない（CA-001）。
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
- **サーバー**：時計・乱数・暗号に触れるのは `apps/worker/src/runtime.ts` だけ。**ログを出さない**（`console` を使わない）。誤りの答えは名前だけで、何が起きたかの文を返さない。**書き込む表は、[docs/04-data-model.md](docs/04-data-model.md) の 6 の一覧だけ**（表を足すときは、先に一覧を直す。`apps/worker/test/writes.test.ts` が見張る）。表を作る SQL は `apps/worker/migrations/` にだけ置く（番号は `0000_` から続ける。**表や中身を消す文を書かない**）。足したら `node scripts/build_migrations.mjs` で写し（`apps/worker/src/migrations.gen.ts`。手で直さない）を作り直す。サーバーは、最初の要求のとき、まだ適用していない分を自分で適用する（`schema.ts`。`apps/worker/test/schema.test.ts`）。
- **入口**（`apps/worker/src/entrance.ts`・`handler.ts`）：合鍵の設定がない・弱いときは、`/api/health` も含めて、すべてを断る。登録していない端末に答えるのは、`/api/health` と端末の登録だけ。合鍵・端末の秘密そのものを、保存先・答え・ログに置かない。変えるときは、同じ変更で `apps/worker/test/entrance.test.ts` を直す。
- **取り込み**（`apps/worker/src/intake.ts`）：打った文 → 整え → AI の選別 → 決定論の置き換え（core の `applySelection`）→ 形の検査（`replaceShapes`）→ 測定値の読み取り（`readLabText`。種類が検査結果・バイタルのときだけ）。**保存するのは、この流れが返した文だけ**。選別なしで保存する道を作らない（AI の鍵がないときは、文を入れられない）。変えるときは、同じ変更で `apps/worker/test/records.test.ts` と、core の `selection.test.ts`・`shapes.test.ts` を直す。
- **整理**（段2。`apps/worker/src/organize.ts`、core の `organize/`）：保存した文（識別情報を置き換えた後）を AI が整理し、core の `applyOrganization` が確かめた行だけを入れる。AI が返すのは、分類と、文の中の引用だけ。**事実の文字は、保存した文の、その場所の字そのもの**。**数は引用を決定論で読み（`readLabText`）、日時は引用を決定論で読む（`parseWhen`）**。確かめられないものは事実にせず、種類と理由ごとの件数だけを `sources.organize_report` に残す。文そのものは変えない。整理し直すと、その文の行が入れ替わる。失敗したら、それまでの行を残す。変えるときは、同じ変更で core の `organize.test.ts`・`when.test.ts` と、`apps/worker/test/organize.test.ts` を直す。
- **問題の筋**（段3a。`apps/worker/src/problems.ts`、core の `problems/threads.ts`）：記載ごとの問題を、患者ごとの筋につなぐ。名前が同じなら決定論、それ以外は AI が記号で指し、core の `resolveLinks` が確かめる。**AI に送るのは、保存した問題の名前と、その記載の1行だけ**。AI は名前を作らない。本人の直す操作（移す・分ける・統合・表示の名前）は、`history` に残し、**表示の名前は書かれた名前からだけ選ぶ**（打った名前を使わない）。解決・非活動は、書かれたときだけ（CA-025）。変えるときは、同じ変更で core の `threads.test.ts` と、`apps/worker/test/problems.test.ts` を直す。
- **事実を直す**（段3e。`apps/worker/src/facts.ts`、core の `record/edits.ts`）：投薬・できごと・測定値を、外す・戻すと、選ぶだけの直し（投薬の動き・できごとの種類・日時）。**打つ欄を作らない**（打った文は選別を通す決まり）。直した行は origin を self にし、整理し直しでも、同じ場所・同じ字の行に引き継ぐ（`organize.ts`）。直すたびに `fact_edits` に残す（値・印・日時だけ）。外した事実は、見方（経過表・検査・投薬・問題・いま・草案）から除く。変えるときは、同じ変更で `apps/worker/test/facts.test.ts` を直す。
- **草案**（段4。`apps/worker/src/draft.ts`、core の `draft/course.ts`）：資料は、保存した文から決定論で切り出した引用だけ（問題ごとの A・P と、その問題の記載に書かれた投薬・できごと）。資料が空なら AI を呼ばない。草案は保存しない。変えるときは、同じ変更で core の `draft.test.ts` と、`apps/worker/test/draft.test.ts` を直す。
- **AI**：呼ぶのは `apps/worker/src/anthropic.ts` の1か所。指示は `apps/worker/src/prompt.ts` の1か所で、変えるときは版（`SELECT_PROMPT_VERSION`・`ORGANIZE_PROMPT_VERSION`・`LINK_PROMPT_VERSION`・`DRAFT_PROMPT_VERSION`）を上げ、`apps/worker/test/prompt.test.ts` を同じ変更で直し、変更の前後で評価（`apps/worker/eval/`。本物の API で動かすのは本人）を見る。整理・選別・つなぎでは、AI に文を書かせない（返させるのは、場所と種類だけ）。文を書かせるのは草案だけ（上の決まり）。指示に書く種類・見出しの一覧は、core の表から差し込む（指示と答えの型を食い違わせない）。
- **評価の道具**（`apps/worker/eval/`。文は `eval/cases.ts`）：架空の文だけ。名前・番号・連絡先は、実行時に組み立てる（ファイルに置かない）。実在の文を入れない。**本人は、carte の画面の「選別の評価」から動かす**（`apps/worker/src/selfcheck.ts`・`apps/web/src/SelfCheck.tsx`。配ってあるサーバーの鍵・指示・モデルで、数と id だけを出す。文・結果を保存しない）。エージェントは、本物の API では動かさない（`--dry-run`・`--oracle` と試験だけ）。
- **検査項目の名前**（`packages/core/src/labs/catalog.gen.ts`）は、`node scripts/import_lab_names.mjs <clinical-playbook の作業ツリー>` が作る。**手で直さない**（`--check` で古さを確かめる）。基準範囲・ありうる範囲・換算の倍率を取り込まない。carte で足す名前は `labs/extra-names.ts`。
- **測定値は、書かれたとおりに持つ**：補わない・換算しない・判定しない。読めなかった部分は、黙って捨てず、理由つきで出す（`packages/core/test/labs.test.ts` の性質の試験）。
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
- 配る手順は [docs/05-deploy.md](docs/05-deploy.md)。**本人は、コマンドを打たない**（iPhone の画面の操作だけ）。配るのに、本人の手作業（コマンド・SQL の貼り付けなど）が要る変更を足さない。要るときは、先に本人に確かめる。
