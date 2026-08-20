import { CursorMarker } from "../editor/constant";

// A CursorMarker directly after the closing ``` is absorbed into the
// code block so the cursor stays inside it.
export const CODE_AREA_REG = new RegExp(
    `\`\`\`[\\s\\S]*?(?:\`\`\`${CursorMarker}?|$)`,
);
// export const UL_AREA_REG = /^\s*[-+*]\s+(.*)(\n\s*[-+*]\s+.*)*/gm;
export const UL_AREA_REG = /^(\s*[-*+]\s+.*|\s*[-*+]\s*)$/gm;
export const OL_LINE_REG = /^\d+\.\s/;
