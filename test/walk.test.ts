import { loadDeclaration, walkDeclaration } from "./harness";

describe("TypeWalker classification", () => {
	// Regression test for the bug this task's advisor review caught: the
	// checker represents the plain `boolean` type as the union `true | false`
	// in property-type position, which the literal-union branch would
	// misclassify as a 2-value literal index unless `walkUnion` special-cases
	// it back to `bool` first.
	test("a plain boolean property classifies as bool, not a literal union", () => {
		const { field } = walkDeclaration("interface T { flag: boolean; }", "T");
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "flag", field: { kind: "bool", packed: false } }],
		});
	});

	test("primitive fields classify by their own kind", () => {
		const { field } = walkDeclaration("interface T { n: number; s: string; }", "T");
		expect(field).toEqual({
			kind: "object",
			fields: [
				{ name: "n", field: { kind: "num", width: "f64" } },
				{ name: "s", field: { kind: "str" } },
			],
		});
	});

	test("object fields are sorted by name regardless of declaration order", () => {
		const forward = walkDeclaration("interface T { a: string; b: number; }", "T").field;
		const reversed = walkDeclaration("interface T { b: number; a: string; }", "T").field;
		expect(forward).toEqual(reversed);
	});

	test("array, tuple, Map, Set, and Record classify with the expected dict source tag", () => {
		const { field } = walkDeclaration(
			`interface T {
				arr: number[];
				tup: [string, number];
				m: Map<string, number>;
				s: Set<string>;
				rec: Record<string, number>;
			}`,
			"T",
		);
		expect(field.kind).toBe("object");
		if (field.kind !== "object") throw new Error("unreachable");
		const byName = new Map(field.fields.map((entry) => [entry.name, entry.field]));
		expect(byName.get("arr")).toEqual({ kind: "array", element: { kind: "num", width: "f64" } });
		expect(byName.get("tup")).toEqual({
			kind: "tuple",
			fixed: [{ kind: "str" }, { kind: "num", width: "f64" }],
			rest: undefined,
		});
		expect(byName.get("m")).toMatchObject({ kind: "dict", source: "map" });
		expect(byName.get("s")).toMatchObject({ kind: "dict", source: "set" });
		expect(byName.get("rec")).toMatchObject({ kind: "dict", source: "record" });
	});

	test("a finite key union (Record<'a'|'b', V>) walks as a fixed-property object, not an index-signature dict", () => {
		const { field } = walkDeclaration(`type T = Record<"a" | "b", number>;`, "T");
		expect(field).toEqual({
			kind: "object",
			fields: [
				{ name: "a", field: { kind: "num", width: "f64" } },
				{ name: "b", field: { kind: "num", width: "f64" } },
			],
		});
	});

	test("tagged union variants sort by literal tag value regardless of declaration order", () => {
		const forward = walkDeclaration(`type T = { kind: "a"; x: number } | { kind: "b"; y: number };`, "T").field;
		const reversed = walkDeclaration(`type T = { kind: "b"; y: number } | { kind: "a"; x: number };`, "T").field;
		expect(forward).toEqual(reversed);
		expect(forward.kind).toBe("taggedUnion");
	});

	test("a union with two table-shaped variants and no shared discriminant is rejected with a diagnostic", () => {
		const { field, diagnostics } = walkDeclaration(`type T = { a: number } | { b: number };`, "T");
		expect(field).toEqual({ kind: "blob" });
		expect(diagnostics.length).toBeGreaterThan(0);
	});

	// Regression test for a second bug this task's advisor review caught,
	// found while fixing the first: a named object type walked once plain
	// and once as a `Packed<T>` subtree (the same `interface` reused as a
	// plain field and a packed field elsewhere in the same root type) must
	// not share one cached `Field` between the two -- only the packed walk's
	// booleans should come back with `packed: true`.
	test("the same named object type walked plain and packed produces two distinct Fields, not a shared cache entry", () => {
		const { type, node, walker, cleanup } = loadDeclaration("interface Flags { a: boolean; b: boolean; }", "Flags");
		try {
			const plain = walker.walk(type, node, false);
			const packed = walker.walk(type, node, true);
			expect(plain).toEqual({
				kind: "object",
				fields: [
					{ name: "a", field: { kind: "bool", packed: false } },
					{ name: "b", field: { kind: "bool", packed: false } },
				],
			});
			expect(packed).toEqual({
				kind: "object",
				fields: [
					{ name: "a", field: { kind: "bool", packed: true } },
					{ name: "b", field: { kind: "bool", packed: true } },
				],
			});
		} finally {
			cleanup();
		}
	});
});

