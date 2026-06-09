# DOMD

**DOMD 是一款所见即所得 Markdown 编辑器，基于 20 KB 自研 Markdown 原生内核构建。**

面向日常写作、大型 Markdown 文档，以及 AI 内容的实时流式写入。

* 20 KB Brotli 压缩内核，运行时只依赖 React 和 Immer
* 20,000 行 Markdown 文档也能顺滑编辑、流式写入
* 输入和渲染同步完成：光标稳定，无明显延迟、无闪烁
* 提供原生 macOS 应用、Quick Look 预览、本地优先 Web 编辑器，以及面向 agent 的 CLI

[**在线试用**](https://www.domd.app/editor) · [**流式写入 Playground**](https://www.domd.app/playground) · [**输入框 Playground**](https://www.domd.app/chat)

下载 macOS 版本：[Apple Silicon](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) · [Intel](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg)

<sub>[English](./README.md) · 简体中文 · [日本語](./README.ja.md)</sub>

---

## Markdown 原生内核

DOMD 的所见即所得编辑直接发生在 Markdown 之上。

Markdown 文档本身就是编辑状态的唯一来源。

DOMD 没有基于 ProseMirror、Slate、Lexical 这类通用富文本框架构建。解析、渲染、编辑、撤销/重做、AI 流式写入、分块文件加载，都会在内核中被建模为确定性的状态变化。

内容变化时，DOMD 只渲染真正发生变化的部分。整套编辑栈经过 Brotli 压缩后只有 20 KB。

---

## 流式写入

AI 模型通常会一段一段输出 Markdown，而且经常会把语法切在中间。

DOMD 可以按 chunk 接收这些内容，并在写入过程中实时渲染。

未闭合的代码块、还没完成的表格、写到一半的列表，都可以在流式过程中正确显示。等真正的结束符到达时，内容会自然合并，不会闪烁，也不需要整篇重渲染。

DOMD 对 chunk 大小不敏感，即使在 20,000 行文档里持续流式写入，也能保持顺滑。

[**试试流式写入 Playground**](https://www.domd.app/playground)

---

## Markdown 原生输入框

DOMD 也可以作为 Markdown 原生输入框使用，适合评论框、Prompt 输入框、CMS 字段、聊天输入框、Issue 表单，以及任何需要结构化文本输入的地方。

用户输入 Markdown 时，内容会实时渲染成所见即所得效果，但底层 value 仍然保持为 Markdown。

在聊天输入场景中，可以用 `Enter` 提交，用 `Shift + Enter` 换行。

[**试试输入框 Playground**](https://www.domd.app/chat)

---

## 大文件性能

https://github.com/user-attachments/assets/d4cb6d94-6efe-4d5d-8a67-846be7f3cd45

打开一篇 5 KB 笔记，和打开一篇 1 MB Markdown 文档，在感知速度上几乎没有区别。

这里不是普通纯文本预览，而是完整的所见即所得 Markdown 渲染。

在 Finder 里选中 `.md` 文件后按空格，DOMD 自带的 Quick Look 扩展会接管 Markdown 渲染。

---

## macOS

DOMD 的 macOS 应用追求轻量、直接、接近系统原生体验。

打开一个渲染后的 `.md` 文件，感觉应该接近系统打开 `.txt` 文件：快、轻、没有额外负担。

DOMD 使用普通 Markdown 文件工作流：没有项目树，没有侧边栏，没有标签页，没有同步服务，也不需要账号。文件始终留在你的设备上。

下载 macOS 版本：[**Apple Silicon**](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) · [**Intel**](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg)

---

## Web

打开网页即可开始所见即所得 Markdown 编辑。

你也可以把 `.md` 文件直接拖进页面，在浏览器里本地编辑。所有处理都在本机完成，文件不会离开你的设备。

https://www.domd.app

---

## CLI

macOS 版本内置 `domd-cli`，可以让 agent、脚本、启动器和自动化工具直接控制 DOMD 窗口。

这让 DOMD 不只是一个编辑器，也可以成为本地 Markdown 渲染界面。

`domd-cli` 支持打开新窗口、流式写入、改写选区等操作。模型的流式响应可以直接 pipe 到 `domd-cli insert`，token 会一边到达，一边写入文档，并实时渲染成富文本 Markdown。

页面顶部的演示视频，就是通过 Alfred workflow 调用 GPT API，然后把模型响应增量写入 DOMD 录制出来的。

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

DOMD 是一个产品优先的项目。

应用层代码，包括 macOS 应用、Web 应用和辅助库，会根据各自许可证开源，方便学习、个人使用、贡献和审查。

核心编辑器引擎 `@do-md/dist` 单独授权，并以预构建产物形式发布，使用 PolyForm Noncommercial 1.0.0 许可证。它包含 DOMD 的 Markdown 编辑和渲染能力。

你可以在以下场景中使用 `@do-md/dist`：

* 评估和试用
* 个人项目
* 非商业项目
* 非商业开源项目
* 实验和原型开发

商业使用需要提前获得书面授权。

这包括但不限于：商业产品集成、SaaS / 产品嵌入、重新分发，或将 DOMD 作为付费产品、SDK、编辑器组件、托管服务的一部分提供。

如需商业授权，请联系项目作者。

---

## 反馈与贡献

* [GitHub Issues](https://github.com/do-md/domd/issues)
* [GitHub Discussions](https://github.com/do-md/domd/discussions)
* [Contributing guide](./CONTRIBUTING.md)
