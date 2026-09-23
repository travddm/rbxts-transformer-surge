import { FIXED_DATATYPES } from "../src/datatypes";
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

	test.each(["u24", "i24"])("DataType.%s classifies by its declared width", (width) => {
		const { field } = walkDeclaration(
			`import { DataType } from "@rbxts/surge"; interface T { n: DataType.${width}; }`,
			"T",
			{ surge: true },
		);
		expect(field).toEqual({ kind: "object", fields: [{ name: "n", field: { kind: "num", width } }] });
	});

	test("a CFrame is packed only inside DataType.Packed<T>, at any depth", () => {
		const { field } = walkDeclaration(
			`import { DataType } from "@rbxts/surge";
			interface T { plain: CFrame; packed: DataType.Packed<{ one: CFrame; list: CFrame[] }>; }`,
			"T",
			{ surge: true },
		);
		expect(field).toEqual({
			kind: "object",
			fields: [
				{
					name: "packed",
					field: {
						kind: "object",
						fields: [
							{ name: "list", field: { kind: "array", element: { kind: "cframe", packed: true } } },
							{ name: "one", field: { kind: "cframe", packed: true } },
						],
					},
				},
				{ name: "plain", field: { kind: "cframe" } },
			],
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

	test("Vector2 classifies as the vector2 scalar kind", () => {
		const { field } = walkDeclaration("interface T { v: Vector2; }", "T", { roblox: true });
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "v", field: { kind: "vector2" } }],
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

	// One `enum` field holds the members of one enum: items of two enums used
	// to be merged under the first enum's name.
	test.each([
		["two whole enums", "Enum.SortOrder | Enum.HumanoidRigType"],
		["two items with the same name", "Enum.AutomaticSize.None | Enum.ActuatorType.None"],
	])("a union of items from %s is rejected with a diagnostic", (_name, type) => {
		const { field, diagnostics } = walkDeclaration(`interface T { e: ${type}; }`, "T", { roblox: true });
		expect(field).toEqual({ kind: "object", fields: [{ name: "e", field: { kind: "blob" } }] });
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain("items from two enums");
	});

	test("a user type with the properties of an enum item walks as an object, not as an enum", () => {
		const { field, diagnostics } = walkDeclaration(
			`interface Item { Name: "Sword"; Value: number; EnumType: string; } interface T { item: Item; }`,
			"T",
			{ roblox: true },
		);
		expect(diagnostics).toHaveLength(0);
		expect(field).toMatchObject({ fields: [{ name: "item", field: { kind: "object" } }] });
	});

	// `Instance` is documented as the opaque blob-passthrough channel (Type
	// Coverage in transformer.md); it's detected by `@rbxts/types`' own
	// `_nominal_Instance` brand property, not by walking its (hundreds of)
	// declared properties -- see docs/future-work/blob-classification.md.
	test("Instance falls back to the blob passthrough channel instead of walking its declared properties", () => {
		const { field } = walkDeclaration("interface T { i: Instance; }", "T", { roblox: true });
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "i", field: { kind: "blob" } }],
		});
	});

	test("an Instance subclass also falls back to blob via its inherited _nominal_Instance brand", () => {
		const { field } = walkDeclaration("interface T { p: BasePart; }", "T", { roblox: true });
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "p", field: { kind: "blob" } }],
		});
	});

	test("a union of Instance subclasses collapses to a single blob instead of a guardedUnion", () => {
		const { field, diagnostics } = walkDeclaration("interface T { p: BasePart | Model; }", "T", { roblox: true });
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "p", field: { kind: "blob" } }],
		});
		expect(diagnostics).toEqual([]);
	});

	test("a Roblox datatype without an encoding (Vector2int16) falls back to blob via its _nominal_ brand", () => {
		const { field } = walkDeclaration("interface T { v: Vector2int16; }", "T", { roblox: true });
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "v", field: { kind: "blob" } }],
		});
	});

	test.each(Object.keys(FIXED_DATATYPES))("%s classifies as a datatype, alone and as a union member", (name) => {
		const { field, diagnostics } = walkDeclaration(
			`interface T { alone: ${name}; member: ${name} | string; }`,
			"T",
			{
				roblox: true,
			},
		);
		expect(diagnostics).toHaveLength(0);
		expect(field).toEqual({
			kind: "object",
			fields: [
				{ name: "alone", field: { kind: "datatype", name } },
				{
					name: "member",
					field: { kind: "guardedUnion", variants: [{ kind: "datatype", name }, { kind: "str" }] },
				},
			],
		});
	});

	test("buffer classifies as its own kind, alone and as a union member", () => {
		const { field, diagnostics } = walkDeclaration("interface T { alone: buffer; member: buffer | string; }", "T", {
			roblox: true,
		});
		expect(diagnostics).toHaveLength(0);
		expect(field).toEqual({
			kind: "object",
			fields: [
				{ name: "alone", field: { kind: "buffer" } },
				{ name: "member", field: { kind: "guardedUnion", variants: [{ kind: "buffer" }, { kind: "str" }] } },
			],
		});
	});

	test("two datatypes in one union are told apart by name and sorted by it", () => {
		const { field, diagnostics } = walkDeclaration("type T = Vector3int16 | UDim;", "T", { roblox: true });
		expect(diagnostics).toHaveLength(0);
		expect(field).toEqual({
			kind: "guardedUnion",
			variants: [
				{ kind: "datatype", name: "UDim" },
				{ kind: "datatype", name: "Vector3int16" },
			],
		});
	});

	test("a user type named after a datatype walks as an object", () => {
		const { field } = walkDeclaration(
			"interface Vector3int16 { label: string; } interface T { v: Vector3int16; }",
			"T",
		);
		expect(field).toMatchObject({ fields: [{ name: "v", field: { kind: "object" } }] });
	});

	// `unknown` admits `undefined`, and `u?: unknown` has no `undefined`
	// constituent to find, so a plain `blob` would push nothing for an absent
	// value and shift every later blob.
	test.each(["u: unknown", "u?: unknown", "u: any"])("%s classifies as an optional blob", (property) => {
		const { field } = walkDeclaration(`interface T { ${property}; }`, "T", { roblox: true });
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "u", field: { kind: "optional", inner: { kind: "blob" }, packed: false } }],
		});
	});

	test("defined classifies as a blob with no presence flag", () => {
		const { field } = walkDeclaration("interface T { u: defined; }", "T", { roblox: true });
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "u", field: { kind: "blob" } }],
		});
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
	// `emit/index.ts`'s `ensureHelper` reaches it when building the helper's body.
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

