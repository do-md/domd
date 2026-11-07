# 更新日志

<sub>[English](./CHANGELOG.md) · 简体中文 · [日本語](./CHANGELOG.ja.md)</sub>

本文件记录 DOMD 的所有重要变更，最新的在最前。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

- **版本：**每一节对应一次 DOMD 应用发版（macOS 应用和 [domd.app](https://www.domd.app) 上的 Web 编辑器），与 git 标签 `vX.Y.Z` 和 [GitHub Releases](https://github.com/do-md/domd/releases) 一致。Web 编辑器从 `main` 分支部署，所以 Web 端的改动可能早于列出它的版本上线。
- **编辑器内核：**[`@do-md/core-react`](https://www.npmjs.com/package/@do-md/core-react) 在 npm 上有独立的版本号，每一节都注明该版本搭载的内核版本。标 *（内核）* 的条目是内核里的改动；**内核 API** 条目面向嵌入内核的开发者。自 v0.6.0 起，内核源码放在本仓库，应用直接从源码构建内核。
- **范围：**重构、构建与 CI 修复、测试脚本、基准测试、依赖同步等内部工作不列入。社区贡献在条目中注明并致谢。

## [Unreleased]

内核：`@do-md/core-react` 0.13.1 和 0.14.0 已发布到 npm；标 *（内核，未发布）* 的条目会随下一个内核版本发布。

### 新增

- 表格单元格支持换行：在单元格里按 Enter 或 Shift+Enter 插入换行，Markdown 中存为 `<br>`。在单元格里输入或粘贴的多行文本同样这样写入，`<br/>`、`<BR>`、`<br />` 保存时统一为 `<br>`。单元格只承载行内内容：在单元格里输入 `- x`、`# x` 或空行，不会变成列表、标题或新段落。*（内核，未发布）*
- **内核 API：**新增 `filePaths` 选项（默认关闭），识别文本中的本地文件路径——如 `/tmp/a.png`、`~/notes/x.md`、`src/foo.ts:12:3`——并包成 `FilePath` 节点，由宿主自行决定如何渲染；`getFilePathInfo()` 返回路径、行号和列号。源文本保持不变。*（内核 0.14.0）*
- **内核 API：**`DOMDProvider` 新增 `copyAs` 选项：`"markdown"`（默认，行为不变）或 `"text"`——复制读者看到的内容，不含语法符号和链接 URL，表格按制表符分隔的行输出（[#46](https://github.com/do-md/domd/issues/46)）。*（内核 0.14.0）*

### 变更

- 复制和剪切改为在 copy 事件中同步写入剪贴板，不再走异步 Clipboard API，因此无需权限，在 iframe 中也能用。*（内核 0.14.0）*

### 修复

- 行内 `<br>`（以及 `<br/>`、`<br />`，大小写不限）渲染为换行，不再把标签当文本显示——AI 回答里的表格单元格中很常见（[#47](https://github.com/do-md/domd/pull/47)，感谢 [@123soulshell](https://github.com/123soulshell)）。*（内核，未发布）*
- 光标紧跟在 `<br>` 换行之后时，显示在下一行行首；输入的文字和输入法文字落在换行之后，而不是之前。*（内核，未发布）*
- 在只读视图中点击带格式的文字，不再露出它的 Markdown 符号（例如粗体两侧的 `**`）。*（内核 0.13.1）*
- 链接文字里的裸 URL 不再生成嵌套在链接里的链接。*（内核 0.14.0）*
- 选区从行内徽标（例如 @提及）内部开始时，复制出的文字不再错位；无法映射到文档的复制会交给浏览器原生复制，不再得到空剪贴板。*（内核 0.14.0）*

## [0.10.0] - 2026-09-23

内核：`@do-md/core-react` 0.13.0。

### 新增

- 大文档保持流畅：文档的顶层块达到 500 个及以上时，编辑器、协作页和预览页只渲染视口附近的块。10 MB 文档现在约 2.6 秒打开，而不是让渲染进程崩溃。Web 端可在 URL 中用 `?virtual=off|auto|always` 覆盖该行为。
- 打印和导出 PDF 时会先渲染所有块，内容不会被截断。
- **内核 API：**渲染窗口接口、`getTopLevelBlocks()` / `getTopLevelBlockCount()` / `getTopLevelUuid()`，以及分块加载信号（`isLoadingChunks` / `subscribeLoadingChange`）。窗口化引擎以新包 `@do-md/virtual` 发布。

### 修复

- 打开大文件时，可能把只加载了一部分的内容存回文件（实测 2 MB 文件被截成 144 KB）。现在文件加载完成前会锁定编辑，自动保存、草稿、协作和导出 PDF 都会等加载完成。
- 打开文件不再用规范化后的 Markdown 重写它。
- 保存进行中输入的文字可能没有被保存；现在会包含在下一次保存里。
- 解析恢复为线性耗时：10 MB 文档约 2 秒解析完，原来要 50 秒；2 MB 列表内容约 0.6 秒，原来要 10 秒。*（内核）*
- 约 19 万个块的文档可以进入协作，不再因栈溢出失败。
- 打开大纲时，滚动有几千个标题的文档不再卡顿（3,271 个标题时每帧从 108 ms 降到 0.2 ms）。
- 编辑跨两个表格单元格的选区时，不再删掉单元格分隔符把两格合并；编辑限定在选区起点所在的单元格内（[#44](https://github.com/do-md/domd/pull/44)，感谢 [@Systemofdumb](https://github.com/Systemofdumb)）。*（内核）*
- 只读视图重新忽略编辑操作：⌘Z、⌘B 等快捷键不再生效，文字可以拖出去，点击末尾代码块下方也不会再新增段落。在只读和可编辑之间切换不再记入撤销历史。*（内核）*
- 在代码块里紧挨相同字符输入（例如在 `)` 前输入 `)`）不再出现重复字符。*（内核）*

## [0.9.2] - 2026-09-16

内核：`@do-md/core-react` 0.12.3。

### 修复

- 文档以表格开头或结尾，或只有一个表格时，⌘A 也能选中全文（[#43](https://github.com/do-md/domd/issues/43)）。*（内核）*
- 三击只选中一个块内的一行，不再溢出到相邻块（[#42](https://github.com/do-md/domd/issues/42)）。*（内核）*

## [0.9.1] - 2026-09-13

内核：`@do-md/core-react` 0.12.2。

### 新增

- AI Agent 可以使用任意 OpenAI 兼容端点——DeepSeek、Moonshot、本地服务、反向代理均可。可以粘贴裸域名、以 `/v1` 这类版本号结尾的 base URL，或完整的 chat completions URL。多个 Agent 可共用一个端点及其 API Key；删除最后一个使用某自定义端点的 Agent 时，端点和对应的 Key 一并删除（[#28](https://github.com/do-md/domd/issues/28)）。

### 修复

- 桌面应用中开着输入法（例如中文输入）时，输入 `@` 不再让 Agent 选择框一出现就关闭。
- 用 Enter 确认输入法候选词时，不再把输入到一半的指令发给 Agent。

## [0.9.0] - 2026-09-13

内核：`@do-md/core-react` 0.12.1、0.12.2。

### 新增

- 桌面应用支持标签页：一个窗口可以容纳多个文档（[#29](https://github.com/do-md/domd/issues/29)、[#38](https://github.com/do-md/domd/pull/38)，感谢 [@Systemofdumb](https://github.com/Systemofdumb)；后续修复见 [#40](https://github.com/do-md/domd/pull/40)）。
  - ⌘N 新建标签页，⇧⌘N 新建窗口；⇧⌘[ 和 ⇧⌘] 切换标签页；拖动标签页可调整顺序。窗口只有一个文档时不显示标签栏。
  - 每个标签页在切换时保留各自的撤销历史、选区和滚动位置。
  - 从访达打开文件或把文件拖到窗口上时，若已有标签页打开该文件则切换过去，否则复用空白标签页，或新开一个。
  - 关闭有未保存更改的标签页时询问“保存 / 不保存 / 取消”。关闭窗口或退出应用时，会逐个询问所有未保存的无标题标签页，已保存文件的待写入修改会先写入磁盘。
  - 后台标签页的文件被其他程序修改后，切回该标签页时会合并这些修改。
- 协作页加入查找与替换和大纲面板；只读查看者也能使用大纲。
- **内核 API：**`DOMDProvider` 可传入已有的 `store`（自带 `EditorStore`）。内核会记住每个 store 的滚动位置、选区和焦点，视图重新挂载时恢复。

### 变更

- 窗口有多个标签页时，⌘W 关闭当前标签页；“关闭窗口”改为 ⇧⌘W。

### 修复

- 字母快捷键按键帽上的字母匹配，不再按按键位置匹配：在 AZERTY 键盘上 ⌘W 不再触发撤销，QWERTZ、Dvorak 等布局同理（[#36](https://github.com/do-md/domd/pull/36)，感谢 [@Systemofdumb](https://github.com/Systemofdumb)）。*（内核）*
- “编辑”菜单中的撤销、重做、全选（以及 ⌘Z / ⇧⌘Z / ⌘A）交给编辑器处理，不再落到 webview 自带的编辑命令；macOS 以外的平台使用 Ctrl（[#37](https://github.com/do-md/domd/pull/37)，感谢 [@Systemofdumb](https://github.com/Systemofdumb)）。
- macOS 菜单栏只在语言真正变化时才重建。原先每次启动都重建，可能把 ⌘W 之类的快捷键交给一个已经不在屏幕上的菜单项（[#35](https://github.com/do-md/domd/pull/35)，感谢 [@Systemofdumb](https://github.com/Systemofdumb)）。
- 桌面应用中按 ⌘A 不再出现选区一闪就消失；macOS 的文本导航键 Ctrl+A/E/N/P/F/B 恢复正常，不再被当作 ⌘ 快捷键（[#27](https://github.com/do-md/domd/issues/27)、[#39](https://github.com/do-md/domd/pull/39)）。*（内核）*
- 在桌面应用的空文档里按 Backspace 后，编辑器不再变得无法输入（[#33](https://github.com/do-md/domd/issues/33)）。*（内核）*
- 文档加载完成后点击空白处，不再滚回顶部。*（内核）*

## [0.8.1] - 2026-08-30

内核：`@do-md/core-react` 0.12.0。

### 修复

- 桌面应用在第三次点击标题栏按钮时不再崩溃（仅发布版构建受影响）。

## [0.8.0] - 2026-08-30

内核：`@do-md/core-react` 0.12.0。

### 新增

- 文档大纲：左侧面板列出文档中的标题（[#22](https://github.com/do-md/domd/issues/22)）。可从顶栏、桌面应用的标题栏按钮或 ⇧⌘O（Ctrl+Shift+O）打开。当前标题随滚动高亮；点击条目跳到该标题，并把光标放到标题上。
- 查找与替换（[#22](https://github.com/do-md/domd/issues/22)）：⌘F / Ctrl+F 查找，⌥⌘F / Ctrl+H 替换，⌘G / F3 或 Enter / Shift+Enter 在匹配项间移动，Esc 关闭。支持区分大小写、全字匹配、正则表达式（替换内容可引用捕获组）和保留大小写。“全部替换”只占一步撤销。在“更多（⋯）”菜单中也有入口，方便触屏设备使用。
- **内核 API：**`resolveBlockOffset(uuid)` 和 `resolveRanges()`，在 Markdown 偏移和块之间做只读换算。大纲和搜索引擎分别以 `@do-md/toc`、`@do-md/search` 包发布。

## [0.7.1] - 2026-08-27

内核：`@do-md/core-react` 0.11.7。

### 修复

- 文档以代码块或表格结尾时，点击其下方会把光标放到新的空行上。原先光标会落进代码块或表格内部，格式菜单随之失效。*（内核）*

## [0.7.0] - 2026-08-27

内核：`@do-md/core-react` 0.11.6。

### 新增

- 桌面应用标题栏新增按钮：插入（表格、清单）、富文本 / Markdown 模式、AI、Aa 格式菜单和“更多（⋯）”菜单，均使用 macOS 原生菜单。
- 桌面应用的“导出 PDF”直接写入你选择的文件，不弹打印对话框，也没有页眉页脚。
- 在浏览器中打印（⌘P）会打印完整文档，不包含工具栏、协作者光标和作者着色。
- **内核 API：**`store.blur()`，与 `focus()` 对应的模型层操作。

### 变更

- 桌面应用中的 AI 设置（包括 API Key）改为存放在 `~/.domd/ai.json`，不再放在 webview 的本地存储中；已有设置在首次启动时迁移过去。

### 修复

- 点击桌面应用标题栏的空白处，现在会正确离开文档。原先光标仍在闪烁，按键会发到错误的地方，插入操作也会被拒绝。

## [0.6.1] - 2026-08-27

内核：`@do-md/core-react` 0.11.5。

### 修复

- 向前删除（fn+Delete、Ctrl+D、Option+fn+Delete）、删除到行尾（Ctrl+K）、删除到行首（⌘Delete）和按词删除（Option+Delete）现在由编辑器处理。原先可能重复内容、打乱撤销历史，最终让编辑器卡死（[#21](https://github.com/do-md/domd/issues/21)）。*（内核）*

## [0.6.0] - 2026-08-26

内核：`@do-md/core-react` 0.11.4（原为 0.8.1）。

### 新增

- AI Agent 作为协作者（Web）：在文档任意位置输入 `@`，即可在光标处召唤 Agent，告诉它要改什么。它的修改落地时会高亮显示，并像其他协作者一样出现在版本历史和作者着色中；没有进行中的协作也能使用。Agent、模型和 API Key 在 AI 面板中设置；`mock` 模型可离线运行。
- 顶栏新增 Aa 格式菜单（Apple 备忘录风格）：粗体、斜体、下划线、删除线、高亮；标题、小标题、副标题、正文；项目符号列表、编号列表、待办清单；引用块；分割线；清除格式。
- 格式菜单配套快捷键：⇧⌘X 删除线、⇧⌘H 高亮、⌘4–⌘6 标题、⇧⌘L 待办清单、⇧⌘9 引用块、⌘\ 清除格式（Windows 和 Linux 上用 Ctrl 代替 ⌘）。⌘0–⌘6 和 ⌘T 只在桌面应用中能作用到文档，因为浏览器把这些键留给了自己的标签页。
- 欢迎导览（Web）：首次访问且编辑器为空时，会用你的语言打开一份简短导览；已有草稿和协作不受影响。
- 协作页为可编辑的参与者加上与编辑器一致的顶栏：Aa 菜单、插入按钮，以及含模式切换、下载和导出 PDF 的“更多”菜单。
- 格式菜单中的行内格式可以用在表格单元格里。
- **内核 API：**带类型的 headless `EditorStore`、`setSelection()`、`getSelectionOffsets()`、富文本模式与响应式格式状态，以及可选的相邻行内图片分组。具名编辑命令从内核移出，放进新包 `@do-md/commands`。

### 变更

- 编辑器内核开源，采用 GPL-3.0 并附加两项许可（小型主体例外和 FOSS 组合例外），源码放在本仓库。npm 上 0.10.0 及以前的版本仍为 PolyForm Noncommercial 1.0.0；0.11.0 起为 GPL。应用自身代码仍为 MIT，内核可获取商业授权。贡献者需签署 [CLA](./CLA.md)。
- ⌘B / ⌘I / ⌘U 交给编辑器处理，切换方式与菜单完全一致。原先由浏览器自带命令加格式，编辑器无法追踪，所以再按一次也取消不了。
- 富文本 / Markdown 模式切换移入“更多（⋯）”菜单，新增快捷键 ⌘/（Ctrl+/），并会记住上次的选择。
- AI 面板和版本历史面板改为侧边抽屉：宽屏时在文档旁边，小屏时覆盖在文档上方。
- 工具栏的清单按钮改为开关清单，与 ⇧⌘L 相同。

### 移除

- 内核自带的插入代码块快捷键 ⇧⌘C。

### 修复

- 空的待办项（`- [ ] `）和空引用块（`> `）在保存并重新打开后得以保留，不再变成文字为 `[ ]` 的列表项或直接消失。*（内核）*
- 紧跟在段落后、中间没有空行的表格，按 GFM 识别为表格（[#19](https://github.com/do-md/domd/pull/19)，感谢 [@BetterAndBetterII](https://github.com/BetterAndBetterII)）。*（内核）*
- 通过 macOS“编辑”菜单、触控板手势、右键菜单或摇动撤销触发的撤销和重做，改用编辑器自己的历史，不再使用与之脱节的浏览器历史（[#20](https://github.com/do-md/domd/issues/20)）。*（内核）*
- 空表格单元格（例如刚插入的表格）里能看到光标。*（内核）*
- 桌面应用不再在每次启动时重新渲染整个界面。

## [0.5.0] - 2026-08-05

内核：`@do-md/core-react` 0.8.1。

### 新增

- 表格编辑：鼠标悬停在表格右边缘或下边缘可新增一列或一行；光标旁的手柄可打开菜单，插入或删除当前行、列（表头行不能删除）。
- 表格和清单的快捷插入按钮，位于编辑器和协作页顶栏，以及 macOS 标题栏。
- **内核 API：**`renderComponent` 覆盖，用于自定义块渲染器，基于 `serializeRenderData` 和 `RenderChildren`。

## [0.4.1] - 2026-08-02

内核：`@do-md/core-react` 0.7.1。

### 新增

- Shift+Enter 在段落内换行（保存为单个换行符）；Enter 仍然新起一段。*（内核）*

### 变更

- 块与块之间的间距更宽松。*（内核）*

## [0.4.0] - 2026-08-01

内核：`@do-md/core-react` 0.7.0（原为 0.4.7）。

### 新增

- 桌面应用支持实时协同：在标题栏分享当前文档、管理协作。从未保存过的文档也可以分享。
- 其他程序（Obsidian、VS Code、Typora 等）对已打开文件的修改会实时合并进文档，撤销和协作不受影响；DOMD 关闭期间的修改会在恢复协作时合并。
- `domd-cli` 可以打开文件并直接进入分享对话框，供 Obsidian 插件等集成使用。
- 彩色高亮：`=={red}text==` 用 CSS 颜色为高亮着色（[#13](https://github.com/do-md/domd/issues/13)、[#15](https://github.com/do-md/domd/pull/15)）。
- **内核 API：**`inlineRules` 自定义行内语法（v2：字符串定界符、Pandoc 风格参数、variant、通过 React 组件渲染），以及批量编辑原语 `replaceRanges()` / `replaceText()`。

### 变更

- 桌面应用为每个文档提供稳定身份：打开文件时会在 frontmatter 中加入 `domd-id` 字段（缺失时写入文件），使协作在重命名和移动后仍能跟上文档。frontmatter 不会在编辑器中显示。
- 桌面应用生成的分享链接一律指向 https://www.domd.app。
- 内容与磁盘上完全相同时跳过写入，避免触发其他编辑器（如 Typora）的修改检测。

## [0.3.6] - 2026-07-30

内核：`@do-md/core-react` 0.4.7。（v0.3.5 打了标签但未发布，其内容并入本版本。）

### 新增

- 协作管理面板：显示协作者及其在线 / 离线状态；版本时间线在停止编辑片刻后自动记录；可高亮每个人编写的文字；可恢复到之前的版本（恢复本身会成为一个新版本）。
- 显示协作者的选区，而不只是光标。

### 变更

- 加入协作时只传输新成员缺少的变更，不再由每个参与者各发一份完整文档（[#14](https://github.com/do-md/domd/pull/14)）。
- 分享对话框只管理邀请链接；协作者人数移到协作管理面板的按钮上。
- 访客连接期间立即看到最近一次同步的文档，不再先显示空白页。

### 修复

- 高亮器不支持的语言（如 `mermaid`、`jsonc`）的代码块，以纯文本显示代码，不再渲染为空。*（内核）*
- 反向拖选（自下而上或从右到左）时，选区不再在拖动中或松开鼠标后消失。*（内核）*

## [0.3.4] - 2026-07-28

内核：`@do-md/core-react` 0.4.6。

### 修复

- 在表格、代码块或分割线之后的空行输入的文字，保存时不再粘到该块的最后一行上（例如 `| a | b |text`）。*（内核）*

## [0.3.3] - 2026-07-28

内核：`@do-md/core-react` 0.4.5。

### 修复

- 打开时只有一个空段落的文档会显示占位提示。*（内核）*

## [0.3.2] - 2026-07-28

内核：`@do-md/core-react` 0.4.4。

### 新增

- Web 端“更多（⋯）”菜单新增导出 PDF：输出渲染后文档的矢量 PDF，不含语法标记和页眉页脚，保留代码块背景，并以文档名命名（[#12](https://github.com/do-md/domd/pull/12)）。

### 变更

- 排版调整：字体可通过主题设置、开启字体平滑、调整标题字重。*（内核）*

### 修复

- Backspace 会删除整个 emoji，不再留下乱码字符（U+FFFD）。*（内核）*
- 标题或分割线后紧跟列表、表格或引用块（中间没有空行）时，保存后不再并成一行。*（内核）*

## [0.3.1] - 2026-07-27

内核：`@do-md/core-react` 0.4.3。

### 新增

- Web 端实时协同：通过邀请链接分享文档并实时共同编辑，经 WebRTC 点对点连接，显示每个人的光标和名字。链接可设置密码和有效期，只读链接让他人只看不改。图片也会同步。
- 实时同步 Playground（`/playground/live`）：在多个浏览器标签页中打开同一文档，观察编辑和光标的同步。
- Web 编辑器会为当前文档保存本地草稿，刷新页面后自动恢复。
- **内核 API：**用于实时同步的外部操作回放（`applyExternalRenderDataOps`）、光标快照和 span 级锚点。

### 变更

- 编辑器打开时不再自动获取焦点。
- 新建文档前会先确认；协作进行中新建文档会为所有人结束协作。

### 修复

- 协作者离开编辑器后，其他人屏幕上不再残留其光标。*（内核）*
- 撤销后的光标位置更稳定。*（内核）*
- 光标从链接末尾移出后，链接旁不再残留多余文字。*（内核）*

## [0.3.0] - 2026-07-23

内核：`@do-md/core-react` 0.3.1。

### 新增

- 离线无冲突合并：新增双编辑器 CRDT 合并 Playground（`/playground/crdt`），在网站导航中可进入，演示两个编辑器离线修改同一段落后经 Yjs 同步插件无冲突合并。
- **内核 API：**保留 span 的块合并，以及供 CRDT 集成使用的同步接口（操作流的输入与输出）。

### 修复

- 同一页面上的多个编辑器不再互相抢光标。*（内核）*

## [0.2.12] - 2026-07-22

内核：`@do-md/core-react` 0.2.15。

### 变更

- 按 Enter 重新缩进代码，现在也覆盖没有专用格式化器的语言（按括号判断缩进）；Python、YAML 等对缩进敏感的代码保持原样。
- 重写选区跟踪，更加稳健。*（内核）*

### 修复

- 在 iOS 上选中文字时，选区高亮和选择手柄恢复正常；此前在自定义光标下它们显示为灰色或不可见。
- 自定义光标在空段落中的位置正确。
- 在代码块内全选并删除后，代码块不再无法编辑。*（内核）*

## [0.2.11] - 2026-07-15

内核：`@do-md/core-react` 0.2.14。

### 新增

- 在 JavaScript、TypeScript、JSON、CSS、SCSS、Less、HTML 或 XML 代码块中按 Enter，会重新缩进代码（只调整缩进）。

## [0.2.10] - 2026-07-15

内核：`@do-md/core-react` 0.2.12。

### 修复

- Safari 中位于行首的自定义光标不再高出一行。

## [0.2.9] - 2026-07-15

内核：`@do-md/core-react` 0.2.11。

### 新增

- 移动端快捷输入条：在软键盘上方固定一排 Markdown 按键，并适配刘海屏 iPhone 的安全区域（[#11](https://github.com/do-md/domd/pull/11)）。

### 修复

- 自定义光标在代码块中的位置正确。
- 表格边框使用不透明颜色，交叉处不再显得更深。*（内核）*

## [0.2.8] - 2026-07-07

内核：`@do-md/core-react` 0.2.10。

### 新增

- 界面支持英文、中文、日文，跟随系统语言——Web 编辑器和桌面应用都是如此，包括原生菜单。macOS 还会本地化系统标准菜单项和对话框（[#8](https://github.com/do-md/domd/pull/8)）。
- 首页 README 改为阅读优先：以只读文本流式出现，点击“Edit”胶囊按钮即可原地切换到编辑。文字超出首屏后流式速度加快（[#10](https://github.com/do-md/domd/pull/10)）。
- **内核 API：**`setEditable()`。

### 修复

- 自定义光标会自动隐藏原生光标，且只在它所在的编辑器内生效（[#9](https://github.com/do-md/domd/pull/9)）。

## [0.2.7] - 2026-06-24

内核：`@do-md/core-react` 0.2.9——内核改为以 npm 包形式引入。

### 修复

- 用 ⌘Q 或从程序坞退出时，会询问未保存的无标题窗口，不再直接关闭。
- 通过 `domd-cli` 启动 DOMD 时不再多开一个空窗口。
- 文档开头的空行可以删除了。*（内核）*

## [0.2.6] - 2026-06-19

### 修复

- 修正 Delete 键的行为。*（内核）*
- 连续换行（`\n\n`）渲染正确。*（内核）*

## [0.2.5] - 2026-06-17

### 新增

- 文本中的裸 URL 会被识别为链接。*（内核）*
- 点击图片即可选中它，像文字一样删除。*（内核）*

## [0.2.4] - 2026-06-15

### 新增

- 可以用鼠标选中并删除分割线。*（内核）*

### 修复

- 在光标处剪切不再丢失内容。*（内核）*
- 修复桌面应用自动更新可能失败的问题。

## [0.2.3] - 2026-06-09

### 新增

- 流式写入 Playground（`/playground`）：把 Markdown 一块一块流式写入编辑器，可调块大小和延迟（含即时模式），支持拖入文件。
- Markdown 原生输入框 Playground（`/chat`）：基于编辑器构建的 AI 聊天输入框。
- 编辑器、各 Playground 和首页使用自绘光标。
- 网站新增搜索引擎和社交分享元数据，以及分享图、sitemap 和 robots.txt。

### 修复

- 文件名中含 `@` 的 `gh:` 地址（如 `gh:owner/repo:docs/file@v1.md`）能打开文件，不再得到空白文档；`@` 后跟 `feature/new-docs`、`v1.0.0` 这类 ref 时仍按 ref 处理（[#5](https://github.com/do-md/domd/pull/5)，感谢 [@penniger](https://github.com/penniger)）。
- 移动端体验打磨：在 iOS 上点击首页能可靠地停止 README 流式输出，Playground 的设置面板适配小屏幕。

## [0.2.2] - 2026-06-03

### 新增

- 新增 DOMD 应用菜单，包含“关于 DOMD”和“检查更新...”，使用显示 DOMD 图标的原生对话框。

### 变更

- 代码块的渲染和编辑体验更好。*（内核）*

### 修复

- 清单项能正确保存。*（内核）*

## [0.2.1] - 2026-06-02

### 新增

- 首页由 DOMD 本身呈现：README 以你的语言（英文、中文或日文）流式写入一个实时编辑器，写完后即可编辑。
- 使用统计：Web 端用 Vercel Analytics 统计页面浏览量，桌面应用会上报带有平台和应用版本的 `app_open` 事件。

### 修复

- 修复一个可能导致页面无法交互的代码高亮错误。

## [0.2.0] - 2026-06-01

### 新增

- 桌面应用自动更新：启动时和窗口获得焦点时在后台静默下载新版本（最多每小时检查一次），下载完成后在右下角显示“重启”横幅。0.2.0 之前的版本需要手动更新一次。

### 修复

- 进一步修复编辑时 Enter、Tab 和 Delete 的问题。*（内核）*

## [0.1.4] - 2026-05-29

**严重问题修复——请从 v0.1.3 及更早版本升级。**升级后，请重新打开用 v0.1.3 保存过的文档，确认内容完整。

### 新增

- README 新增在 Windows 上运行 Web 应用的说明（[#2](https://github.com/do-md/domd/pull/2)，感谢 [@OddMiss](https://github.com/OddMiss)）。

### 修复

- 文档数据结构调整后，Enter 和 Delete/Backspace 产生错误的编辑结果。*（内核）*
- 文档可能被错误序列化，影响保存到磁盘的 Markdown。*（内核）*

## [0.1.3] - 2026-05-27

### 修复

- 修复删除文字时的一个问题。*（内核）*

## [0.1.2] - 2026-05-27

### 新增

- 在 Apple Silicon 之外新增 Intel（x86_64）Mac 版本。Intel 版本通过 Apple Silicon 上的 Rosetta 2 测试。
- 网站的下载按钮同时提供 Apple Silicon 和 Intel 版本。

## [0.1.1] - 2026-05-26

### 变更

- 关闭有未保存更改的无标题窗口时，使用 macOS 原生的“是否存储更改”表单，包括其中的“删除”按钮。

## [0.1.0] - 2026-05-25

首次发布，仅支持 Apple Silicon。

### 新增

- 基于 Markdown 原生内核的所见即所得 Markdown 编辑，代码块支持语法高亮。
- 原生 macOS 应用：从访达打开 `.md` 文件，多窗口，程序坞菜单，自动保存，拖放文件和图片。
- Quick Look 扩展：在访达中按空格键，即可预览由 DOMD 渲染的 Markdown 文件。
- 面向 agent 和脚本的 `domd-cli`：打开窗口、向文档流式写入内容、改写选区。
- Web 编辑器：拖入 `.md` 文件或从 URL（包括 `gh:owner/repo`）打开，不上传任何内容。

[Unreleased]: https://github.com/do-md/domd/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/do-md/domd/compare/v0.9.2...v0.10.0
[0.9.2]: https://github.com/do-md/domd/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/do-md/domd/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/do-md/domd/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/do-md/domd/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/do-md/domd/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/do-md/domd/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/do-md/domd/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/do-md/domd/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/do-md/domd/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/do-md/domd/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/do-md/domd/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/do-md/domd/compare/v0.3.6...v0.4.0
[0.3.6]: https://github.com/do-md/domd/compare/v0.3.4...v0.3.6
[0.3.4]: https://github.com/do-md/domd/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/do-md/domd/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/do-md/domd/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/do-md/domd/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/do-md/domd/compare/v0.2.12...v0.3.0
[0.2.12]: https://github.com/do-md/domd/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/do-md/domd/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/do-md/domd/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/do-md/domd/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/do-md/domd/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/do-md/domd/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/do-md/domd/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/do-md/domd/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/do-md/domd/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/do-md/domd/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/do-md/domd/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/do-md/domd/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/do-md/domd/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/do-md/domd/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/do-md/domd/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/do-md/domd/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/do-md/domd/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/do-md/domd/releases/tag/v0.1.0
