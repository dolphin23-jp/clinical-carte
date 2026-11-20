# 05 配る手順（Cloudflare）

状態：段0 の手順。

- **手元の試運転（1）は、実際に動かして確かめた**（登録・通過・拒否まで）。
- **Cloudflare に配る手順（2〜4）は、まだ、本人が動かして確かめていない**（エージェントは Cloudflare のアカウントに触れない。`wrangler deploy --dry-run` で、画面と Worker を束ねられることだけを確かめた）。画面の名前・出力が違っていたら、ここを直す。

## まず：Cloudflare で何をするのか

**なぜ要るか**：記録を、iPhone・iPad・PC のどれからでも同じように見る・書くため（CA-011）。どの端末も、記録を自分の中に持たない。記録は、インターネットの上の「1か所」にあり、端末は、そこへ読み書きしに行く。その「1か所」を、Cloudflare に置く。自分でサーバーの機械を買ったり、借りて見張ったりしなくてよい。

**Cloudflare が受け持つ4つの役**（どれも、ひとつの Cloudflare のアカウントの中で動く）：

| 役 | Cloudflare の名前 | このプロジェクトでの中身 |
|---|---|---|
| 住所と暗号 | `workers.dev` の https のアドレス | `https://clinical-carte.<自分の名前>.workers.dev`。通信は暗号化される |
| 画面を配る | Workers の静的ファイル（Assets） | `apps/web` をビルドした画面（開くと出る見た目）。患者の情報は入っていない |
| 受付と処理 | Worker | `apps/worker` のプログラム。端末の印を確かめ、記録を読み書きし、（段2 から）AI に頼む。**入口の鍵の確認は、ここでする** |
| 記録を置く | D1（データベース） | 患者・記録の本体。いまは、端末の登録の表だけ |

**端末で開いたとき**：

```
iPhone ──https──▶ Cloudflare ─┬─ 画面だけを返す（ログインなし）
                              └─ /api/ への要求 ──▶ Worker ──▶ D1
                                   └ 印がなければ断る     └ 記録の読み書き
```

**先生が Cloudflare でやること**は、突き詰めると次の3つだけ（手順は 2）：

1. **保存先の入れ物を作る**（D1 を1つ作る）
2. **プログラムと画面を置く**（`wrangler deploy`。コマンド1つ）
3. **合鍵を、サーバーの秘密として置く**（`wrangler secret put`。画面にも履歴にも残らない）

あとは、端末ごとに、画面で合鍵を入れて登録するだけ（Cloudflare の画面は、もう触らない）。

**Cloudflare がやらないこと**：ログインの仕組み（Cloudflare Access は使わない。CA-016。入口の鍵は、carte 自身の仕組み）、AI の処理（Anthropic の API に、Worker が頼む。段2 から）、記録の中身の理解（Cloudflare は、置いているだけ）。

**記録が、どこにあるか**：Cloudflare の D1（Cloudflare が管理するデータセンター）。端末には、印（Cookie）が1つあるだけで、記録は残らない。Cloudflare 社の側からは、技術的には見える立場にある（このプロジェクトは、アカウントの守り〔2段階認証〕と、入口の鍵で守る。暗号化して、サーバーにも読めなくする方式は採っていない。CD-004）。

配るのは、1つの Worker（`clinical-carte`）：画面（`apps/web/dist`）と、API（`apps/worker`）と、保存先（D1）。設定は `wrangler.jsonc`。RAG（`medbook-rag`）も、同じ形（Worker＋D1）で、同じ Cloudflare のアカウントに置ける。

## 0. 用意するもの

| もの | 内容 |
|---|---|
| Cloudflare のアカウント | 無料のプランで足りる見込み【未確認】。**2段階認証を付ける**（アカウントを取られると、入口の鍵に関係なく、記録を読まれる。CD-004） |
| GitHub のアカウント | 同じく、2段階認証を付ける |
| 手元の計算機 | Node 22.18 以上、pnpm 10、`openssl`（なければ 2.3 の別の方法）。このリポジトリを clone してある |
| パスワード管理の道具 | 合鍵（2.3）を控える。iPhone・iPad で入れるとき、コピー＆貼り付けで入れられる道具（iCloud キーチェーンなど） |

```sh
git clone https://github.com/dolphin23-jp/clinical-carte
cd clinical-carte
pnpm install
```

## 1. 手元で試運転する（Cloudflare に何も作らない。最初に1回）

配る前に、本物の Worker と画面を手元で動かして、入口の動きを見る。保存先は、手元の `.wrangler/` の中（Git に入らない）。

```sh
pnpm build
printf 'CARTE_KEY=%s\n' "$(openssl rand -hex 32)" > .dev.vars   # 試運転だけの合鍵（.dev.vars は Git に入らない）
npx wrangler d1 migrations apply clinical-carte --local         # 手元の保存先に表を作る
npx wrangler dev                                                 # http://localhost:8787 で動く
```