describe("TypeWalker classification with fixture packages", () => {
	test("a DataType.* brand classifies by its declared width, not as a plain number", () => {
		const { field } = walkDeclaration(
			`import { DataType } from "@rbxts/surge"; interface T { n: DataType.f32; }`,
			"T",
			{ surge: true },
		);
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "n", field: { kind: "num", width: "f32" } }],
		});
	});

	test("DataType.Packed<T> bit-packs its boolean fields", () => {
		const { field } = walkDeclaration(
			`import { DataType } from "@rbxts/surge";
			interface Inner { a: boolean; }
			interface T { p: DataType.Packed<Inner>; }`,
			"T",
			{ surge: true },
		);
		expect(field).toEqual({
			kind: "object",
			fields: [
				{
					name: "p",
					field: { kind: "object", fields: [{ name: "a", field: { kind: "bool", packed: true } }] },
				},
			],
		});
	});

	test("Vector3 classifies as the vector3 scalar kind", () => {
		const { field } = walkDeclaration("interface T { v: Vector3; }", "T", { roblox: true });
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "v", field: { kind: "vector3" } }],
		});
	});

	test("a real Roblox enum walks as an enum Field with sorted members", () => {
		const { field } = walkDeclaration("interface T { s: Enum.SortOrder; }", "T", { roblox: true });
		expect(field).toEqual({
			kind: "object",
			fields: [
				{
					name: "s",
					field: { kind: "enum", enumName: "SortOrder", members: ["Custom", "LayoutOrder", "Name"] },
				},
			],
		});
	});

	// `Instance` is documented as the opaque blob-passthrough channel
	// (Type Coverage in transformer.md), but it declares real properties in
	// `@rbxts/types`, so the walk recurses into them instead of falling back
	// to `blob` -- the exact gap tracked in
	// docs/future-work/blob-classification.md. This asserts the current
	// (buggy) behavior, not the documented one; update it once that fix lands.
	test("Instance currently walks its declared properties instead of falling back to the blob passthrough channel", () => {
		const { field } = walkDeclaration("interface T { i: Instance; }", "T", { roblox: true });
		expect(field.kind).toBe("object");
		if (field.kind !== "object") throw new Error("unreachable");
		expect(field.fields.find((entry) => entry.name === "i")?.field.kind).toBe("object");
	});
});