// Regression tests for docs/future-work/blob-classification.md.
describe("TypeWalker blob classification", () => {
	// The scalar-kind table matched by bare symbol name before this fix, so a
	// user's own unrelated same-named type would misclassify as the Roblox
	// scalar. No `{ roblox: true }` here: the point is that this type isn't
	// the real `@rbxts/types` declaration at all.
	test("a user-declared type named after a Roblox scalar kind isn't misclassified by name alone", () => {
		const { field } = walkDeclaration("interface Vector3 { foo: string; } interface T { v: Vector3; }", "T");
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "v", field: { kind: "object", fields: [{ name: "foo", field: { kind: "str" } }] } }],
		});
	});

	test("a function-typed field is rejected with a diagnostic instead of a silent blob", () => {
		const { field, diagnostics } = walkDeclaration("interface T { f: () => void; }", "T");
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "f", field: { kind: "blob" } }],
		});
		expect(diagnostics.length).toBeGreaterThan(0);
	});

	// Regression test for the `in` operator lookup:
	// `symbolName in ROBLOX_SCALAR_KINDS` matches through the prototype chain,
	// so a method named after an `Object.prototype` member used to look up
	// truthy regardless of `ROBLOX_SCALAR_KINDS`'s own keys. Gating that
	// lookup on `@rbxts/types` declaration origin (this doc's own fix) closes
	// it too: the method's declaration is the user's file, so the lookup now
	// falls through to the function-type diagnostic below instead.
	test("a method named after an Object.prototype member doesn't match the scalar-kind table through the prototype chain", () => {
		const { field, diagnostics } = walkDeclaration("interface T { toString(): string; }", "T");
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "toString", field: { kind: "blob" } }],
		});
		expect(diagnostics.length).toBeGreaterThan(0);
	});

	test("a symbol-typed field is rejected with a diagnostic instead of walking Symbol's members", () => {
		const { field, diagnostics } = walkDeclaration("interface T { s: symbol; }", "T");
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "s", field: { kind: "blob" } }],
		});
		expect(diagnostics.length).toBeGreaterThan(0);
	});

	test("a bigint-typed field is rejected with a diagnostic instead of a silent blob", () => {
		const { field, diagnostics } = walkDeclaration("interface T { b: bigint; }", "T");
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "b", field: { kind: "blob" } }],
		});
		expect(diagnostics.length).toBeGreaterThan(0);
	});

	test("a null-typed field is rejected with a diagnostic instead of a silent blob", () => {
		const { field, diagnostics } = walkDeclaration("interface T { n: null; }", "T");
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "n", field: { kind: "blob" } }],
		});
		expect(diagnostics.length).toBeGreaterThan(0);
	});

	test("a template literal type is rejected with a diagnostic instead of walking String's members", () => {
		const { field, diagnostics } = walkDeclaration("interface T { id: `id-${number}`; }", "T");
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "id", field: { kind: "blob" } }],
		});
		expect(diagnostics.length).toBeGreaterThan(0);
	});

	test("a type with both declared properties and an index signature is rejected with a diagnostic", () => {
		const { field, diagnostics } = walkDeclaration("interface T { m: { a: number; [k: string]: number }; }", "T");
		expect(field).toEqual({
			kind: "object",
			fields: [{ name: "m", field: { kind: "blob" } }],
		});
		expect(diagnostics.length).toBeGreaterThan(0);
	});
});

