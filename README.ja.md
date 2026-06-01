<img width="928" height="720" alt="cf0de0fa6d1db4ab27f3f992bf8c81bb_WC-EditVideo_1_30fps" src="https://github.com/user-attachments/assets/ede74d56-f5a8-4e3a-9b6b-6c71bc4cdd22" />

# DOMD

**DOMD は、自社開発のネイティブ Markdown レンダリングエンジンを基盤とする WYSIWYG エディターです。**

- 20 KB gzipped のカーネル（React 以外のランタイム依存ゼロ）
- 入力とレンダリングは同時に発生し、カーソルは常に安定。遅延もチラつきもありません

[**Try on Web**](https://www.domd.app/editor)

Download for Mac: [Apple Silicon](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) · [Intel](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg)

<sub>[English](./README.md) · [简体中文](./README.zh-CN.md) · 日本語</sub>

> [!WARNING]
>

---

## Markdown ネイティブ

DOMD の WYSIWYG は、Markdown の上で直接起こります。

パース、レンダリング、編集 —— 最初のコード一行目から、Markdown の WYSIWYG のために設計されています。

ProseMirror、Slate、Lexical のような汎用リッチテキストエンジンの上には載っていません。

DOMD の編集モデルは、Markdown のために直接設計されています。

---

## カーネル

DOMD のカーネルは、ゼロから実装した Markdown WYSIWYG エディターエンジンです。

「データ」を唯一の駆動源とし、状態は不変です。入力、アンドゥ／リドゥ、AI のストリーミング差分注入、ファイルの分割ロード —— カーネル内ではすべて同じ種類の状態変化として統一的にモデル化されます。

これにより編集の挙動は決定論的になり、状態は常に追跡可能で、レンダリングは変化した部分にのみ発生します。

編集スタック全体が 20 KB gzipped に収まっています。

---

## 1 MB を瞬時に開く

https://github.com/user-attachments/assets/d4cb6d94-6efe-4d5d-8a67-846be7f3cd45

5 KB のメモも 1 MB のドキュメントも、開く体感はほとんど変わりません。

Finder でスペースを押すと、DOMD 自身の Quick Look 拡張がレンダリングを引き受けます。

---

## macOS

Mac での体験はシステムアプリの水準に合わせています。レンダリング済みの `.md` を読み込む体感は、システムが `.txt` を開くのに近いものです。

もっとも純粋な Markdown プレビューと編集 —— プロジェクトツリーなし、サイドバーなし、タブなし、同期なし、アカウントなし。ファイルはあなたの手元に残ります。

Download for macOS: [**Apple Silicon**](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) · [**Intel**](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg)

## Web

エディタを開けば、そのままブラウザで WYSIWYG に書き始められます。`.md` をページにドラッグすれば、その場で開いて編集を続けられます。すべてローカルで動作し、ファイルはアップロードされず、お使いの端末から出ることはありません。

https://www.domd.app

### ローカルフォルダアクセス（Web）

Web エディタからローカルの Markdown ファイルを閲覧・編集するには、`config/server.ts` の `LOCAL_MARKDOWN_DIR` を公開したいフォルダに設定（デフォルト：`/tmp/domd-local`）し、`npm run dev` または `npm run build && npm run start` を実行してください。起動前にフォルダが存在することを確認してください。

---

## CLI

macOS 版にはコマンドラインツール `domd-cli` が同梱されており、エージェントがウィンドウを直接駆動できます。

新規ウィンドウの作成、ストリーミング書き込み、選択範囲の書き換えに対応しています。モデルのストリーミング応答をそのまま `domd-cli insert` にパイプすれば、トークンが届いた瞬間に文書へ書き込まれ、リッチテキストとして即座にレンダリングされます。

ページ冒頭のデモは、GPT API を呼び出す Alfred workflow が、ストリーミング応答を文書へ差分的に書き込んでいく様子を録画したものです。

---

## ビルド

### Web アプリ（Windows）

**前提条件**
- Windows 10/11
- Node.js（LTS）と npm
- Git（任意、クローン用）

**手順**
1. リポジトリのルートで PowerShell または Windows Terminal を開きます。
2. 依存関係をインストール：
   ```bash
   npm install
   ```
3. 開発サーバーを起動：
   ```bash
   npm run dev
   ```
   その後 http://localhost:3000 を開きます。
4. 本番ビルドと実行：
   ```bash
   npm run build
   npm run start
   ```
5. 任意の lint：
   ```bash
   npm run lint
   ```

### ネイティブ（macOS のみ）

```bash
npm run tauri dev
```

Windows ネイティブビルドは現時点では対象外です。

---

## ライセンス

DOMD はデュアルライセンスを採用しています。

**アプリケーション層とヘルパーライブラリ** —— 本リポジトリのソースコード（`@do-md/utils`、`@do-md/zenith` を含む）は MIT ライセンスで公開されています。[LICENSE](LICENSE) を参照してください。自由に閲覧・改変・セルフホストできます。

**コアレンダリングエンジン** —— `@do-md/dist` はビルド成果物としてのみ配布され、[PolyForm Noncommercial 1.0.0](.packages/@do-md/dist/LICENSE) を採用しています。**いかなる商用利用も事前の書面による許諾を必要とします。**

---

## フィードバック

- [GitHub Issues](https://github.com/do-md/domd/issues)
- [GitHub Discussions](https://github.com/do-md/domd/discussions)