- ブラウザで `http://localhost:8787` を開く → 「この端末を登録する」が出る。
- 合鍵は、`.dev.vars` の `CARTE_KEY=` の右側（エディタで開いて、コピーする）。端末の種類を選んで「登録する」 → 「登録した端末」の一覧が出る。
- 読み込み直しても、登録の画面は出ない。
- **PC の Chrome で試す**。iPhone の Safari は、http の `localhost` では、Secure つきの印を受け付けない見込み【推論】。iPhone は、本番の https で試す。
- 止めるときは、`Ctrl+C`。試運転が終わったら、`.dev.vars` と `.wrangler/` を消してよい。

curl で見るなら（`npx wrangler dev` を動かしたまま、別の窓で）：

```sh
curl -s http://localhost:8787/api/health      # {"ok":true}
curl -s -w ' [%{http_code}]\n' http://localhost:8787/api/session   # {"error":"unregistered"} [401]
```

## 2. Cloudflare に配る：手元から（推奨）

### 2.1 ログイン

```sh
npx wrangler login
```

ブラウザが開く → Cloudflare にログインして、許可する。確かめ：`npx wrangler whoami` に、自分のアカウントが出る。

### 2.2 保存先（D1）を作る（最初の1回）

```sh
npx wrangler d1 create clinical-carte
```

- 出力に、`database_id`（UUID）が出る。**これを、`wrangler.jsonc` の `database_id`（いまは仮の値 `0000…`）に書き換えて、コミットする**。D1 の id は秘密ではない（患者の番号でもない）。
- 「設定ファイルに足しますか」と聞かれたら、**足さない**（`wrangler.jsonc` に、すでに書いてある）。
- 確かめ：`npx wrangler d1 list` に `clinical-carte` が出る。

### 2.3 合鍵を作って、先に控える

```sh
openssl rand -hex 32
```

- 64文字が出る。**画面に出た時点で、パスワード管理の道具に控える**（名前は「carte の合鍵」など）。リポジトリ・会話・メモ・メッセージに書かない。
- `openssl` がないときは：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- サーバーが受け付ける合鍵は、32文字以上で、字の種類が12以上。上の方法で作れば満たす。

### 2.4 配る

```sh
pnpm build
npx wrangler deploy
```

- 初めてのとき、`workers.dev` のアドレスの名前（アカウントごとの名前）を決めるよう聞かれることがある。決めると、`https://clinical-carte.<決めた名前>.workers.dev` になる。
- 終わりに、そのアドレスが出る。**控える**（端末で開くアドレス）。
- この時点では、合鍵も表もないので、サーバーは**すべてを断る**（これで正しい。鍵なしで動かさない）。確かめ：

```sh
curl -s https://clinical-carte.<決めた名前>.workers.dev/api/health   # {"error":"no_key"}
```

### 2.5 表を作る

```sh
npx wrangler d1 migrations apply clinical-carte --remote
```

- 「適用するか」と聞かれたら、`y`。`0001_entrance.sql` に ✅ が付く。
- **`--remote` を付け忘れると、手元の保存先に作るだけ**で、本番には何も起きない（本番で `no such table` の誤りになる）。

### 2.6 合鍵を置く

```sh
npx wrangler secret put CARTE_KEY
```

- 聞かれたら、2.3 の合鍵を貼る（画面には出ない）。
- 確かめ：

```sh
curl -s https://clinical-carte.<決めた名前>.workers.dev/api/health   # {"ok":true}
curl -s -w ' [%{http_code}]\n' https://clinical-carte.<決めた名前>.workers.dev/api/session   # {"error":"unregistered"} [401]
```

health が `ok`、session が 401 なら、入口は動いている。

### 2.7 端末を登録する（端末ごとに1回）

端末ごとに、次のとおり。

1. 2.4 のアドレスを開く → 「この端末を登録する」。
2. 合鍵を**貼り付ける**（64文字は、打たない）。端末の種類を確かめて、「登録する」。
3. 「登録した端末」に、この端末が「この端末」の印つきで出れば成功。以後、この端末では登録の画面は出ない。

端末ごとの注意：

| 端末 | 注意 |
|---|---|
| iPhone・iPad | 合鍵は、Mac の「ユニバーサルクリップボード」や、パスワード管理の道具から貼る。**ホーム画面に足して使うなら、足したあと、ホーム画面のアイコンから開いた側で登録する**（Safari とホーム画面のアプリで、印の置き場が別になる見込み【推論。実機で確かめる】）。プライベートブラウズでは、閉じると印が消える |
| PC | 通常のウィンドウで登録する（シークレットでは、閉じると印が消える） |

登録の間違いは、1日 20 回まで（日本の日。超えると、その日は新しい登録を受け付けない。登録済みの端末は使える）。

## 3. Cloudflare に配る：GitHub とつなぐ（任意）

push のたびに自動で配りたいときだけ。**2 の最初の1回（2.1〜2.2・2.5・2.6）は、手元で済ませてから**にする。

