# rbxts-transformer-surge

The TypeScript transformer for [`@rbxts/surge`](https://github.com/travddm/surge):
detects `createSerializer<T>()`/`createDeserializer<T>()`/`createBinarySerializer<T>()`
calls and replaces them with specialized serialize/deserialize code generated
from `T` at compile time. No runtime code of its own — see
[`@rbxts/surge`](https://github.com/travddm/surge) for the package its
generated code calls into.

The full design (why this approach works, the detection/type-walk/codegen
design, the type coverage table, testing strategy) lives in
[travddm/surge's docs/](https://github.com/travddm/surge/tree/main/docs),
particularly `transformer.md` and `testing.md` — kept in one place across
both repos rather than duplicated here.

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
