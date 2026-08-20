# DOMD

[![npm version](https://img.shields.io/npm/v/@do-md/core-react.svg?style=flat-square&labelColor=2f2f2f&color=4493f8)](https://www.npmjs.com/package/@do-md/core-react)
[![Core size](https://img.shields.io/badge/core%20Brotli-30%2B%20KB-5E81AC?style=flat-square&labelColor=2f2f2f)](https://www.npmjs.com/package/@do-md/core-react)

**DOMD 是一款所见即所得 Markdown 编辑器，基于 30 KB+ 的自研 Markdown 原生内核构建。**

面向日常写作、大型 Markdown 文档、多人实时同步，以及 AI 内容的流式写入。

* Brotli 压缩后 30 KB+，运行时只依赖 React 和 Immer
* 20,000 行 Markdown 文档也能顺滑编辑、流式写入
* 输入和渲染同步完成：光标稳定，无明显延迟、无闪烁
* 支持段落内细粒度的离线、多端无冲突合并，不是段落级 LWW
* 支持多编辑器实时同步、细粒度无冲突合并和远端光标
* 提供原生 macOS 应用、Quick Look 预览、本地优先 Web 编辑器，以及面向 agent 的 CLI

[**在线试用**](https://www.domd.app/editor)

下载 macOS 版本：[Apple Silicon](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) · [Intel](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg)

<sub>[English](./README.md) · 简体中文 · [日本語](./README.ja.md)</sub>

---

## 编辑器内核：`@do-md/core-react`

[`@do-md/core-react`](https://www.npmjs.com/package/@do-md/core-react) 是 DOMD 背后的 Markdown 原生编辑器内核，也可以独立嵌入编辑器、输入框、协作空间和 AI 界面。DOMD 是基于这套内核构建的产品，但不是内核能力的边界。

下方演示会分别隔离一项内核能力，因此无需依赖 DOMD 应用，也可以独立理解和验证每条能力链路。

### Markdown 原生架构

所见即所得编辑直接发生在 Markdown 之上，Markdown 文档本身就是编辑状态的唯一来源。

内核没有基于 ProseMirror、Slate、Lexical 这类通用富文本框架构建。解析、渲染、编辑、撤销/重做、AI 流式写入、分块文件加载，都会在内核中被建模为确定性的状态变化。

内容变化时，内核只渲染真正发生变化的部分。整套编辑栈经过 Brotli 压缩后仅 30 KB+。

### 可扩展的行内语法

Markdown 工具最终大多会遇到同一道墙：行内语法是固定的。想加入高亮、提及、评论或双链，通常只能预处理文本、fork 解析器，或者拼接原始 HTML。从 `@do-md/core-react` 0.6 开始，行内语法成为内核自身的一等扩展点。

#### 一套语法，从样式扩展到语义

参数沿用 Pandoc/Djot 的行内属性语法家族——这是扩展 Markdown 最接近标准的约定，Pandoc、Quarto、kramdown 和 markdown-it 都采用了相近的形式。同一套语法可以从简单高亮平滑扩展到带完整属性和类型的 span：

```text
==highlight==                              普通高亮
=={red}highlight==                         带颜色——位置参数
=={.comment author="Alice"}highlight==     语义类型及其属性
```

#### 语法与语义彼此独立

分隔符本身不携带含义。`.word` 用来选择一个 **variant**，也就是以纯数据注册的语义类型；同一个 variant 可以绑定到产品所需的任意分隔符：

```text
=={.mention id=1}Alice==   ≡   <{.mention id=1}Alice>
```

Pandoc 生态已经把 class 驱动的语义建立为一种约定，例如 Quarto 的 `::: {.callout-note}`。内核进一步把这套约定变成一等的声明式 API。未注册的类型不会报错，而会自然降级为普通的 CSS hook。

#### Variant 可以成为实时交互界面

Variant 可以绑定 React 组件。编辑器会把解析后的参数和 children 传给组件，由组件直接在实时文档中渲染。像 `id` 这样的属性可以稳定关联产品中的业务对象，让一小段 Markdown 成为由应用数据驱动的实时交互界面：带审批操作的事项卡片、自动刷新的天气组件、工作流控制项，或任何其他 React 交互体验。

因此，行内规则不只是样式 hook，也可以成为产品功能嵌入文档的界面。严格的渲染契约会保护光标、选区和协作机制，同时组件仍然拥有 React 的完整能力。

### 段落内离线无冲突合并

内核支持段落内的细粒度无冲突合并，而不是把整段内容作为一个 LWW 值。两台设备可以离线修改同一段落中的不同位置，之后交换已保存的状态，双方修改都能保留下来。离线状态交换和实时同步共享同一套 CRDT 基础，也可以彼此独立地接入。

编辑器内核本身无需感知 CRDT。内核只输出常规编辑产生的结构化操作流；可选的 CRDT 插件监听这条操作流，把每次变化转换为嵌套 Yjs shared types 上的 transaction，并维护一个可合并的 `Y.Doc` 副本。Yjs 再把副本编码成可持久化、可传输、可按任意顺序应用的 document updates。由于 CRDT 边界只是操作流外的一层 adapter，业务层和交互层无需围绕 Yjs 重写：功能开发完成后，接入这个轻量插件即可获得段落内细粒度的 CRDT 合并能力。

[**试试双编辑器 CRDT 合并 Playground**](https://www.domd.app/playground/crdt)

### 实时同步

内核可以让多个编辑器实时同步同一份 Markdown。细粒度编辑会传播到其他副本，并发修改通过 Yjs 自动收敛，远端光标也可以随内容一起同步。收到变化时，内核不会替换整篇文档，而是只在真正受影响的节点上回放操作，因此实时编辑仍然保持局部渲染的性能特征。

内核为这条链路提供三个接入点：`subscribeRenderDataOps` 输出本地编辑操作，`applyExternalRenderDataOps` 增量应用远端操作，光标快照和订阅接口则提供 presence 数据。可选的 `realtime-sync` adapter 会在这些接口与嵌套的 Yjs shared types 之间双向翻译，形成可复用的同步、收敛和 presence 层。它独立于业务流程和产品状态，不同形态的编辑产品都可以接入，而无需重写各自的输入、历史记录或渲染系统。

[**试试实时同步 Playground**](https://www.domd.app/playground/live)

### 流式写入

AI 模型通常会一段一段输出 Markdown，而且经常会把语法切在中间。

内核可以按 chunk 接收这些内容，并在写入过程中实时渲染。

未闭合的代码块、还没完成的表格、写到一半的列表，都可以在流式过程中正确显示。等真正的结束符到达时，内容会自然合并，不会闪烁，也不需要整篇重渲染。

内核对 chunk 大小不敏感，即使在 20,000 行文档里持续流式写入，也能保持顺滑。

[**试试流式写入 Playground**](https://www.domd.app/playground)

### Markdown 原生输入框

同一套内核也可以作为 Markdown 原生输入框使用，适合评论框、Prompt 输入框、CMS 字段、聊天输入框、Issue 表单，以及任何需要结构化文本输入的地方。

用户输入 Markdown 时，内容会实时渲染成所见即所得效果，但底层 value 仍然保持为 Markdown。

在聊天输入场景中，可以用 `Enter` 提交，用 `Shift + Enter` 换行。

[**试试输入框 Playground**](https://www.domd.app/chat)

---

## DOMD 产品

DOMD 把上述内核能力封装成一款克制、轻量、本地优先的 Markdown 编辑器：

* **大文件编辑：**打开 5 KB 笔记和 1 MB 文档的感知速度几乎没有区别，并且始终是完整的所见即所得渲染，而不是纯文本视图。
* **原生 macOS 应用：**采用普通文件工作流，提供 Quick Look 预览，没有项目树、标签页、账号或内置同步服务。下载 [Apple Silicon](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) 或 [Intel](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg) 版本。
* **本地优先 Web 编辑器：**打开网页或直接拖入 `.md` 文件即可编辑，处理始终留在本机。[在线试用 DOMD](https://www.domd.app/editor)。
* **面向 Agent 的 CLI：**`domd-cli` 支持打开窗口、向文档流式写入内容和改写选区，让 DOMD 可以作为 agent 与自动化工具的本地 Markdown 渲染界面。

macOS 应用的大文件编辑演示：

https://github.com/user-attachments/assets/d4cb6d94-6efe-4d5d-8a67-846be7f3cd45

---

## 开发

```bash
npm install
npm run dev
```

开发原生 macOS 应用：

```bash
npm run tauri dev
```

目前暂不支持 Windows 原生构建。

完整开发和贡献说明见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

## License

DOMD 是一个产品优先的项目，许可证分为两层：

* **应用层** — macOS 应用、Web 应用、辅助库和 DOMD 内核插件，均以 [MIT License](./LICENSE) 开源。
* **编辑器内核** — 核心引擎的源码就在本仓库的 [`.packages/@do-md/core`](./.packages/@do-md/core)（npm 包名 [`@do-md/core-react`](https://www.npmjs.com/package/@do-md/core-react)），采用 **GPL-3.0**，并依 GPL 第 7 条授予两条[附加许可](./.packages/@do-md/core/LICENSE-EXCEPTIONS.md)：

  1. **小型主体例外** — 个人、非营利组织，以及年营收低于 100 万美元且累计融资低于 200 万美元的公司，可以把内核链接进非 GPL 软件，并按自选条款发布。
  2. **FOSS 许可证例外** — 采用 MIT、Apache-2.0、BSD、MPL-2.0、ISC、EPL-2.0 或 zlib 的项目，可以链接内核并按其自身许可证发布组合作品。

由于应用打包了 GPL 内核，DOMD 整体的二进制分发或 Web 部署作为一个整体按 GPL 传递；MIT 授权的应用层源文件本身仍是 MIT。试用内核、拿它开发、在组织内部运行都不产生任何义务——GPL 义务在你把它分发给用户时才产生（把内核加载进浏览器的 Web 应用上线也算分发）。

内核 0.10.0 及更早版本按 PolyForm Noncommercial 1.0.0 许可证发布；自 0.11.0 起，内核为 GPL-3.0 加上述例外。

超出例外范围的专有用途，可获取商业许可，请联系 <effyouapp@gmail.com>。

---

## 反馈与贡献

* [GitHub Issues](https://github.com/do-md/domd/issues)
* [GitHub Discussions](https://github.com/do-md/domd/discussions)
* [Contributing guide](./CONTRIBUTING.md)
