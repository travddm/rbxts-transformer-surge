# rbxts-transformer-surge

[![CI](https://github.com/travddm/rbxts-transformer-surge/actions/workflows/ci.yml/badge.svg)](https://github.com/travddm/rbxts-transformer-surge/actions/workflows/ci.yml)

The TypeScript transformer for [`@rbxts/surge`](https://github.com/travddm/surge):
detects `createSerializer<T>()`/`createDeserializer<T>()`/`createBinarySerializer<T>()`
calls and replaces them with specialized serialize/deserialize code generated
from `T` at compile time. No runtime code of its own — see
[`@rbxts/surge`](https://github.com/travddm/surge) for the package its
generated code calls into.

What this transformer guarantees is specified in
[travddm/surge's docs/specs/](https://github.com/travddm/surge/tree/master/docs/specs):
`transformer.md` for detection, classification, emission and diagnostics, and
`wire-format.md` for the bytes the generated code writes. Why the approach
works is in `docs/research/compile-time-specialization.md` there, and how both
repositories are tested is in `docs/testing.md`. All of it is kept in one
place across both repos rather than duplicated here.

## Local development

```sh
npm install
npm run compile   # tsc -p tsconfig.json
npm run test      # unit tests (Jest, plain Node -- see docs/testing.md in the surge repo)
```

`mise run ci` runs the full verification suite (lint, format, spell, compile,
test) in the same order as the `.github/workflows/ci.yml` GitHub Actions
workflow (which runs it automatically on every push/PR) and the opt-in
pre-push hook (`mise run hooks:install`); VS Code users can instead run the
`mise: ci` task (`.vscode/tasks.json`, with a Windows shell override to Git
Bash, since mise tasks assume a POSIX shell). `lint:check`/`lint:fix` run
both ESLint and markdownlint (`.markdownlint.json`).

To exercise this transformer against real roblox-ts output, use the
`tests/` project in [travddm/surge](https://github.com/travddm/surge), which
depends on this package directly (as a sibling checkout during local
development, or a `github:` dependency otherwise).
