# DOMDPreview — macOS Quick Look Preview Extension

Renders Markdown using the DOMD frontend when you press space on a `.md` file in Finder. The extension is packaged as an `.appex` inside `DOMD.app/Contents/PlugIns/` and installs/upgrades together with the main app; once the DMG is dragged into `/Applications`, LaunchServices registers it automatically.

## Architecture

```
DOMD.app/Contents/PlugIns/DOMDPreview.appex
├── Contents/Info.plist            # NSExtension + QLSupportedContentTypes
├── Contents/MacOS/DOMDPreview     # Swift bundle (single PreviewViewController)
└── Contents/Resources/web/        # full static output of next build (preview.html + _next/...)
```

**Runtime flow**

1. Press space in Finder → QuickLookUIService launches `DOMDPreview.appex`
2. `PreviewViewController.loadView()` creates a `WKWebView` and registers a `domd://` custom scheme handler (pointing at `Resources/web/` inside the bundle)
3. `preparePreviewOfFile(at:)` reads the Markdown text and injects it into `window.__DOMD_PREVIEW_CONTENT__` via a `WKUserScript (atDocumentStart)`
4. `webView.load(domd://local/preview.html)` → the scheme handler serves the HTML and `/_next/...` assets locally
5. The page is `apps/domd/app/preview/page.tsx`, rendered with `DOMDProvider editable={false}`

**Why a custom scheme instead of `file://`**: Next.js static exports use absolute paths like `/_next/...`, which `file://` cannot resolve. `domd://local/preview.html` lets `PreviewURLSchemeHandler` map the root path to `Resources/web/`.

## Key files

| Path | Purpose |
|---|---|
| `project.yml` | XcodeGen config; declares one `app-extension` target with Info.plist + entitlements |
| `DOMDPreview/Info.plist` | `NSExtension.NSExtensionPointIdentifier=com.apple.quicklook.preview`, `QLSupportedContentTypes=[net.daringfireball.markdown]` |
| `DOMDPreview/DOMDPreview.entitlements` | sandbox + user-selected-read-only + network.client (all three required; see below) |
| `DOMDPreview/Source/PreviewViewController.swift` | extension's main class + `PreviewURLSchemeHandler` |
| `build.sh` | copies `apps/domd/out/` into `DOMDPreview/Resources/web/`, runs xcodegen + xcodebuild, produces an unsigned `.appex` |
| `../../../scripts/build.sh` | outer pipeline: Tauri → embed appex → inject UTI → sign → notarize → DMG |
| `../../../scripts/inject-uti.sh` | injects `UTImportedTypeDeclarations` into the main app's Info.plist, declaring the `.md` UTI |
| `../../../app/preview/page.tsx` | frontend preview page; receives `window.__DOMD_PREVIEW_CONTENT__` and renders it |

## Entitlements (the easiest place to trip up)

```xml
<key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.security.files.user-selected.read-only</key><true/>
<key>com.apple.security.network.client</key><true/>
```

- `app-sandbox` — QL extensions **must** be sandboxed; otherwise the system disables them on registration and shows a prohibited icon in Settings
- `files.user-selected.read-only` — read the file URL passed in by QL
- `network.client` — **required even when WKWebView only uses a custom scheme**, otherwise the WebContent child process is killed by sandbox immediately (you'll see `webContentProcessTerminated` in the logs)

The outer `scripts/build.sh` embeds these explicitly with `codesign --entitlements <path>`; `preserve-metadata` doesn't apply here (we're signing from scratch).

## UTI declaration

The main app's Info.plist must declare that it "knows about" `net.daringfireball.markdown`, or LaunchServices won't route `.md` files to this extension:

```xml
<key>UTImportedTypeDeclarations</key>
<array>
  <dict>
    <key>UTTypeIdentifier</key><string>net.daringfireball.markdown</string>
    <key>UTTypeConformsTo</key><array><string>public.plain-text</string></array>
    <key>UTTypeTagSpecification</key>
    <dict><key>public.filename-extension</key><array><string>md</string><string>markdown</string></array></dict>
  </dict>
</array>
```

Injected at build time by `scripts/inject-uti.sh` via `plutil` (Tauri's `tauri.conf.json` doesn't conveniently express fields this complex).

## Signing order

Must be bottom-up. The outer `scripts/build.sh` does:

