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
