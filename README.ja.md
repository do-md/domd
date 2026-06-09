# DOMD

**DOMD は、20 KB の自前 Markdown ネイティブエンジンで動作する WYSIWYG Markdown エディタです。**

日常的な編集、大きな Markdown ファイル、そして AI によるリアルタイムなストリーミング書き込みのために作られています。

* 20 KB Brotli 圧縮カーネル。ランタイム依存は React と Immer のみ
* 20,000 行規模の Markdown 文書でも、編集とストリーミング書き込みをスムーズに処理
* 入力とレンダリングが同期して動作：カーソルは安定し、遅延やちらつきを抑制
* ネイティブ macOS アプリ、Quick Look プレビュー、ローカル優先の Web エディタ、agent 向け CLI を提供

[**Web で試す**](https://www.domd.app/editor) · [**Streaming Playground**](https://www.domd.app/playground) · [**Input Playground**](https://www.domd.app/chat)

macOS 版をダウンロード：[Apple Silicon](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) · [Intel](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg)

<sub>[English](./README.md) · [简体中文](./README.zh-CN.md) · 日本語</sub>

---

## Markdown ネイティブカーネル

DOMD の WYSIWYG 編集は、Markdown そのものの上で動作します。

Markdown 文書自体が、編集状態の唯一の source of truth です。

DOMD は ProseMirror、Slate、Lexical のような汎用リッチテキストフレームワークの上には構築されていません。パース、レンダリング、編集、undo / redo、AI ストリーミング挿入、チャンク単位のファイル読み込みは、すべてカーネル内の決定的な状態変化として扱われます。

変更が発生したとき、DOMD は実際に変わった部分だけをレンダリングします。編集スタック全体は、Brotli 圧縮後で 20 KB に収まります。

---

## ストリーミング書き込み

AI モデルは Markdown を少しずつ出力します。しかも、構文の途中で分割されることもよくあります。

DOMD はそうした出力を chunk 単位で受け取り、その場でリアルタイムにレンダリングできます。

閉じられていないコードブロック、途中まで書かれたテーブル、未完成のリストも、ストリーミング中に自然に表示されます。実際の終端が届いたときも、内容はそのまま吸収され、ちらつきや全文再レンダリングは発生しません。

DOMD は chunk の大きさに依存しません。20,000 行の文書に対して継続的にストリーミング書き込みを行っても、滑らかな操作感を保ちます。

[**Streaming Playground を試す**](https://www.domd.app/playground)

---

## Markdown ネイティブ入力

DOMD は、Markdown ネイティブな入力 UI としても利用できます。

コメント欄、Prompt 入力欄、CMS フィールド、チャット入力、Issue フォームなど、構造化されたテキスト入力が必要な場所に向いています。

ユーザーが Markdown を入力すると、内容はリアルタイムに WYSIWYG 表示されます。一方で、内部の value は Markdown のまま保持されます。

チャット風の入力では、`Enter` で送信し、`Shift + Enter` で改行するような挙動にも対応できます。

[**Input Playground を試す**](https://www.domd.app/chat)

---

## 大きなファイルでも速い

https://github.com/user-attachments/assets/d4cb6d94-6efe-4d5d-8a67-846be7f3cd45

5 KB のメモを開くときと、1 MB の Markdown 文書を開くときで、体感速度はほとんど変わりません。

これはプレーンテキストのプレビューではなく、完全な WYSIWYG Markdown レンダリングです。

Finder で `.md` ファイルを選択してスペースキーを押すと、DOMD に付属する Quick Look 拡張が Markdown のレンダリングを担当します。

---

## macOS

DOMD の macOS アプリは、軽く、直接的で、ネイティブに近い体験を目指しています。

レンダリング済みの `.md` ファイルを開く感覚は、システムで `.txt` ファイルを開く感覚に近いものです。速く、軽く、余計なものがありません。

DOMD は普通の Markdown ファイルワークフローを採用しています。プロジェクトツリー、サイドバー、タブ、同期サービス、アカウントはありません。ファイルは常に自分のデバイス上に残ります。

macOS 版をダウンロード：[**Apple Silicon**](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) · [**Intel**](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg)

---

## Web

ブラウザを開くだけで、WYSIWYG Markdown 編集を始められます。

`.md` ファイルをページにドラッグ＆ドロップして、そのままローカルで編集することもできます。すべての処理は手元の環境で行われ、ファイルがデバイスの外に送信されることはありません。

https://www.domd.app

---

## CLI

macOS 版には `domd-cli` が同梱されています。agent、スクリプト、ランチャー、自動化ツールから DOMD のウィンドウを直接操作できます。

これにより、DOMD は単なるエディタではなく、ローカルの Markdown レンダリングサーフェスとしても利用できます。

`domd-cli` は、新しいウィンドウを開く、ストリーミング書き込みを行う、選択範囲を書き換える、といった操作に対応しています。モデルのストリーミングレスポンスを `domd-cli insert` に直接 pipe すれば、token が届くたびに文書へ挿入され、リアルタイムにリッチテキスト Markdown としてレンダリングされます。

ページ上部のデモ動画は、Alfred workflow から GPT API を呼び出し、そのレスポンスを DOMD に増分書き込みして録画したものです。

---

## 開発

```bash
npm install
npm run dev
```

ネイティブ macOS アプリを開発する場合：

```bash
npm run tauri dev
```

現在、Windows のネイティブビルドには対応していません。

詳しいセットアップとコントリビューション方法は [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

---

## License

DOMD は product-first なプロジェクトです。

macOS アプリ、Web アプリ、補助ライブラリを含むアプリケーション層は、それぞれのライセンスに基づいてオープンソースとして公開されています。学習、個人利用、コントリビューション、透明性のためのものです。

コア編集エンジンである `@do-md/dist` は別ライセンスで提供され、事前ビルド済みの成果物として配布されます。ライセンスは PolyForm Noncommercial 1.0.0 です。`@do-md/dist` には DOMD の Markdown 編集機能とレンダリング機能が含まれます。

`@do-md/dist` は、以下の用途で利用できます。

* 評価と試用
* 個人プロジェクト
* 非商用プロジェクト
* 非商用のオープンソースプロジェクト
* 実験とプロトタイプ開発

商用利用には、事前の書面による許可が必要です。

これには、商用製品への組み込み、SaaS / プロダクト連携、再配布、DOMD を有料製品・SDK・エディタコンポーネント・ホスト型サービスの一部として提供することが含まれます。

商用ライセンスについては、プロジェクト作者までお問い合わせください。

---

## フィードバックとコントリビューション

* [GitHub Issues](https://github.com/do-md/domd/issues)
* [GitHub Discussions](https://github.com/do-md/domd/discussions)
* [Contributing guide](./CONTRIBUTING.md)
