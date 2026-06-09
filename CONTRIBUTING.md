# Contributing to DOMD

Thanks for your interest in DOMD.

This document covers local development setup and basic contribution notes.

## Development setup

### Web app

Prerequisites:

* Windows 10/11, macOS, or Linux
* Node.js LTS with npm
* Git

Install dependencies:

```bash
npm install
```

Start the dev server:

```bash
npm run dev
```

Then open:

```txt
http://localhost:3000
```

Build and run production:

```bash
npm run build
npm run start
```

### Native app

Native development currently requires macOS.

```bash
npm run tauri dev
```

Windows native builds are not currently supported.

## Issues and pull requests

Bug reports, reproduction cases, documentation fixes, and small focused improvements are welcome.

For bugs, please include the platform, DOMD version if available, steps to reproduce, and the expected / actual behavior.

## Licensing

DOMD has two main layers:

1. The application layer, including the macOS app, web app, and helper libraries.
2. The core editor engine, `@do-md/dist`.

The application layer is open-source where applicable.

The core editor engine, `@do-md/dist`, is distributed as a prebuilt build artifact under the PolyForm Noncommercial 1.0.0 license. Commercial use requires prior written authorization.

For details, see the licensing section in [README.md](./README.md).