- Cloudflare の画面で、Workers & Pages → 新しく作る → Git のリポジトリを取り込む → `clinical-carte` を選ぶ。
- Worker の名前は `clinical-carte`（`wrangler.jsonc` の `name` と同じ。違うと止まる）。
- ビルドのコマンド：`pnpm build`。デプロイのコマンド：`npx wrangler deploy`（初期値のまま）。
- 配る対象のブランチは、`main`（まだない。決まったら書く）。
- 合鍵は、Worker の Settings → Variables and Secrets に、**種類を Secret にして** `CARTE_KEY` で足せる（`secret put` と同じ）。
- 表（migrations）は、ここでは自動で動かない。足したときは、手元で `npx wrangler d1 migrations apply clinical-carte --remote` を動かす。デプロイのコマンドに足せるかは、確かめていない【未確認】。
- 画面の名前は変わりうる。違っていたら、Cloudflare の案内に従う。

## 4. 運用

| こと | やり方 |
|---|---|
| 新しい版を配る | `git pull` → `pnpm install` → `pnpm build` → `npx wrangler deploy`。migrations が増えたときは、`deploy` の前に、`d1 migrations apply … --remote` |
| 端末をなくした | 登録済みの別の端末で開く → 「登録した端末」→ なくした端末の「外す」→ 「外す」で確定。外された端末は、合鍵を入れ直すまで、記録を開けない |
| 全部の端末を失った・合鍵を忘れた | 合鍵は、`npx wrangler secret put CARTE_KEY` で、いつでも置き直せる。新しい合鍵で、端末を登録し直す。古い端末の登録は、残ったままなので、使わない端末は、新しい端末から外す |
| 合鍵が漏れたかもしれない | `secret put` で新しい合鍵に置き換える。**登録済みの端末は、そのまま通る**ので、知らない端末が登録されていないか、「登録した端末」を見る。知らない端末があれば、外す |
| 合鍵を変えたい | `secret put`。端末の印は、合鍵とは別なので、登録済みの端末は、入れ直さなくてよい |
| 記録を消したい | 段1 以降で、患者ごとに消せるようにする（CA-020）。D1 ごと消すなら、`npx wrangler d1 delete clinical-carte`（全部の記録が消える。戻せない） |

## 5. うまくいかないとき

| 症状 | 原因と直し方 |
|---|---|
| 画面に「サーバーに合鍵が設定されていません」 | `CARTE_KEY` が、置かれていない・32文字未満・字の種類が少ない。2.6 をやり直す |
| `wrangler deploy` が、`database_id` で止まる | 仮の値（`0000…`）のまま。2.2 の id を書く |
| 登録で、画面に「サーバーで問題が起きました」 | 表がない見込み。2.5 を、`--remote` つきでやり直す |
| 「合鍵が違います」 | 貼り付けた合鍵に、前後の空白・改行が入っていないか。`secret put` で置いたものと、同じか。1日 20 回で、その日は止まる |
| 「今日は…登録を受け付けません」 | 合鍵の間違いが 20 回になった。日本の日が変わるまで待つ。登録済みの端末は使える |
| 「登録できる端末は 10 台までです」 | 使わない端末を、登録済みの端末から外す |
| 登録したのに、次に開くとまた登録の画面 | iPhone・iPad で、Safari とホーム画面のアプリを、行き来していないか。プライベートブラウズ・閲覧データの消去・ブラウザを変えた、でも起きる |
| 書き込み（外す・登録）が、403 になる | 自分のオリジンの画面からだけ、書き込める。別のアドレス・中継のサービスを経由していないか |
| curl の `/api/session` が、印を付けても 401 | 本番の印は `__Host-carte`（https のときの名前）。`-H 'cookie: __Host-carte=…'` と、名前ごと付ける。印は、登録の応答の `Set-Cookie` にある（`curl -D -`） |

## 6. 守りの確認（配ったあと）

- [ ] Cloudflare と GitHub に、2段階認証を付けた
- [ ] 合鍵を、パスワード管理の道具にだけ控えた（リポジトリ・会話・メモにない）
- [ ] `/api/health` が `ok`、`/api/session` が、登録していない端末で 401
- [ ] 「登録した端末」に、自分の端末だけがある
- [ ] `wrangler.jsonc` で、要求の記録（ログ）と、作業ブランチの公開を止めてある（`observability` が `false`、`preview_urls` が `false`）

## 7. わからないこと・確かめていないこと

- Cloudflare の無料のプランで、D1 と Workers の上限に収まるか【未確認】。段1 以降で記録が増えたら見る。
- 記録（D1）が、どの国のデータセンターに置かれるか。`d1 create` に、地域の希望（`--location`。`apac` など）を付けられる見込みだが、日本に限る指定ができるかは、確かめていない【未確認】。AI の API（Anthropic）は国外なので、段2 からは、打った文が国外に届く（docs/01 の 2）。
- `workers.dev` のアドレスは、誰でも開ける（入口の鍵が守る）。独自のドメインにするかは、決めていない。
- Cloudflare の画面の名前、`wrangler` の聞き方・出力は、版で変わる。違っていたら、この文書を直す。