1. `npx tauri build --bundles app` (Tauri signs the main app itself)
2. Build extension → copy into `DOMD.app/Contents/PlugIns/`
3. `inject-uti.sh` modifies the main app's Info.plist
4. `codesign --entitlements <ql.entitlements>` re-signs the **.appex**
5. `codesign --preserve-metadata=entitlements` re-signs the **.app** (preserving Tauri's entitlements)
6. `notarytool submit --wait` + `stapler staple` on the main app
7. `hdiutil create` packs the DMG (with a `/Applications` symlink)
8. Sign + notarize + staple the DMG

## Local build

```bash
cd apps/domd
npm run build                 # produces out/ (Next.js static export)
./scripts/build.sh            # needs APPLE_* signing keys in .env.local
# Output: src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/DOMD_<ver>_aarch64.dmg
```

Extension-only build (skip signing/notarization):

```bash
./src-tauri/preview-extension/build.sh
# Output: src-tauri/preview-extension/build/Release/DOMDPreview.appex (unsigned)
```

Dependencies: `xcodegen` (`brew install xcodegen`), Xcode 14+, Node.js.

## Debugging / troubleshooting

### Verifying it actually works after install

1. System Settings → Privacy & Security → Extensions → Quick Look: DOMD should appear and be enabled
2. `pluginkit -m -v -p com.apple.quicklook.preview | grep -i domd` should print something
3. `mdls -name kMDItemContentType some.md` should return `net.daringfireball.markdown`
4. Press space on a `.md` in Finder → it renders

### Troubleshooting logs

The extension's `NSLog` calls go into the unified log; filter by prefix:

```bash
log stream --style=compact --predicate 'eventMessage CONTAINS "[DOMDPreview]"'
```

A normal run looks like:

```
loadView done, webBase=.../web
prepare url=/path/to/foo.md
read md len=N
load called, nav=non-nil
didStartProvisional
scheme 200: preview.html (X bytes)
scheme 200: _next/static/... (multiple)
didCommit
didFinish
```

### WebKit-level debugging

`PreviewViewController.loadView()` sets `webView.isInspectable = true`. After triggering a preview:

- Safari → Settings → Advanced → check "Show Develop menu in menu bar"
- Develop menu → `<your machine name>` → pick `preview.html` to open Web Inspector

This gives you direct access to Console / Network errors and resource loads in the frontend.

### Common symptoms → causes

| Symptom | Cause |
|---|---|
| "Prohibited" icon in Settings | Extension failed to launch and got blacklisted — 95% of the time it's an entitlements problem (missing sandbox / network.client) |
| `pluginkit` doesn't see it | Bundle integrity / signing problem, or quarantine was not cleared after install into `/Applications`. Run `xattr -cr` + `lsregister -f -R` to re-register |
| Log stops at `read md len=N`, nothing further | `webView.load` did not actually start navigation — scheme handler is unregistered or got released too early |
| Log shows `webContentProcessTerminated` | WebContent child killed by sandbox; usually missing `network.client` |
| `nav=non-nil` followed immediately by `didFailProvisional` | WebKit refused to load — read the error (often a URL scheme problem or a missing asset path) |
| `scheme 200: preview.html` with no `didFinish` after | HTML is stuck on a blocking resource — the next scheme request 404s; find the missing path in the `scheme 404:` log line |

### Reinstall / clear cache

macOS blacklists extensions that "crash repeatedly". After changing code and reinstalling, always:

```bash
pluginkit -e use -i com.domd.desktop.preview
killall quicklookd QuickLookUIService 2>/dev/null || true
```

### xattr permission issues

macOS 13+ uses App Management protection on `/Applications`, so Terminal can't modify xattrs of installed apps. Workarounds:

- Before reinstalling, `sudo rm -rf /Applications/DOMD.app`, then drag the new bundle in
- Or, during development, install into `~/Applications/` (no xattr restrictions there)

## Known limitations

- Only `net.daringfireball.markdown` is declared. Variants like `.mdx` or `.markdown` aren't covered (extend the extension's `QLSupportedContentTypes` + the main app's `UTImportedTypeDeclarations` when needed)
- `preview.html` uses `DOMDProvider editable={false}`, which reuses the editor bundle. A future improvement is splitting out a render-only subset to shrink the bundle
- Universal binary (arm64 + x86_64), but only the arm64 build path has been tested
