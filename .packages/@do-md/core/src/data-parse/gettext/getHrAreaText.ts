// CommonMark thematic break:
//   - 0-3 leading spaces
//   - 3+ matching chars from `-` / `_` / `*`
//   - spaces/tabs allowed between and after the chars
//   - terminated by newline or EOF
const HR_LINE_REG = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}(?=\r?\n|$)/;

export const getHrAreaText = (text: string): string | null => {
    const match = text.match(HR_LINE_REG);
    return match ? match[0] : null;
};
