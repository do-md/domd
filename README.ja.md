# DOMD

[![npm version](https://img.shields.io/npm/v/@do-md/core-react.svg?style=flat-square&labelColor=2f2f2f&color=4493f8)](https://www.npmjs.com/package/@do-md/core-react)
[![Core size](https://img.shields.io/badge/core%20Brotli-30%2B%20KB-5E81AC?style=flat-square&labelColor=2f2f2f)](https://www.npmjs.com/package/@do-md/core-react)

**DOMD は、30 KB 超の自前 Markdown ネイティブエンジンで動作する WYSIWYG Markdown エディタです。**

日常的な編集、大きな Markdown ファイル、ライブ同期、そして AI によるストリーミング出力のために作られています。

* Brotli 圧縮後で 30 KB 超。ランタイム依存は React と Immer のみ
* 20,000 行規模の Markdown 文書でも、編集とストリーミング書き込みをスムーズに処理
* 入力とレンダリングが同期して動作：カーソルは安定し、遅延やちらつきを抑制
* 段落単位の LWW ではなく、段落内の細粒度でオフライン・複数デバイス間の競合なしマージに対応
* 細粒度の競合なしマージとリモートカーソルに対応した、複数エディタ間のリアルタイム同期
* ネイティブ macOS アプリ、Quick Look プレビュー、ローカル優先の Web エディタ、agent 向け CLI を提供

[**Web で試す**](https://www.domd.app/editor) 

macOS 版をダウンロード：[Apple Silicon](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) · [Intel](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg)

<sub>[English](./README.md) · [简体中文](./README.zh-CN.md) · 日本語</sub>

---

## エディタカーネル：`@do-md/core-react`

[`@do-md/core-react`](https://www.npmjs.com/package/@do-md/core-react) は DOMD を支える Markdown ネイティブのエディタカーネルです。エディタ、入力 UI、コラボレーションワークスペース、AI インターフェースへ単独で組み込むこともできます。DOMD はこのカーネルで構築された一つのプロダクトであり、カーネルの可能性を限定するものではありません。

以下のデモではカーネル機能を一つずつ切り分けているため、DOMD アプリケーションとは独立して各機能を確認できます。

### Markdown ネイティブ設計

WYSIWYG 編集は Markdown そのものの上で動作し、Markdown 文書自体が編集状態の唯一の source of truth になります。

カーネルは ProseMirror、Slate、Lexical のような汎用リッチテキストフレームワークの上には構築されていません。パース、レンダリング、編集、undo / redo、AI ストリーミング挿入、チャンク単位のファイル読み込みは、すべてカーネル内の決定的な状態変化として扱われます。

変更が発生したときは実際に変わった部分だけをレンダリングします。編集スタック全体は、Brotli 圧縮後でも 30 KB を少し超える程度です。

### 拡張可能なインライン構文

ほとんどの Markdown ツールは、いずれ同じ壁に突き当たります。インライン構文が固定されていることです。ハイライト、メンション、コメント、Wiki リンクを追加しようとすると、一般的にはテキストの前処理、パーサーの fork、または生の HTML が必要になります。`@do-md/core-react` 0.6 から、インライン構文はカーネル自体の第一級の拡張ポイントになりました。

#### スタイルからセマンティクスまで、一つの文法で

パラメータは Pandoc/Djot のインライン属性構文ファミリーに準拠しています。これは拡張 Markdown において標準に最も近い慣習であり、Pandoc、Quarto、kramdown、markdown-it でも同様の形式が使われています。同じ文法で、単純なハイライトから、属性と型を備えた span まで自然に拡張できます。

```text
==highlight==                              通常のハイライト
=={red}highlight==                         色付き——位置パラメータ
=={.comment author="Alice"}highlight==     属性を持つセマンティック型
```

#### 構文とセマンティクスを分離

区切り文字そのものは意味を持ちません。`.word` は、プレーンなデータとして登録されたセマンティック型である **variant** を選択します。同じ variant を、プロダクトに適した任意の区切り文字へ割り当てられます。

```text
=={.mention id=1}Alice==   ≡   <{.mention id=1}Alice>
```

Pandoc エコシステムは、Quarto の `::: {.callout-note}` のような class 駆動のセマンティクスを慣習として定着させました。カーネルはその慣習を第一級の宣言的 API にします。未登録の型もエラーにはならず、通常の CSS hook として自然にフォールバックします。

#### Variant をライブなインタラクティブ UI に

Variant には React コンポーネントを紐付けられます。エディタはパース済みのパラメータと children をコンポーネントへ渡し、コンポーネントはライブ文書内に直接レンダリングされます。`id` のような属性をプロダクト内のオブジェクトへの安定した参照として使えば、わずかな Markdown をアプリケーションデータと連動するインタラクティブ UI に変えられます。承認操作を備えた課題カード、自動更新される天気ウィジェット、ワークフローの操作項目など、React で表現できるあらゆる体験を埋め込めます。

つまり、インラインルールは単なるスタイル用 hook ではなく、プロダクト機能を文書へ組み込むためのサーフェスにもなります。厳格なレンダリング契約がキャレット、選択範囲、コラボレーション機構を保護しつつ、コンポーネントは React の機能を最大限に利用できます。

### オフラインで競合なくマージ

カーネルは段落全体を単一の LWW 値として扱うのではなく、段落内の細粒度で競合なくマージできます。2 台のデバイスが同じ段落の異なる部分をオフラインで編集しても、後から保存済みの状態を交換すれば、両方の変更を保持できます。オフラインの状態交換とリアルタイム同期は同じ CRDT 基盤を共有しながら、それぞれ独立して導入できます。

エディタカーネル自体は CRDT を意識しません。カーネルは通常の編集から構造化された操作ストリームを出力し、オプションの CRDT プラグインがそれを監視します。プラグインは各変更をネストされた Yjs shared types 上の transaction に変換し、マージ可能な `Y.Doc` レプリカを維持します。Yjs はそのレプリカを、永続化・転送でき、任意の順序で適用可能な document updates としてエンコードします。CRDT の境界は操作ストリームを包む adapter に限定されるため、プロダクト層やインタラクション層を Yjs 前提で作り直す必要はありません。通常の機能を完成させた後、この軽量なプラグインを接続するだけで、段落内の細粒度 CRDT マージを追加できます。

[**2 画面の CRDT Merge Playground を試す**](https://www.domd.app/playground/crdt)

### リアルタイム同期

カーネルは、複数のエディタで同じ Markdown 文書をリアルタイムに同期できます。細粒度の編集はほかのレプリカへ伝播し、同時変更は Yjs によって収束し、リモートカーソルも内容とともに同期できます。受信した変更は文書全体を置き換えるのではなく、実際に影響を受けたノードだけでリプレイされるため、ライブ編集でも局所レンダリング特性が保たれます。

カーネルは、この同期経路のために 3 つの接続点を公開します。`subscribeRenderDataOps` はローカル編集操作を出力し、`applyExternalRenderDataOps` はリモート操作を増分適用し、カーソルのスナップショットと購読 API は presence データを提供します。オプションの `realtime-sync` adapter は、これらの API とネストした Yjs shared types の間を双方向に変換し、再利用可能な同期・収束・presence レイヤーを構成します。業務フローや製品状態から独立しているため、異なる形の編集製品でも独自の入力、履歴、レンダリングシステムを書き直すことなく導入できます。

[**Real-time Sync Playground を試す**](https://www.domd.app/playground/live)

### ストリーミング書き込み

AI モデルは Markdown を少しずつ出力します。しかも、構文の途中で分割されることもよくあります。

カーネルはそうした出力を chunk 単位で受け取り、その場でリアルタイムにレンダリングできます。

閉じられていないコードブロック、途中まで書かれたテーブル、未完成のリストも、ストリーミング中に自然に表示されます。実際の終端が届いたときも、内容はそのまま吸収され、ちらつきや全文再レンダリングは発生しません。

カーネルは chunk の大きさに依存しません。20,000 行の文書に対して継続的にストリーミング書き込みを行っても、滑らかな操作感を保ちます。

[**Streaming Playground を試す**](https://www.domd.app/playground)

### Markdown ネイティブ入力

同じカーネルを Markdown ネイティブな入力 UI として利用することもできます。

コメント欄、Prompt 入力欄、CMS フィールド、チャット入力、Issue フォームなど、構造化されたテキスト入力が必要な場所に向いています。

ユーザーが Markdown を入力すると、内容はリアルタイムに WYSIWYG 表示されます。一方で、内部の value は Markdown のまま保持されます。

チャット風の入力では、`Enter` で送信し、`Shift + Enter` で改行するような挙動にも対応できます。

[**Input Playground を試す**](https://www.domd.app/chat)

---

## DOMD プロダクト

DOMD は、上記のカーネル機能を意図的にシンプルで軽量な、ローカル優先の Markdown エディタとして提供します。

* **大きなファイルの編集：**5 KB のメモと 1 MB の文書をほぼ同じ体感速度で開き、プレーンテキスト表示ではなく完全な WYSIWYG レンダリングを維持します。
* **ネイティブ macOS アプリ：**Quick Look プレビューに対応した通常のファイルワークフローで、プロジェクトツリー、タブ、アカウント、内蔵同期サービスはありません。[Apple Silicon](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) または [Intel](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg) 版をダウンロードできます。
* **ローカル優先の Web エディタ：**ブラウザで開くか `.md` ファイルをドラッグするだけで編集でき、処理はデバイス上に留まります。[Web で DOMD を試す](https://www.domd.app/editor)。
* **Agent 向け CLI：**`domd-cli` はウィンドウを開く、文書へストリーミング書き込みする、選択範囲を書き換えるといった操作に対応し、agent や自動化ツールのローカル Markdown レンダリングサーフェスとして利用できます。

macOS アプリでの大きなファイル編集：

https://github.com/user-attachments/assets/d4cb6d94-6efe-4d5d-8a67-846be7f3cd45

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

macOS アプリ、Web アプリ、補助ライブラリ、DOMD カーネルプラグインを含むアプリケーション層は、すべて MIT License のもとでオープンソースとして公開されています。学習、個人利用、コントリビューション、透明性のためのものです。

コア編集エンジンは、独立した npm パッケージ [`@do-md/core-react`](https://www.npmjs.com/package/@do-md/core-react) として公開されています。このパッケージには PolyForm Noncommercial 1.0.0 ライセンスが個別に適用され、DOMD の Markdown 編集機能とレンダリング機能が含まれます。

`@do-md/core-react` は、以下の用途で利用できます。

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