describe("TypeWalker property keys", () => {
	test("a numeric property name is flagged numericKey; a quoted numeric name and an ordinary name are not", () => {
		const { field } = walkDeclaration(`interface T { 0: string; "1": string; "my-key": number; }`, "T");
		expect(field).toEqual({
			kind: "object",
			fields: [
				{ name: "0", numericKey: true, field: { kind: "str" } },
				{ name: "1", field: { kind: "str" } },
				{ name: "my-key", field: { kind: "num", width: "f64" } },
			],
		});
	});
});

describe("TypeWalker tuples", () => {
	test("a leading rest element is rejected with a diagnostic instead of being walked as a trailing rest", () => {
		const { diagnostics } = walkDeclaration("type T = [...number[], string];", "T");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain("rest element that isn't last");
	});

	test("a middle rest element is rejected with a diagnostic", () => {
		const { diagnostics } = walkDeclaration("type T = [boolean, ...number[], string];", "T");
		expect(diagnostics).toHaveLength(1);
	});

	test("a trailing rest element and an optional trailing element are still supported", () => {
		const rest = walkDeclaration("type T = [string, ...number[]];", "T");
		expect(rest.diagnostics).toHaveLength(0);
		expect(rest.field).toEqual({ kind: "tuple", fixed: [{ kind: "str" }], rest: { kind: "num", width: "f64" } });
		expect(walkDeclaration("type T = [number, string?];", "T").diagnostics).toHaveLength(0);
	});
});

describe("TypeWalker union guards", () => {
	test("a Roblox datatype with its own kind is a guardable union member", () => {
		const { field, diagnostics } = walkDeclaration("interface T { v: CFrame | Vector2 | string; }", "T", {
			roblox: true,
		});
		expect(diagnostics).toHaveLength(0);
		expect(field).toEqual({
			kind: "object",
			fields: [
				{
					name: "v",
					field: {
						kind: "guardedUnion",
						variants: [{ kind: "cframe" }, { kind: "str" }, { kind: "vector2" }],
					},
				},
			],
		});
	});

	test("a recursive object type next to a primitive is a guardable union member", () => {
		const { diagnostics } = walkDeclaration("interface Chain { next: Chain | string; }", "Chain");
		expect(diagnostics).toHaveLength(0);
	});

	test("a recursive object type next to another table-shaped variant is rejected", () => {
		const { diagnostics } = walkDeclaration("interface Chain { next: Chain | string[]; }", "Chain");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain("table-shaped");
	});

	test("an opaque variant next to a non-opaque variant is rejected", () => {
		const { diagnostics } = walkDeclaration("interface T { v: Instance | string; }", "T", { roblox: true });
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain("opaque");
	});

	test("two variants with the same runtime type are rejected", () => {
		const { diagnostics } = walkDeclaration(
			`import { DataType } from "@rbxts/surge"; interface T { v: DataType.u8 | DataType.u16 | string; }`,
			"T",
			{ surge: true },
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain('"number" at runtime');
	});
});

describe("TypeWalker diagnostic position", () => {
	test("a diagnostic points at the offending property's declaration, not at the root node", () => {
		const { diagnostics } = walkDeclaration("interface Inner { bad: symbol; } interface T { inner: Inner; }", "T");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].node.getText()).toBe("bad: symbol;");
	});
});

