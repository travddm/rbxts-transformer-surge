# rbxts-transformer-surge

[![CI](https://github.com/travddm/rbxts-transformer-surge/actions/workflows/ci.yml/badge.svg)](https://github.com/travddm/rbxts-transformer-surge/actions/workflows/ci.yml)

The TypeScript transformer for [`@rbxts/surge`](https://github.com/travddm/surge).
It finds each `createCodec<T>()`, `createSerializer<T>()` and
`createDeserializer<T>()` call and replaces it with serialize and deserialize
code generated for `T` at compile time. It has no run-time code of its own;
the code it generates calls `@rbxts/surge`.

Register it in a roblox-ts project's `tsconfig.json`:

```json
{
	"compilerOptions": {
		"plugins": [{ "transform": "rbxts-transformer-surge" }]
	}
}
```

Install it beside `@rbxts/surge`, pinned to the same release; surge's
[getting-started.md](https://github.com/travddm/surge/blob/master/docs/getting-started.md)
has the steps.

## Documentation

Both repositories' documentation lives in surge. What this transformer
guarantees is
[docs/specs/transformer.md](https://github.com/travddm/surge/blob/master/docs/specs/transformer.md),
and the bytes its code writes are
[docs/specs/wire-format.md](https://github.com/travddm/surge/blob/master/docs/specs/wire-format.md).

## Contributing

Start with [AGENTS.md](AGENTS.md). Check this repository out beside surge,
then:

```sh
mise install
mise run ci   # lint, format, spell, compile, and the Jest suites
```

VS Code users can run the `transformer: ci` task instead. What the generated
code does when it runs is tested in surge, whose `mise run ci` compiles its
tests through this transformer.
