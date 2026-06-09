import { pickByLocale } from "@/common/lib/locale";
import type { StreamSource } from "./types";

// Localized mock responses (en / zh / ja), matched to the browser language with
// English fallback. Each one: (1) states plainly that it's a mock, (2) points
// to the settings button for real streaming, (3) exercises several Markdown
// constructs so DOMD's live rendering is visible while it streams.

const MOCK_EN = `This is a mocked streaming response.

You can start chatting right away — no API key needed. To try **real** model streaming, open **Settings** (top right) and add your own API key. DOMD renders Markdown while it arrives.

Here is a small Markdown demo:

- **Bold text**
- *Italic text*
- \`inline code\`
- [DOMD on GitHub](https://github.com/do-md/domd)

\`\`\`ts
const chunk = await stream.next()
editor.insertText(chunk)
\`\`\`

| Feature | Behavior                |
| ------- | ----------------------- |
| Input   | Markdown-native WYSIWYG |
| Output  | Streaming Markdown      |
| Storage | Markdown underneath     |

DOMD keeps Markdown editable while it streams.`;

const MOCK_ZH = `这是一段模拟的流式回复。

无需 API key，你现在就能直接开聊。想体验**真实**模型的流式输出，点右上角的**设置**填入你自己的 API key。DOMD 会在内容到达的同时实时渲染 Markdown。

下面是一个小小的 Markdown 演示：

- **粗体文字**
- *斜体文字*
- \`行内代码\`
- [DOMD 的 GitHub](https://github.com/do-md/domd)

\`\`\`ts
const chunk = await stream.next()
editor.insertText(chunk)
\`\`\`

| 能力 | 行为                    |
| ---- | ----------------------- |
| 输入 | Markdown 原生所见即所得 |
| 输出 | 流式 Markdown           |
| 存储 | 底层始终是 Markdown     |

DOMD 让 Markdown 在流式输出时依然可编辑。`;

const MOCK_JA = `これはモック（疑似）のストリーミング応答です。

API キーは不要で、今すぐチャットを始められます。**実際の**モデルのストリーミングを試すには、右上の**設定**から自分の API キーを追加してください。DOMD は届いたそばから Markdown をレンダリングします。

ちょっとした Markdown のデモです:

- **太字**
- *斜体*
- \`インラインコード\`
- [GitHub の DOMD](https://github.com/do-md/domd)

\`\`\`ts
const chunk = await stream.next()
editor.insertText(chunk)
\`\`\`

| 機能 | 挙動                       |
| ---- | -------------------------- |
| 入力 | Markdown ネイティブな WYSIWYG |
| 出力 | ストリーミング Markdown    |
| 保存 | 内部は常に Markdown        |

DOMD はストリーミング中も Markdown を編集可能なまま保ちます。`;

export function mockResponse(): string {
    return pickByLocale({ en: MOCK_EN, zh: MOCK_ZH, ja: MOCK_JA });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Emit the (locale-matched) mock response in small, jittered chunks (1–8 chars,
 * 20–60ms apart) so the playback feels like a real model — including Markdown
 * syntax being split mid-token, which DOMD reconciles as later chunks arrive.
 */
export function mockStreamSource(text: string = mockResponse()): StreamSource {
    return async function* () {
        let i = 0;
        while (i < text.length) {
            const size = 1 + Math.floor(Math.random() * 8); // 1..8
            yield text.slice(i, i + size);
            i += size;
            await sleep(rand(20, 60));
        }
    };
}