describe("TypeWalker Packed<T>", () => {
	test("a re-aliased Packed<T> packs its booleans and does not serialize the brand property", () => {
		const { field, diagnostics } = walkDeclaration(
			`import { DataType } from "@rbxts/surge";
			interface Flags { a: boolean; }
			type PackedFlags = DataType.Packed<Flags>;
			interface T { flags: PackedFlags; }`,
			"T",
			{ surge: true },
		);
		expect(diagnostics).toHaveLength(0);
		expect(field).toEqual({
			kind: "object",
			fields: [
				{
					name: "flags",
					field: { kind: "object", fields: [{ name: "a", field: { kind: "bool", packed: true } }] },
				},
			],
		});
	});
});

describe("TypeWalker Length<T, L>", () => {
	/** The `length` each named field of `T` carries, `undefined` where it carries none. */
	function lengths(source: string): Map<string, unknown> {
		const { field, diagnostics } = walkDeclaration(source, "T", { surge: true });
		expect(diagnostics).toHaveLength(0);
		if (field.kind !== "object") throw new Error("expected an object");
		return new Map(
			field.fields.map((entry) => [entry.name, (entry.field as { length?: unknown }).length ?? undefined]),
		);
	}

	test("sets the count width on every kind that writes one", () => {
		const byName = lengths(
			`import { DataType } from "@rbxts/surge";
			interface T {
				s: DataType.Length<string, DataType.u8>;
				arr: DataType.Length<Array<number>, DataType.u16>;
				m: DataType.Length<Map<string, number>, DataType.u24>;
				set: DataType.Length<Set<string>, DataType.u8>;
				rec: DataType.Length<Record<string, number>, DataType.u16>;
				buf: DataType.Length<buffer, DataType.u8>;
				tup: DataType.Length<[string, ...number[]], DataType.u16>;
			}`,
		);
		expect([...byName.entries()].sort()).toEqual([
			["arr", "u16"],
			["buf", "u8"],
			["m", "u24"],
			["rec", "u16"],
			["s", "u8"],
			["set", "u8"],
			["tup", "u16"],
		]);
	});

	// Rule 4 of data-type-surface.md: a fully defaulted brand has to encode
	// exactly what the unbranded type encodes, so it must leave no `length`
	// behind for the emitter to act on.
	test("the default argument leaves the field identical to the unbranded one", () => {
		const { field: branded } = walkDeclaration(
			`import { DataType } from "@rbxts/surge"; interface T { arr: DataType.Length<Array<string>>; }`,
			"T",
			{ surge: true },
		);
		const { field: bare } = walkDeclaration("interface T { arr: Array<string>; }", "T", { surge: true });
		expect(branded).toEqual(bare);
	});

	// The brand belongs to the container it wraps, not to the subtree under
	// it -- the one place it differs from `Packed<T>`.
	test("applies to the container it wraps and not to a nested one", () => {
		const { field } = walkDeclaration(
			`import { DataType } from "@rbxts/surge"; interface T { grid: DataType.Length<Array<Array<string>>, DataType.u16>; }`,
			"T",
			{ surge: true },
		);
		if (field.kind !== "object") throw new Error("expected an object");
		expect(field.fields[0].field).toEqual({
			kind: "array",
			length: "u16",
			element: { kind: "array", element: { kind: "str" } },
		});
	});

	test("composes with Packed<T> in either order", () => {
		const expected = {
			kind: "array",
			length: "u16",
			element: { kind: "object", fields: [{ name: "a", field: { kind: "bool", packed: true } }] },
		};
		const lengthOutside = walkDeclaration(
			`import { DataType } from "@rbxts/surge";
			interface Inner { a: boolean; }
			interface T { p: DataType.Length<DataType.Packed<Array<Inner>>, DataType.u16>; }`,
			"T",
			{ surge: true },
		);
		const packedOutside = walkDeclaration(
			`import { DataType } from "@rbxts/surge";
			interface Inner { a: boolean; }
			interface T { p: DataType.Packed<DataType.Length<Array<Inner>, DataType.u16>>; }`,
			"T",
			{ surge: true },
		);
		for (const { field, diagnostics } of [lengthOutside, packedOutside]) {
			expect(diagnostics).toHaveLength(0);
			if (field.kind !== "object") throw new Error("expected an object");
			expect(field.fields[0].field).toEqual(expected);
		}
	});

	test("a width that cannot hold a count is a diagnostic", () => {
		const { diagnostics } = walkDeclaration(
			`import { DataType } from "@rbxts/surge"; interface T { arr: DataType.Length<Array<string>, DataType.i16>; }`,
			"T",
			{ surge: true },
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain('not "DataType.i16"');
	});

	test("a type with no count of its own is a diagnostic", () => {
		const { diagnostics } = walkDeclaration(
			`import { DataType } from "@rbxts/surge"; interface T { n: DataType.Length<number, DataType.u16>; }`,
			"T",
			{ surge: true },
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain("writes no count");
	});

	test("a numeric literal is the exact form, on every kind that can promise one", () => {
		const byName = lengths(
			`import { DataType } from "@rbxts/surge";
			interface T {
				s: DataType.Length<string, 8>;
				arr: DataType.Length<Array<number>, 3>;
				buf: DataType.Length<buffer, 16>;
				tup: DataType.Length<[string, ...number[]], 2>;
			}`,
		);
		expect([...byName.entries()].sort()).toEqual([
			["arr", 3],
			["buf", 16],
			["s", 8],
			["tup", 2],
		]);
	});

	// The write side counts entries as it iterates them, so it cannot promise
	// a fixed number, and a mismatch would misread the rest of the buffer.
	test("the exact form is a diagnostic on a Map, a Set, and a Record", () => {
		for (const container of ["Map<string, number>", "Set<string>", "Record<string, number>"]) {
			const { diagnostics } = walkDeclaration(
				`import { DataType } from "@rbxts/surge"; interface T { c: DataType.Length<${container}, 4>; }`,
				"T",
				{ surge: true },
			);
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].message).toContain("counts entries as it iterates");
		}
	});

	test("a negative or fractional exact count is a diagnostic", () => {
		for (const count of ["-1", "2.5"]) {
			const { diagnostics } = walkDeclaration(
				`import { DataType } from "@rbxts/surge"; interface T { arr: DataType.Length<Array<number>, ${count}>; }`,
				"T",
				{ surge: true },
			);
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].message).toContain("whole number that is not negative");
		}
	});

	// The inner type is walked before the width is checked, so a brand nested
	// on a bad inner type reports once per brand. Both messages name the brand
	// and the node is the same property either way, so the pair still reads.
	test("a nested brand on a type with no count reports once per brand", () => {
		const { diagnostics } = walkDeclaration(
			`import { DataType } from "@rbxts/surge"; interface T { n: DataType.Length<DataType.Length<number, DataType.u16>, DataType.u8>; }`,
			"T",
			{ surge: true },
		);
		expect(diagnostics).toHaveLength(2);
		for (const diagnostic of diagnostics) {
			expect(diagnostic.message).toContain('"DataType.Length"');
			expect(diagnostic.message).toContain("writes no count");
		}
	});

	test("a tuple with no rest element is a diagnostic", () => {
		const { diagnostics } = walkDeclaration(
			`import { DataType } from "@rbxts/surge"; interface T { tup: DataType.Length<[string, number], DataType.u16>; }`,
			"T",
			{ surge: true },
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain("no rest element");
	});
});

