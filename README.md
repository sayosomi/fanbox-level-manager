# fanbox-level-manager

さよそみラボのFANBOX支援者向け抽選口数管理システムです。

Mac上で動く管理アプリと、支援者が現在の抽選口数・履歴を確認するための
Cloudflare上のページで構成されています。

## このリポジトリを公開している理由

このリポジトリは、一般向けツールとして広く利用してもらうことを主目的に
公開しているものではありません。

支援者の方が、抽選口数がどのように管理されているか、またFANBOX/pixiv上の
識別情報がどのように扱われているかを、実際のソースコードから確認できる
ようにするため、透明性確保を目的として公開しています。

特に、FANBOX/pixivの表示名やFANBOX relationship IDなど、支援者本人を
識別できる情報はMac上のローカルデータベースで管理し、Cloudflare側へ
同期するデータには含めない設計・実装になっています。

## データの流れ

```text
FANBOX 支援者一覧PDF
        |
        v
Mac上の管理アプリ (127.0.0.1)
        |
        +--> ローカルSQLite
        |      FANBOX/pixiv識別情報・管理情報
        |
        +--> 必要最小限の匿名化された状態を同期
                 |
                 v
          Cloudflare Worker + D1
                 |
                 v
          支援者向け確認ページ
```

FANBOX支援者一覧PDFはMac上の管理アプリで読み取ります。PDFそのものを
Cloudflareへアップロードする処理はありません。

### Mac上に保存する情報

ローカルSQLiteには、運用に必要な情報として次のようなデータを保持します。

- FANBOX relationship ID
- FANBOX/pixiv表示名
- FANBOX上の識別情報とランダムな内部supporter IDの対応
- 現在の支援状態
- 現在の抽選口数と履歴
- 支援者向けページの発行・送信状態
- 支援者向けページの認証トークンを暗号化したデータ
- その他、月末処理や移行に必要な管理情報

通常の本番DBはMac上の
`~/Library/Application Support/fanbox-level-manager/admin.sqlite3`
に保存されます。

### Cloudflareへ同期する情報

支援者向けページを提供するため、Cloudflare Workers / D1には必要最小限の
データだけを同期します。

- ランダムに生成した内部supporter ID
- 現在の抽選口数
- 一般化された抽選口数の履歴
- 支援者向けページ認証トークンのSHA-256ハッシュ
- 表示・同期に必要な日時

同期処理の実装は
[`supporter-portal-sync-service.ts`](packages/application/src/supporter-portal-sync-service.ts)
で確認できます。Cloudflare側の保存形式は
[`apps/portal-worker/migrations`](apps/portal-worker/migrations)
で確認できます。

### Cloudflareへ同期しない情報

この実装では、次の情報をCloudflare側の支援者データとして送信・保存しません。

- FANBOX/pixiv表示名
- pixiv ID
- FANBOX relationship ID
- メールアドレス
- FANBOXの非公開メモ
- 抽選で対象になった具体的なぬいぐるみ・商品名
- FANBOX支援者一覧PDF

データ境界の仕様は
[`docs/SPEC.md#data-privacy-boundary`](docs/SPEC.md#data-privacy-boundary)
にも記載しています。

## 支援者向けURLと認証トークン

支援者向けページでは、支援者ごとに32 byteの乱数から生成した長い個別トークンを
使用します。

個別URLはおおむね次の形式です。

```text
https://<portal>/level#<long-random-token>
```

URLのfragment部分は通常のHTTPリクエストパスには含まれません。ページ上の
クライアントコードが認証時にトークンをWorkerへPOSTし、Worker側でSHA-256
ハッシュにして照合します。

Cloudflare D1に保存するのはトークンのハッシュだけで、生のトークンは保存しません。

Mac側では、再表示が必要な生トークンをAES-256-GCMで暗号化してSQLiteに保存し、
暗号鍵はmacOS Keychainで管理します。

関連実装:

- [`supporter-portal-access-service.ts`](packages/application/src/supporter-portal-access-service.ts)
- [`supporter-portal-token-codec.ts`](packages/application/src/supporter-portal-token-codec.ts)
- [`portal-token-encryption-key.ts`](apps/admin-web/src/portal-token-encryption-key.ts)
- [`apps/portal-worker/src/index.ts`](apps/portal-worker/src/index.ts)

## バックアップ

ローカルSQLiteのバックアップはAES-256-GCMで暗号化した
`.fblmbkup` ファイルとして、管理者が指定したファイルシステム上の保存先へ
書き出します。バックアップ暗号鍵もmacOS Keychainで管理します。

## Normal production startup

From the repository root, build after pulling or changing source:

```sh
npm run build
```

Then start the Mac-local admin:

```sh
npm run admin:production
```

If prompted, enter the production portal sync token directly into the hidden
terminal prompt. Open:

```text
http://127.0.0.1:4310
```

For routine restarts with an already-current build, `npm run admin:production`
is sufficient. Normal admin startup does not deploy the Cloudflare Worker or
run D1 migrations.

Never paste the production sync token or a personal supporter portal URL into
ChatGPT, Luna, GitHub, documentation, logs, screenshots, or another agent
session.

See [docs/PRODUCTION.md](docs/PRODUCTION.md) for the full production operator
runbook, including restart, health checks, Worker deployment, and D1 migration
rules.

## Documentation

Durable product behavior is defined by [docs/SPEC.md](docs/SPEC.md). Current
work and implementation contracts are tracked in this repository's
[GitHub Issues](https://github.com/sayosomi/fanbox-level-manager/issues).

## Development

Use Node.js 24 and install the locked dependencies:

```sh
npm ci
```

The repository checks are available from the root:

```sh
npm run build
npm run lint
npm run typecheck
npm test
```
