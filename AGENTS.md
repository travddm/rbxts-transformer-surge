# AGENTS.md

The entry point for anyone changing `rbxts-transformer-surge`, person or
agent. This repository holds the transformer only. Its documentation, the
runtime package it generates calls to, and the tests that run what it
generates are in [surge](https://github.com/travddm/surge), which must be
checked out beside this repository at `../surge`.

## Documentation

Every document is in surge's `docs/`. The ones this repository answers to:

| Document                                                                                       | Owns                                                          |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [specs/transformer.md](https://github.com/travddm/surge/blob/master/docs/specs/transformer.md) | What the transformer detects, classifies, emits and reports   |
| [specs/wire-format.md](https://github.com/travddm/surge/blob/master/docs/specs/wire-format.md) | The bytes the generated code writes                           |
| [specs/runtime-api.md](https://github.com/travddm/surge/blob/master/docs/specs/runtime-api.md) | The runtime functions the generated code calls                |
| [supported-types.md](https://github.com/travddm/surge/blob/master/docs/supported-types.md)     | What a user is told about each type                           |
| [contributing.md](https://github.com/travddm/surge/blob/master/docs/contributing.md)           | Setup, every task, and working across both repositories       |
| [coding-standards.md](https://github.com/travddm/surge/blob/master/docs/coding-standards.md)   | Formatting, types, naming, file organization and comments     |
| [testing.md](https://github.com/travddm/surge/blob/master/docs/testing.md)                     | What `mise run ci` checks, and how to write a test            |
| [AGENTS.md](https://github.com/travddm/surge/blob/master/AGENTS.md)                            | surge's rules, and which document each kind of change updates |

## Setup

Clone this repository and surge side by side, then run `mise install` in
each. surge's [contributing.md](https://github.com/travddm/surge/blob/master/docs/contributing.md)
has the rest.

## Commands

| Command                                    | Does                                            |
| ------------------------------------------ | ----------------------------------------------- |
| `mise run ci`                              | lint, format, spell, compile and test, in order |
| `mise run lint:fix`, `mise run format:fix` | apply the lint and format fixes                 |
| `mise run compile`                         | build `lib/`, deleting output with no source    |
| `mise run test`                            | the Jest suites under `test/`                   |

## Where to make changes

- `src/walk.ts` turns a TypeScript type into a `Field` tree, and
  `src/field.ts` defines the tree. `src/emit/` turns the tree into
  statements, one module per concern; `src/field.ts` lists every switch a new
  kind needs. `src/index.ts` finds call sites and reads their options, and
  `src/detect.ts` recognizes surge's factories and brands.
- `test/fixtures/rbxts-surge/` is a stand-in for `@rbxts/surge`'s public
  declarations, which this repository cannot depend on. Change it in the
  same commit as a change to what surge exports.
- What the generated code does when it runs is tested in surge: its
  round-trip suite compiles through this transformer. Run `mise run ci` in
  surge after a change here; it reinstalls this repository first.

## Rules

- No `any`; `mise run ci` fails on one.
- Never depend on `@rbxts/surge` at run time. Recognize its declarations
  through the checker of the program being transformed.
- A diagnostic is how a type the transformer cannot encode is reported. Never
  fall back to something that compiles but is wrong.
- A change to what the generated code does, or to a diagnostic, changes
  surge's specifications in the matching commit; see surge's
  [AGENTS.md](https://github.com/travddm/surge/blob/master/AGENTS.md).
- Review a snapshot change before accepting it with `npx jest -u`.
- Push this repository before surge when a change spans both: surge's CI
  checks out this repository's default branch.

## Verifying changes

Before a change is complete, run `mise run lint:fix` and
`mise run format:fix`, then `mise run ci` here and in surge.
