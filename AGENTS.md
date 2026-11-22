# AGENTS.md

このリポジトリで作業するエージェント（と人）へのルールです。clinical-carte は、自分用のカルテです。病院のカルテにある患者の情報を、本人が自分の手で写して持ち、AI が整理します。メインは記録で、本人専用です。

状態：段2（AI の整理：文の区切り・投薬・できごと・問題・測定値の取り出しと、その見方）と、見方の洗練（経過表・検査の推移・入力のチップ。[docs/03-architecture.md](docs/03-architecture.md) の 3）、段3a（問題の筋：つなぎ・名前の移り変わり・解決と非活動・問題ごとの A/P と、筋を直す操作・履歴）、段3b（いまの状態：1行の要約〔決定論〕・いまの問題と最後の A/P・24時間・投薬・背景）、段3c（問題の記載の範囲に書かれた値・薬・できごと。決定論）、段3d（回診リスト）、段3e（記録の種類の絞り込み・問題以外の事実を直す操作と履歴）、本人の調節（CA-029：選ぶ直し・なぞって足す・打って直すは選別を通す）、段5（参照元〔clinical-RAG の書籍・ウェブ検索〕。CA-035）、段I（カルテ記載：種類と日を選んで「出す」と出来上がった記載が出て、自分で直す・AI と相談して直す・保存する。数の印。CA-054）と、いま・記録の縮め（CA-055）、段J（AI による振り分け：文章の中の値・時刻の手がかり・経過の出来事と時系列〔CA-056〕、AI のプロブレムリスト〔CA-057〕）、段K1（振り分けられなかった字・薬とデバイスの日数。CA-060）まで実装した。段K2〜（治療と出来事のボード・臨床支援〔CA-059〕・CA-058 の残り）は、これから（[docs/03-architecture.md](docs/03-architecture.md) の 5）。

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
- **AI は、保存する文を書き換えない**。識別情報は、AI が場所を指し、サーバーが決定論で置き換える。**数値は、まず字を決定論で読む**。読めない文章の中の値だけ、AI が読んだ項目と値を使い（CA-056）、AI の数が書かれた場所の字に見つからないものには印（※）を付けて出す（消さない）。日時は AI に作らせない（引用を決定論で読むか、AI の「基準とずれ」から決定論で計算する。幅のあるものは「ごろ」）。AI の答えは、機械で確かめられたものだけを事実にし、確かめられなかったものは黙って捨てず、「整理できなかった部分」として残す。
- **AI の文は、本人が「保存する」を押したものだけを記録に入れる**（CA-054。CA-023・CA-031 の改訂）。例外は「AI の整理」の層（CA-056・CA-057）：経過の出来事の短い要約（要約の数は引用にあるものだけ）と、AI のプロブレムリスト（名前・根拠の短い文。記録の問題の筋か経過の出来事に結びつくものだけ）は、整理として自動で残し、必ず「AI」の印を付け、元の字・記録に書かれた名前をたどれるようにする。カルテ記載（出す・相談して直す）は、出した記載と相談のやりとりは、保存しない・ログに残さない・画面のメモリだけ。**保存は本人の操作で、選別（C-1）を通し、「AI が書いた」「AI が書いて先生が直した」「先生が書いた」の印と、根拠の参照（本文ではなく、場所・題・頁・URL）を付ける**。記載の中の数のうち、資料（記録・出典）に見つからないものには、core の `markNumbers` で印（下線と「※」）を付け、消さない。識別情報の形は伏せる（`checkDocument`）。相談のやりとりは保存しない（CA-032）。病院のカルテへ戻す向き（コピーのボタンなど）は作らない（CA-001・CA-033）。
- **書かれていないことを補わない**。入れていない項目は空欄のまま。陰性・正常にしない。
- **臨床支援（CA-059。「判定しない」の改訂。段K3〜K5 で作る）**：診断基準・スコア・検査値の基準範囲は、**出典と確認日を付けた表**からの決定論の計算だけで出す（コードに数を直書きしない。作成者が書いた定義は、本人が原典を確かめるまで「未確認」。値がない項目は「未入力」で、満たさない・正常としない）。基準を満たす・超えた値には、**印と色**（必ず基準と出典を添える）。**画面の外への通知・音・ポップアップの警告は作らない**。AI の臨床支援（疑う疾患と検査の候補・ガイドラインとの照合・表にない基準の補い）は、書籍（RAG）・ウェブ検索の引用を付け、AI に点数・閾値を計算させない・資料と出典にない用量・閾値・目標値を書かせない・資料にない数には印を付ける・記録だけからの推し量りは「（推論）」と分ける。支援の文と印には「臨床支援」と出どころを付け、写した事実と区別する。最終判断は本人。carte は記録で、正本は病院のカルテ。画面に常時「写し・最新とは限らない」を出す。
- **外へ出るのは、Anthropic の API（ウェブ検索を含む）と、本人の clinical-RAG の検索だけ**（CA-035）。ウェブ検索の検索語に症例固有の値を入れさせない。RAG に送るのは問題の名前だけ。解析、テレメトリ、外部フォント、CDN は使わない。共有・公開は作らない。API キー・RAG の合鍵は、サーバーの側だけ。
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
- **整理**（段2。`apps/worker/src/organize.ts`、core の `organize/`）：保存した文（識別情報を置き換えた後）を AI が整理し、core の `applyOrganization` が確かめた行だけを入れる。AI が返すのは、分類と、文の中の引用と、CA-056 で足した「AI が読んだ値」「時刻の手がかり」「経過の出来事の短い要約」。**事実の文字は、保存した文の、その場所の字そのもの**（経過の出来事の要約だけは AI の文で、印を付ける）。**数はまず引用を決定論で読み（`readLabText`）、読めないときだけ AI の値（字に見つからない数は `unseen`）。日時は引用を決定論で読み（`parseWhen`）、読めないときは手がかりから決定論で計算する（`time/hint.ts`）**。確かめられないものは事実にせず、種類と理由ごとの件数だけを `sources.organize_report` に残す。文そのものは変えない。整理し直すと、その文の行が入れ替わる。失敗したら、それまでの行を残す。変えるときは、同じ変更で core の `organize.test.ts`・`when.test.ts` と、`apps/worker/test/organize.test.ts` を直す。
- **問題の筋**（段3a。`apps/worker/src/problems.ts`、core の `problems/threads.ts`）：記載ごとの問題を、患者ごとの筋につなぐ。名前が同じなら決定論、それ以外は AI が記号で指し、core の `resolveLinks` が確かめる。**AI に送るのは、保存した問題の名前と、その記載の1行だけ**。AI は名前を作らない。本人の直す操作（移す・分ける・統合・表示の名前）は、`history` に残し、**表示の名前は書かれた名前からだけ選ぶ**（打った名前を使わない）。解決・非活動は、書かれたときだけ（CA-025）。変えるときは、同じ変更で core の `threads.test.ts` と、`apps/worker/test/problems.test.ts` を直す。
- **事実を直す**（段3e。`apps/worker/src/facts.ts`、core の `record/edits.ts`）：投薬・できごと・測定値を、外す・戻すと、選ぶだけの直し（投薬の動き・できごとの種類・日時）。**打つ欄を作らない**（打った文は選別を通す決まり）。直した行は origin を self にし、整理し直しでも、同じ場所・同じ字の行に引き継ぐ（`organize.ts`）。直すたびに `fact_edits` に残す（値・印・日時だけ）。外した事実は、見方（経過表・検査・投薬・問題・いま・カルテ記載の資料）から除く。変えるときは、同じ変更で `apps/worker/test/facts.test.ts` を直す。
- **本人の調節**（CA-029。`apps/worker/src/edits.ts`、core の `record/edits.ts`）：本人の行（origin = self）は整理し直しより先（消さない。AI の同じ行は足さない）。**なぞって足す字は保存した文のその場所の字だけ**（`checkSpan`）。**打って直すもの（問題の名前・文の打ち直し）は、必ず `intake` の選別を通してから保存する**（C-1。選別なしで保存する道を作らない）。文を打ち直した記録に、前後の文を残さない。直すたびに `user_edits`（または `history`・`fact_edits`）に残す。変えるときは、同じ変更で core の `edits.test.ts` と、`apps/worker/test/adjust.test.ts` を直す。
- **AI のプロブレムリスト**（CA-057。`apps/worker/src/problemlist.ts`、core の `problems/list.ts`）：資料は記録から決定論で作る（`listMaterial`）。答えは `checkProblemList` が確かめる（結びつけが実在しない項目は出さない・識別情報の形は伏せる・始まった日は結びつけから）。組み直すときは `carryListEdits` で先生の直しを引き継ぐ。保存は `problem_lists`（患者ごとに1つ）、先生の直しは `problem_list_edits`（名前は `intake` の選別を通す）。記録に書かれた問題の筋（段3a）は変えない。変えるときは、同じ変更で core の `list.test.ts` と、`apps/worker/test/sort.test.ts` を直す。
- **カルテ記載**（段I。CA-054。`apps/worker/src/documents.ts`・`references.ts`、core の `notes/document.ts`）：資料は、保存した文（識別情報を置き換えた後）と整理した事実から決定論で作る（`documentMaterial`。範囲は種類と日で決まる。長いときは古い記載を評価と方針の部分だけにし、それでも長ければ落として数を返す）。資料が空なら AI を呼ばない。AI の答えは `checkDocument` が整える（見出しは決めた順・知らない見出しは数える・識別情報の形は伏せる・根拠の記号は実在するものだけ）。保存は `documents` だけ（文は必ず `intake` の選別を通す。見出しをまとめて1回の選別）。直す・消すたびに `document_history`（文なし）。`ai_edited` はサーバーが付ける（直したかは画面が伝える）。出す・相談・参照元の検索の結果は保存しない。**外の検索（RAG・ウェブ検索の係）に渡すのは問題の名前だけ**。RAG はサービスバインディング `RAG` と Secret `RAG_TOKEN` があるときだけ。前の版で残した A/P（`ap_notes`。`apps/worker/src/ap.ts`）は、読む・直す・消すだけ。変えるときは、同じ変更で core の `document.test.ts` と、`apps/worker/test/documents.test.ts` を直す。
- **AI**：呼ぶのは `apps/worker/src/anthropic.ts` の1か所。指示は `apps/worker/src/prompt.ts` の1か所で、変えるときは版（`SELECT_PROMPT_VERSION`・`ORGANIZE_PROMPT_VERSION`・`LINK_PROMPT_VERSION`・`PLIST_PROMPT_VERSION`・`DOC_PROMPT_VERSION`・`DOC_REVISE_PROMPT_VERSION`・`RESEARCH_PROMPT_VERSION`）を上げ、`apps/worker/test/prompt.test.ts` を同じ変更で直し、変更の前後で評価（`apps/worker/eval/`。本物の API で動かすのは本人）を見る。選別・つなぎでは、AI に文を書かせない（返させるのは、場所と種類だけ）。整理で AI が書いてよいのは、読んだ値・時刻の手がかり・経過の出来事の短い要約だけ（CA-056）。文を書かせるのは、ほかに、プロブレムリスト（CA-057）とカルテ記載（CA-054）だけ。指示に書く種類・見出しの一覧は、core の表から差し込む（指示と答えの型を食い違わせない）。
- **評価の道具**（`apps/worker/eval/`。選別の文は `eval/cases.ts`、整理の文と決まりは `eval/organize-cases.ts`）：架空の文だけ。名前・番号・連絡先は、実行時に組み立てる（ファイルに置かない）。実在の文を入れない。**本人は、carte の画面の「選別の評価」から動かす**（`apps/worker/src/selfcheck.ts`・`apps/web/src/SelfCheck.tsx`。配ってあるサーバーの鍵・指示・モデルで、数と id だけを出す。文・結果を保存しない）。エージェントは、本物の API では動かさない（`--dry-run`・`--oracle` と試験だけ）。**整理の評価**は、画面の「整理の評価」（`apps/web/src/OrganizeCheck.tsx`・`/api/selfcheck/organize`）で、いまの版と前の版の指示を同じ文で比べる。前の版の指示（`ORGANIZE_SYSTEM_PREVIOUS`）は、比べるためだけに残し、本番の整理には使わない（比べ終えたら消す）。
- **検査項目の名前**（`packages/core/src/labs/catalog.gen.ts`）は、`node scripts/import_lab_names.mjs <clinical-playbook の作業ツリー>` が作る。**手で直さない**（`--check` で古さを確かめる）。ありうる範囲・換算の倍率を取り込まない（基準範囲は、CA-059 で、出典つきで取り込んでよい。段K3）。carte で足す名前は `labs/extra-names.ts`。
- **測定値は、書かれたとおりに持つ**：補わない・換算しない・持つ値を判定で変えない（基準の印と色は、見方の層で、出典つきの表から付ける。CA-059）。読めなかった部分は、黙って捨てず、理由つきで出す（`packages/core/test/labs.test.ts` の性質の試験）。
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