// Regression tests for docs/future-work/walk-type-identity.md: `resolved`,
// `inProgress`, and `helperNames` are keyed by `ts.Type` identity, not by
// the shared declaration symbol, so two instantiations of one generic
// classify independently instead of colliding.
describe("TypeWalker generic instantiation identity", () => {
	test("two instantiations of one generic interface classify independently", () => {
		const { field } = walkDeclaration(
			"interface Box<T> { v: T } interface T { a: Box<number>; b: Box<string>; }",
			"T",
		);
		expect(field).toEqual({
			kind: "object",
			fields: [
				{ name: "a", field: { kind: "object", fields: [{ name: "v", field: { kind: "num", width: "f64" } }] } },
				{ name: "b", field: { kind: "object", fields: [{ name: "v", field: { kind: "str" } }] } },
			],
		});
	});

	test("two instantiations of one anonymous type-alias body classify independently", () => {
		const { field } = walkDeclaration(
			`type Pair<T> = { first: T; second: T };
			interface T { a: Pair<number>; b: Pair<string>; }`,
			"T",
		);
		expect(field.kind).toBe("object");
		if (field.kind !== "object") throw new Error("unreachable");
		const byName = new Map(field.fields.map((entry) => [entry.name, entry.field]));
		expect(byName.get("a")).toEqual({
			kind: "object",
			fields: [
				{ name: "first", field: { kind: "num", width: "f64" } },
				{ name: "second", field: { kind: "num", width: "f64" } },
			],
		});
		expect(byName.get("b")).toEqual({
			kind: "object",
			fields: [
				{ name: "first", field: { kind: "str" } },
				{ name: "second", field: { kind: "str" } },
			],
		});
	});

	test("a nested instantiation of the same generic (Wrapper<Wrapper<number>>) is not misdetected as recursion", () => {
		const { field } = walkDeclaration(
			"interface Wrapper<T> { inner: T } interface T { w: Wrapper<Wrapper<number>>; }",
			"T",
		);
		expect(field).toEqual({
			kind: "object",
			fields: [
				{
					name: "w",
					field: {
						kind: "object",
						fields: [
							{
								name: "inner",
								field: {
									kind: "object",
									fields: [{ name: "inner", field: { kind: "num", width: "f64" } }],
								},
							},
						],
					},
				},
			],
		});
	});
});

// Regression tests for docs/future-work/recursive-union-types.md: recursion
// re-entering through a union (a discriminated union, not only a named
// interface) must compile to a helper instead of recursing the walker
// itself forever (these hung with "Maximum call stack size exceeded" before
// the fix -- a test that merely returns, rather than timing out, is itself
// part of what's being asserted).
//
// The root declaration walked here *is* the recursive union, so the walk
// discovers its own recursion while still walking its top-level body and
// the root result comes back as `recursiveRef` (unlike a root recursive
// `object`, which keeps its own `kind: "object"` shape with `helperName`
// attached -- see the doc comment on `walkUnion` in walk.ts for why the two
// kinds carry the helper marker differently). Either way, no
// diagnostic is reported and the walk terminates.
describe("TypeWalker recursion through unions", () => {
	test("a recursive discriminated union with inline variants resolves to a helper reference, not a stack overflow", () => {
		const { field, diagnostics } = walkDeclaration(
			`type Expr = { kind: "num"; v: number } | { kind: "add"; l: Expr; r: Expr };`,
			"Expr",
		);
		expect(diagnostics).toEqual([]);
		expect(field.kind).toBe("recursiveRef");
	});

	test("a recursive discriminated union with named interface variants resolves to a helper reference", () => {
		const { field, diagnostics } = walkDeclaration(
			`interface Num { kind: "num"; v: number; }
			interface Add { kind: "add"; l: Expr; r: Expr; }
			type Expr = Num | Add;`,
			"Expr",
		);
		expect(diagnostics).toEqual([]);
		expect(field.kind).toBe("recursiveRef");
	});

	test("a recursive discriminated union reached through an array element resolves to a helper reference", () => {
		const { field, diagnostics } = walkDeclaration(
			`interface Leaf { kind: "leaf"; v: number; }
			interface Branch { kind: "branch"; kids: Tree[]; }
			type Tree = Leaf | Branch;`,
			"Tree",
		);
		expect(diagnostics).toEqual([]);
		expect(field.kind).toBe("recursiveRef");
	});

	// `walker.walk()` always returns `recursiveRef` for whichever call site
	// discovers a recursive union first (see the two tests above) -- the real
	// structure is only reachable through `getHelperFields()`, the same way
	// `emit.ts`'s `ensureHelper` reaches it when building the helper's body.
	test("a recursive union's resolved helper field is the real tagged union, with its own recursion as a nested helper reference", () => {
		const { type, node, walker, cleanup } = loadDeclaration(
			`type Expr = { kind: "num"; v: number } | { kind: "add"; l: Expr; r: Expr };`,
			"Expr",
		);
		try {
			const field = walker.walk(type, node, false);
			expect(field.kind).toBe("recursiveRef");
			if (field.kind !== "recursiveRef") throw new Error("unreachable");
			const resolved = walker.getHelperFields().get(field.helperName);
			expect(resolved?.kind).toBe("taggedUnion");
			if (resolved?.kind !== "taggedUnion") throw new Error("unreachable");
			const addVariant = resolved.variants.find((v) => v.tagValue === "add");
			const nested = addVariant?.fields.find((entry) => entry.name === "l")?.field;
			expect(nested).toEqual({ kind: "recursiveRef", helperName: field.helperName });
		} finally {
			cleanup();
		}
	});
});

