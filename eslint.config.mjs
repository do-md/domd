import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The desktop shell holds no hand-written JS/TS at all (Rust + Swift + Xcode
    // project files). What it does hold, in three places, is copies of the exported web
    // app: target/**/bundle/, preview-extension/build/ and the staged
    // preview-extension/DOMDPreview/Resources/web/. Linting those means linting minified
    // Next.js chunks — 84k problems drowning every real one.
    "src-tauri/**",
    // Published build artifacts of the vendored packages: generated, never hand-edited.
    ".packages/**/dist/**",
  ]),
]);

export default eslintConfig;
