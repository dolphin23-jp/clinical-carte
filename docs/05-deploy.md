# 05 配る手順（Cloudflare）

状態：段0 の時点の手順。**まだ、本人が実際に動かして確かめていない**（エージェントは、Cloudflare のアカウントに触れない）。動かして違っていたら、ここを直す。

配るのは、1つの Worker（`clinical-carte`）：画面（`apps/web/dist`）と、API（`apps/worker`）と、保存先（D1）。設定は `wrangler.jsonc`。

## 1. 保存先（D1）を作る（最初の1回）

```sh
npx wrangler d1 create clinical-carte
```

出てきた `database_id` を、`wrangler.jsonc` の `database_id` に書く（置き換えるまで、デプロイできない）。

## 2. 表を作る（最初と、migrations を足したとき）

```sh
npx wrangler d1 migrations apply clinical-carte --remote
```

## 3. 合鍵を決めて、サーバーに置く（最初の1回）

合鍵は、端末を登録するときに1回ずつ入れる、長い文字列（CA-019）。32文字以上で、字の種類が多いこと（短い・単純な合鍵では、サーバーはすべてを断る）。

```sh
openssl rand -hex 32        # 合鍵を作る（64文字）
npx wrangler secret put CARTE_KEY   # 聞かれたら、作った合鍵を貼る
```

- 合鍵は、パスワード管理の道具（iCloud キーチェーンなど）に控える。**リポジトリ・会話・メモに書かない**。
- 合鍵を変えるときは、もう一度 `secret put` する。登録済みの端末は、そのまま使える（端末の印は、合鍵とは別）。なくした端末は、登録済みの別の端末の画面の「登録した端末」から外す。

## 4. 配る

```sh
pnpm install
pnpm build
npx wrangler deploy
```

Cloudflare の Workers Builds でつなぐときは、ビルドのコマンドを `pnpm build`、デプロイのコマンドを `npx wrangler deploy` にする。

## 5. 端末を登録する（端末ごとに1回）

1. 配った URL を開く。「この端末を登録する」が出る。
2. 合鍵を入れて、端末の種類を選び、「登録する」。
3. 以後、その端末では、この画面は出ない。

- iPhone・iPad で、ホーム画面に足して使うときは、**ホーム画面から開いた側で**登録する（Safari と、ホーム画面に足したアプリとで、印の置き場が別になる【推論。実機で確かめる】）。
- 合鍵を1日に 20 回間違えると、その日は登録を受け付けない（登録済みの端末は使える）。

## 6. アカウントの守り

- 記録は、Cloudflare のアカウントの中の D1 にある。**Cloudflare と GitHub のアカウントに、2段階の認証を付ける**（アカウントを取られると、入口の鍵に関係なく、記録を読まれる。CD-004）。
- `wrangler.jsonc` で、要求の記録（ログ）と、作業ブランチの公開を止めてある。
