<img width="928" height="720" alt="cf0de0fa6d1db4ab27f3f992bf8c81bb_WC-EditVideo_1_30fps" src="https://github.com/user-attachments/assets/ede74d56-f5a8-4e3a-9b6b-6c71bc4cdd22" />


# DOMD

**DOMD 是一款基于自研原生 Markdown 渲染引擎的 WYSIWYG 编辑器。**

- 20 KB gzipped 内核（除 React 外零运行时依赖）
- 输入与渲染同步发生，光标始终稳定，编辑无延迟、无抖动

[**Try on Web**](https://www.domd.app/editor) · Download for Mac: [Apple Silicon](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) · [Intel](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg)

<sub>[English](./README.md) · 简体中文 · [日本語](./README.ja.md)</sub>

---

## Markdown 原生

DOMD 的所见即所得，直接发生在 Markdown 上。

解析、渲染、编辑，从第一行代码起就是为 Markdown 所见即所得而构建。

它不建立在 ProseMirror、Slate、Lexical 这类通用富文本引擎之上。

DOMD 的编辑模型，直接服务于 Markdown。

---

## 内核

DOMD 的内核是一套从零实现的 Markdown WYSIWYG 编辑器引擎。

它以"数据"为唯一驱动源，状态不可变。输入、撤销还原、AI 流式增量注入、文件分块加载，在内核中被统一建模为同一类状态变更。

这使得编辑行为具备确定性，状态始终可追溯，渲染只发生在变化的部分。

整个编辑栈，被压进 20 KB gzipped。

---

## 1 MB 秒开

https://github.com/user-attachments/assets/d4cb6d94-6efe-4d5d-8a67-846be7f3cd45

5 KB 笔记和 1 MB 文档，打开体验几乎没有区别。

Finder 里按空格，DOMD 自己的 Quick Look 扩展接管渲染。

---

## macOS

Mac 上的体验对标系统应用。一份渲染好的 `.md`，加载体验接近系统打开一份 `.txt`。

最纯粹的 Markdown 预览和编辑，没有项目树、侧栏、标签页、同步、账号。文件在你电脑上。

Download for macOS: [**Apple Silicon**](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) · [**Intel**](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg)

## Web

打开编辑器即可在浏览器里直接所见即所得编辑，也可以把 `.md` 拖到页面上原地打开继续写。全部在本地运行，文件不上传、不离开你的设备。

https://www.domd.app

---

## CLI

macOS 版本附带一个命令行工具 `domd-cli`，让 Agent 直接驱动窗口。

支持新建窗口、流式写入、重写选区。AI 模型的流式响应可直接管道至 `domd-cli insert`，token 抵达即写入文档，直接渲染为富文本。

页面顶部的演示，是由一个调用 GPT API 的 Alfred workflow，将流式响应直接增量写入文档录制而成。

*（完整命令文档随首个 Release 公布）*

---

## 构建

```bash
npm install
npm run dev              # web
npm run tauri dev        # macOS 原生
```

macOS 构建为 Apple Silicon 签名版本。Intel 与 Windows 暂不支持。

---

## 许可

DOMD 采用双重许可。

**应用层与工具库** —— 本仓库源码（含 `@do-md/utils`、`@do-md/zenith`）以 MIT 协议开源，见 [LICENSE](LICENSE)。可自由阅读、修改、自建分发。

**核心渲染引擎** —— `@do-md/dist` 仅以构建产物形式分发，采用 [PolyForm Noncommercial 1.0.0](.packages/@do-md/dist/LICENSE)。**任何商业用途须事先获得书面授权**。

---

## 反馈

GitHub Issues 与 Discussions（首个 Release 后公布链接）。
