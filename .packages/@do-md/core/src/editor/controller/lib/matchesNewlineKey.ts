import { NewlineKey } from "../../type";
import { commandKey } from "./commandKey";

/** In embed mode, whether this Enter event matches the configured "newline key". */
export function matchesNewlineKey(e: KeyboardEvent, key: NewlineKey) {
    if (e.key !== "Enter") return false;
    switch (key) {
        case "Shift+Enter":
            return e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
        case "Mod+Enter":
            return commandKey(e) && !e.shiftKey && !e.altKey;
        default:
            return false;
    }
}