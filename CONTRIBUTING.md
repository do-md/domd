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

## Contributor License Agreement

Before a pull request can be merged, we need a one-time **Contributor License Agreement**
from you. See **[CLA.md](./CLA.md)**.

Signing is done in the pull request itself: a bot comments with a single sentence to post,
and records your signature. It takes about a minute and covers all of your future
contributions.

**You keep the copyright to your work.** The CLA is a license grant, not an assignment —
you may still use and relicense your own code anywhere else, for anything.

The reason we ask: the editor kernel is dual-licensed — GPL-3.0 for everyone, plus a
commercial license for organizations that cannot comply with the GPL. That is what funds
the project. Code contributed under the GPL alone could never be included in a commercial
license, so without the agreement an accepted contribution would later have to be removed
and rewritten. Everything you contribute stays published under the project's open-source
licenses, permanently.

## Licensing

DOMD has two layers, under different licenses:

| Layer | Location | License |
| --- | --- | --- |
| Application — macOS app, web app, plugins, helper libraries | repository root | [MIT](./LICENSE) |
| Editor kernel — `@do-md/core-react` | `.packages/@do-md/core/` | [GPL-3.0-only](./.packages/@do-md/core/LICENSE), with [additional permissions](./.packages/@do-md/core/LICENSE-EXCEPTIONS.md) under GPL section 7 |

The kernel source lives in this repository and the application builds against it directly,
so a kernel change takes effect without publishing anything. The kernel is also published
to npm as [`@do-md/core-react`](https://www.npmjs.com/package/@do-md/core-react) for use
outside DOMD.

Commercial use of the kernel beyond what the GPL and its additional permissions allow
requires a commercial license — contact the maintainer.

For details, see the licensing section in [README.md](./README.md).