// Regression tests for docs/future-work/wire-format-determinism.md: the
// checker assigns literal types and enumerates union constituents in
// type-id/creation order, which depends on what else was declared earlier
// in the program -- these fixtures reproduce that by declaring the exact
// literal values used elsewhere in the same source, before the tested type.
describe("TypeWalker wire-format determinism", () => {
	test("literal union value order is sorted canonically, independent of unrelated earlier declarations", () => {
		const withoutNoise = walkDeclaration(`type T = "north" | "south" | "east";`, "T").field;
		const withNoise = walkDeclaration(
			`const s: "south" = "south"; const e: "east" = "east"; type T = "north" | "south" | "east";`,
			"T",
		).field;
		expect(withoutNoise).toEqual(withNoise);
		expect(withoutNoise).toEqual({ kind: "literal", values: ["east", "north", "south"] });
	});

	test("numeric literal union value order is sorted canonically, independent of unrelated earlier declarations", () => {
		const withoutNoise = walkDeclaration(`type T = 3 | 1 | 2;`, "T").field;
		const withNoise = walkDeclaration(`const x: 2 = 2; type T = 3 | 1 | 2;`, "T").field;
		expect(withoutNoise).toEqual(withNoise);
		expect(withoutNoise).toEqual({ kind: "literal", values: [1, 2, 3] });
	});

	test("guardedUnion variant order is sorted canonically, independent of unrelated earlier declarations", () => {
		const withoutNoise = walkDeclaration(`type T = 1 | 2 | string;`, "T").field;
		const withNoise = walkDeclaration(`const x: 2 = 2; type T = 1 | 2 | string;`, "T").field;
		expect(withoutNoise).toEqual(withNoise);
		expect(withoutNoise).toEqual({
			kind: "guardedUnion",
			variants: [{ kind: "literalConst", value: 1 }, { kind: "literalConst", value: 2 }, { kind: "str" }],
		});
	});

	test("discriminant choice is name-sorted, not variant-0 declaration order, when two properties both qualify", () => {
		const declaredKindFirst = walkDeclaration(
			`type T = { kind: "a"; sub: "x" } | { kind: "b"; sub: "y" };`,
			"T",
		).field;
		const declaredSubFirst = walkDeclaration(
			`type T = { sub: "x"; kind: "a" } | { sub: "y"; kind: "b" };`,
			"T",
		).field;
		expect(declaredKindFirst).toEqual(declaredSubFirst);
		if (declaredKindFirst.kind !== "taggedUnion") throw new Error("unreachable");
		expect(declaredKindFirst.tagKey).toBe("kind");
	});
});

// Regression test for docs/future-work/enum-encoding.md: a bare `EnumItem`
// field (not a specific `Enum.*` type) has no member list to index into and
// must be rejected, not silently classified into an unusable read.
describe("TypeWalker bare EnumItem", () => {
	test("a bare EnumItem field is rejected with a diagnostic instead of classified as an enum", () => {
		const { field, diagnostics } = walkDeclaration("interface T { any: EnumItem; }", "T", { roblox: true });
		expect(field.kind).toBe("object");
		if (field.kind !== "object") throw new Error("unreachable");
		expect(field.fields.find((entry) => entry.name === "any")?.field).toEqual({ kind: "blob" });
		expect(diagnostics.length).toBeGreaterThan(0);
	});
});
