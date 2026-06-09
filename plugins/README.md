# Plugins

Plugin directory for the domd-core (`react-domd`) consumer app, organized by the
two extension pipelines plus shared code:

| Directory    | Category        | Responsibility                                                            | Related core API                          |
| ------------ | --------------- | ------------------------------------------------------------------------- | ----------------------------------------- |
| `rendering/` | Enhanced render | Custom element rendering, decorations, node views — extend the view layer | `Renderer`, `RenderData`, `useRenderData` |
| `parsing/`   | Enhanced parse  | Extend / override Markdown parsing, custom syntax token → RenderData      | `toMarkdown`, `MarkdownType`              |
| `shared/`    | Shared          | Types, registration logic, utilities shared across plugins                | —                                         |

## Conventions

- One plugin per subdirectory; name it in kebab-case by feature, e.g. `rendering/code-highlight/`, `parsing/mermaid/`.
- Each plugin directory exposes an `index.ts` as its entry point.
- When a new category emerges (shortcuts, collaboration, export, etc.), add a sibling category folder here and register it in the table above.