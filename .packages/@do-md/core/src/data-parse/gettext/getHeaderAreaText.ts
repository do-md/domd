import { CursorMarker } from "../../editor/constant";

export const getHeaderAreaText = (text: string) => {
    const newLineIndex = text.indexOf("\n");
    const cursorIndex = text.indexOf(CursorMarker);
    text = text.replaceAll(CursorMarker, "");

    if (text.startsWith("###### ")) {
        if (cursorIndex !== -1) {
            text =
                text.slice(0, cursorIndex) +
                CursorMarker +
                text.slice(cursorIndex);
        }
        if (newLineIndex === -1) return text;
        return text.slice(0, newLineIndex);
    }
    if (text.startsWith("##### ")) {
        if (cursorIndex !== -1) {
            text =
                text.slice(0, cursorIndex) +
                CursorMarker +
                text.slice(cursorIndex);
        }
        if (newLineIndex === -1) return text;
        return text.slice(0, newLineIndex);
    }
    if (text.startsWith("#### ")) {
        if (cursorIndex !== -1) {
            text =
                text.slice(0, cursorIndex) +
                CursorMarker +
                text.slice(cursorIndex);
        }
        if (newLineIndex === -1) return text;
        return text.slice(0, newLineIndex);
    }
    if (text.startsWith("### ")) {
        if (cursorIndex !== -1) {
            text =
                text.slice(0, cursorIndex) +
                CursorMarker +
                text.slice(cursorIndex);
        }
        if (newLineIndex === -1) return text;
        return text.slice(0, newLineIndex);
    }
    if (text.startsWith("## ")) {
        if (cursorIndex !== -1) {
            text =
                text.slice(0, cursorIndex) +
                CursorMarker +
                text.slice(cursorIndex);
        }
        if (newLineIndex === -1) return text;
        return text.slice(0, newLineIndex);
    }
    if (text.startsWith("# ")) {
        if (cursorIndex !== -1) {
            text =
                text.slice(0, cursorIndex) +
                CursorMarker +
                text.slice(cursorIndex);
        }
        if (newLineIndex === -1) return text;
        return text.slice(0, newLineIndex);
    }
    return null;
};