describe("TypeWalker Vector<X, Y, Z> and Transform<X, Y, Z>", () => {
	/** The component widths each named field of `T` carries, `undefined` where it carries none. */
	function widths(source: string): Map<string, unknown> {
		const { field, diagnostics } = walkDeclaration(source, "T", { surge: true });
		expect(diagnostics).toHaveLength(0);
		if (field.kind !== "object") throw new Error("expected an object");
		return new Map(
			field.fields.map((entry) => {
				const carried = entry.field as { components?: unknown; position?: unknown };
				return [entry.name, carried.components ?? carried.position];
			}),
		);
	}

	test("sets the three widths on a Vector3 and on a CFrame's position", () => {
		const byName = widths(
			`import { DataType } from "@rbxts/surge";
			interface T {
				v: DataType.Vector<DataType.u8, DataType.i16, DataType.u24>;
				c: DataType.Transform<DataType.i8, DataType.f64, DataType.u32>;
			}`,
		);
		expect(byName.get("v")).toEqual(["u8", "i16", "u24"]);
		expect(byName.get("c")).toEqual(["i8", "f64", "u32"]);
	});

	// `Y extends Width = X, Z extends Width = X`: both default to the first
	// argument, not to the one before them.
	test("a width left off defaults to the first", () => {
		const byName = widths(
			`import { DataType } from "@rbxts/surge";
			interface T {
				one: DataType.Vector<DataType.u8>;
				two: DataType.Vector<DataType.u8, DataType.u16>;
			}`,
		);
		expect(byName.get("one")).toEqual(["u8", "u8", "u8"]);
		expect(byName.get("two")).toEqual(["u8", "u16", "u8"]);
	});

	// Rule 4 of data-type-surface.md, as for `Length<T, L>`: a fully defaulted
	// brand has to leave no widths behind for the emitter to act on.
	test("the default arguments leave the field identical to the unbranded one", () => {
		const { field: branded, diagnostics } = walkDeclaration(
			`import { DataType } from "@rbxts/surge";
			interface T { v: DataType.Vector; c: DataType.Transform<DataType.f32>; }`,
			"T",
			{ surge: true },
		);
		const { field: bare } = walkDeclaration("interface T { v: Vector3; c: CFrame; }", "T", { surge: true });
		expect(diagnostics).toHaveLength(0);
		expect(branded).toEqual(bare);
	});

	// A re-alias carries no brand alias, so `getSurgeBrand` reads the widths
	// back out of the brand property instead.
	test("a re-alias resolves through the brand property", () => {
		const byName = widths(
			`import { DataType } from "@rbxts/surge";
			type Cell = DataType.Vector<DataType.i16>;
			type Placement = DataType.Transform<DataType.i16, DataType.u8, DataType.u8>;
			interface T { v: Cell; c: Placement; }`,
		);
		expect(byName.get("v")).toEqual(["i16", "i16", "i16"]);
		expect(byName.get("c")).toEqual(["i16", "u8", "u8"]);
	});

	// Neither brand can wrap another -- each fixes its own value type -- so
	// `Packed` is the outermost of the pair however the composition is spelled.
	test("composes with Packed<T>, which is always the outer brand", () => {
		const direct = walkDeclaration(
			`import { DataType } from "@rbxts/surge";
			interface T { v: DataType.Packed<DataType.Vector<DataType.u8>>; }`,
			"T",
			{ surge: true },
		);
		const reAliased = walkDeclaration(
			`import { DataType } from "@rbxts/surge";
			type PackedCell = DataType.Packed<DataType.Vector<DataType.u8>>;
			interface T { v: PackedCell; }`,
			"T",
			{ surge: true },
		);
		for (const { field, diagnostics } of [direct, reAliased]) {
			expect(diagnostics).toHaveLength(0);
			if (field.kind !== "object") throw new Error("expected an object");
			expect(field.fields[0].field).toEqual({ kind: "vector3", components: ["u8", "u8", "u8"] });
		}
	});

	test("a Vector inside a Packed subtree keeps its widths", () => {
		const { field, diagnostics } = walkDeclaration(
			`import { DataType } from "@rbxts/surge";
			interface Cell { a: boolean; v: DataType.Vector<DataType.u8>; }
			interface T { cell: DataType.Packed<Cell>; }`,
			"T",
			{ surge: true },
		);
		expect(diagnostics).toHaveLength(0);
		if (field.kind !== "object") throw new Error("expected an object");
		expect(field.fields[0].field).toEqual({
			kind: "object",
			fields: [
				{ name: "a", field: { kind: "bool", packed: true } },
				{ name: "v", field: { kind: "vector3", components: ["u8", "u8", "u8"] } },
			],
		});
	});

	// The packed CFrame writes its position through `writePackedCFrame`, at a
	// layout of its own and only when the header does not already give it.
	test("a Transform inside a Packed subtree is a diagnostic", () => {
		const { field, diagnostics } = walkDeclaration(
			`import { DataType } from "@rbxts/surge";
			interface T { c: DataType.Packed<DataType.Transform<DataType.u8>>; }`,
			"T",
			{ surge: true },
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain('"DataType.Packed"');
		if (field.kind !== "object") throw new Error("expected an object");
		expect(field.fields[0].field).toEqual({ kind: "cframe", packed: true });
	});

	// Defaulted, it sets nothing, so there is nothing to conflict with.
	test("a defaulted Transform inside a Packed subtree is not", () => {
		const { field, diagnostics } = walkDeclaration(
			`import { DataType } from "@rbxts/surge";
			interface T { c: DataType.Packed<DataType.Transform>; }`,
			"T",
			{ surge: true },
		);
		expect(diagnostics).toHaveLength(0);
		if (field.kind !== "object") throw new Error("expected an object");
		expect(field.fields[0].field).toEqual({ kind: "cframe", packed: true });
	});

	test("an argument that is not a width brand is a diagnostic", () => {
		for (const brand of ["Vector", "Transform"]) {
			const { diagnostics } = walkDeclaration(
				`import { DataType } from "@rbxts/surge"; interface T { v: DataType.${brand}<number>; }`,
				"T",
				{ surge: true },
			);
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].message).toContain(`"DataType.${brand}"'s component widths`);
		}
	});
});
