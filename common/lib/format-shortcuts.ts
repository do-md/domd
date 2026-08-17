/**
 * App-side policy for the editor command shortcuts.
 *
 * The registry itself — which key fires which command, and how the combination
 * is spelled on each platform — lives in `@do-md/commands`, alongside the
 * commands it fires, so a hint and its keystroke can never drift apart. What
 * stays here is the one thing that is genuinely THIS APP's call: which
 * commands are currently withheld from users.
 *
 * Nothing is kernel-owned any more. @do-md/core-react binds only undo/redo,
 * select-all, Enter/Tab and the IME plumbing; ⌘0-⌘6 (heading levels), ⌘T
 * (table) and the code-block key used to be its and are now the command
 * layer's, which means every one of them routes through the same function the
 * menu rows call.
 */

import { type EditorCommandId } from "@do-md/commands";

export { isApplePlatform, shortcutLabel } from "@do-md/commands";

/** Alias kept for readability at the call sites, which all talk about the
 *  format menu. */
export type FormatCommandId = EditorCommandId;

/**
 * Commands withheld from the UI while their interaction is reworked. Parking
 * them HERE rather than just dropping the menu rows keeps the two halves in
 * step: a hidden command must not stay reachable by keystroke, or the feature
 * is only half-hidden. The implementations stay in place and under test — to
 * bring one back, delete it from this set and re-add its <MenuRow>.
 */
export const HIDDEN_COMMANDS: ReadonlySet<FormatCommandId> = new Set([
    "codeBlock",
    "link",
]);
