import type { ReactNode } from "react";

/**
 * Markdown quick-input key set for the mobile toolbar.
 *
 * Each key inserts `insertText` at the caret and then repositions the caret
 * by `cursorOffset`, measured from the END of the inserted text (0 = caret
 * stays after the whole insertion, negative = step left into it). The offset
 * is applied via `EditorStore.insertText(text, undefined, cursorOffset)`.
 *
 * Key caps follow the Apple Notes format-bar language: typographic glyphs
 * for text styles (B / I / #), stroke icons for structural keys. Icons are
 * hand-inlined 24x24 stroke SVGs (lucide-style geometry) so the plugin stays
 * dependency-free and every cap shares the same stroke weight.
 */
export interface QuickInputKey {
    /** Stable identity for React keys. */
    id: string;
    /** Key cap content (glyph span or SVG icon). */
    cap: ReactNode;
    /** Text inserted at the caret. */
    insertText: string;
    /** Caret offset from the end of the inserted text (negative = leftwards). */
    cursorOffset: number;
    /** Accessible description (title / aria-label). */
    title: string;
}

function Icon({ children }: { children: ReactNode }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-[22px]"
            aria-hidden
        >
            {children}
        </svg>
    );
}

function Glyph({
    children,
    className = "",
}: {
    children: ReactNode;
    className?: string;
}) {
    return (
        <span className={`text-[19px] leading-none ${className}`}>
            {children}
        </span>
    );
}

export const QUICK_INPUT_KEYS: QuickInputKey[] = [
    {
        id: "tab",
        title: "Tab",
        insertText: "\t",
        cursorOffset: 0,
        cap: (
            <Icon>
                <polyline points="3 8 7 12 3 16" />
                <line x1="21" x2="11" y1="6" y2="6" />
                <line x1="21" x2="11" y1="12" y2="12" />
                <line x1="21" x2="11" y1="18" y2="18" />
            </Icon>
        ),
    },
    {
        // Bare "#" with no trailing space so repeated taps build multi-level
        // headings (##, ###) before the user types the space + text.
        id: "heading",
        title: "Heading",
        insertText: "#",
        cursorOffset: 0,
        cap: <Glyph className="font-semibold">#</Glyph>,
    },
    {
        // Ordered list: needs the trailing space to be parsed as a marker.
        id: "ordered-list",
        title: "Ordered list",
        insertText: "1. ",
        cursorOffset: 0,
        cap: (
            <Icon>
                <line x1="10" x2="21" y1="6" y2="6" />
                <line x1="10" x2="21" y1="12" y2="12" />
                <line x1="10" x2="21" y1="18" y2="18" />
                <path d="M4 6h1v4" />
                <path d="M4 10h2" />
                <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
            </Icon>
        ),
    },
    {
        id: "bullet-list",
        title: "Bullet list",
        insertText: "- ",
        cursorOffset: 0,
        cap: (
            <Icon>
                <line x1="8" x2="21" y1="6" y2="6" />
                <line x1="8" x2="21" y1="12" y2="12" />
                <line x1="8" x2="21" y1="18" y2="18" />
                <line x1="3" x2="3.01" y1="6" y2="6" />
                <line x1="3" x2="3.01" y1="12" y2="12" />
                <line x1="3" x2="3.01" y1="18" y2="18" />
            </Icon>
        ),
    },
    {
        id: "checklist",
        title: "Checklist",
        insertText: "- [ ] ",
        cursorOffset: 0,
        cap: (
            <Icon>
                <path d="m3 17 2 2 4-4" />
                <path d="m3 7 2 2 4-4" />
                <path d="M13 6h8" />
                <path d="M13 12h8" />
                <path d="M13 18h8" />
            </Icon>
        ),
    },
    {
        // Code fence: just the opening ``` — the user presses Enter themselves.
        id: "code-block",
        title: "Code block",
        insertText: "```",
        cursorOffset: 0,
        cap: (
            <Icon>
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
            </Icon>
        ),
    },
    {
        id: "quote",
        title: "Quote",
        insertText: "> ",
        cursorOffset: 0,
        cap: (
            <Icon>
                <path d="M17 6H3" />
                <path d="M21 12H8" />
                <path d="M21 18H8" />
                <path d="M3 12v6" />
            </Icon>
        ),
    },
    {
        id: "bold",
        title: "Bold",
        insertText: "****",
        cursorOffset: -2,
        cap: <Glyph className="font-bold">B</Glyph>,
    },
    {
        id: "italic",
        title: "Italic",
        insertText: "**",
        cursorOffset: -1,
        cap: <Glyph className="font-serif italic">I</Glyph>,
    },
    {
        id: "highlight",
        title: "Highlight",
        insertText: "====",
        cursorOffset: -2,
        cap: (
            <Icon>
                <path d="m9 11-6 6v3h9l3-3" />
                <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
            </Icon>
        ),
    },
];
