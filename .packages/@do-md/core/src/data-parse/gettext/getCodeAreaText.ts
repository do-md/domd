import { CODE_AREA_REG } from "../reg";

export const getCodeAreaText = (text: string) => {
    const match = CODE_AREA_REG.exec(text);

    if (match?.[0]) return match?.[0];

    // const index = text.indexOf("\n\n");

    // if (index === -1 && text.startsWith("```")) {
    //     return text;
    // }

    // if (text.slice(0, index).startsWith("```")) {
    //     return text;
    // }

    // if (text.startsWith("```")) {
    //     return text;
    // }

    return null;
};
