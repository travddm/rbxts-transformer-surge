import * as ts from "typescript";

import { FIXED_DATATYPES } from "../src/datatypes";
import { Emitter } from "../src/emit";
import type { Field } from "../src/field";
import { printNodes } from "./harness";

/** Runs `field` through `Emitter.writeField`/`readField` and prints the resulting statements, for snapshotting. */
function emitSnapshot(field: Field, helperFields: ReadonlyMap<string, Field> = new Map(), checks = false): string {
	const emitter = new Emitter(ts, ts.factory, helperFields, checks);
	const writeOut: ts.Statement[] = [];
	emitter.writeField(field, ts.factory.createIdentifier("value"), writeOut);

	const readOut: ts.Statement[] = [];
	const resultExpr = emitter.readField(field, readOut);
	readOut.push(ts.factory.createReturnStatement(resultExpr));

	const helperDecls = emitter.getHelperDecls();
	const sections = [
		`// write\n${printNodes(writeOut)}`,
		`// read\n${printNodes(readOut)}`,
		...(helperDecls.length > 0 ? [`// helpers\n${printNodes(helperDecls)}`] : []),
	];
	return sections.join("\n\n");
}

describe("Emitter per-kind write/read snapshots", () => {
	test("num", () => {
		expect(emitSnapshot({ kind: "num", width: "f32" })).toMatchSnapshot();
	});

	test("bool", () => {
		expect(emitSnapshot({ kind: "bool", packed: false })).toMatchSnapshot();
	});

	test("str", () => {
		expect(emitSnapshot({ kind: "str" })).toMatchSnapshot();
	});

	test("vector2", () => {
		expect(emitSnapshot({ kind: "vector2" })).toMatchSnapshot();
	});

	test.each(Object.keys(FIXED_DATATYPES))("datatype %s", (name) => {
		expect(emitSnapshot({ kind: "datatype", name })).toMatchSnapshot();
	});

	test.each(["u24", "i24"] as const)("num %s", (width) => {
		expect(emitSnapshot({ kind: "num", width })).toMatchSnapshot();
	});

	test("cframe inside Packed", () => {
		expect(emitSnapshot({ kind: "cframe", packed: true })).toMatchSnapshot();
	});

	test("buffer", () => {
		expect(emitSnapshot({ kind: "buffer" })).toMatchSnapshot();
	});

	test("vector3", () => {
		expect(emitSnapshot({ kind: "vector3" })).toMatchSnapshot();
	});

	test("cframe", () => {
		expect(emitSnapshot({ kind: "cframe" })).toMatchSnapshot();
	});

	test("color3", () => {
		expect(emitSnapshot({ kind: "color3" })).toMatchSnapshot();
	});

	test("colorSequence", () => {
		expect(emitSnapshot({ kind: "colorSequence" })).toMatchSnapshot();
	});

	test("numberSequence", () => {
		expect(emitSnapshot({ kind: "numberSequence" })).toMatchSnapshot();
	});

	test("enum", () => {
		expect(
			emitSnapshot({ kind: "enum", enumName: "SortOrder", members: ["Custom", "LayoutOrder", "Name"] }),
		).toMatchSnapshot();
	});

	test("object", () => {
		expect(
			emitSnapshot({
				kind: "object",
				fields: [
					{ name: "a", field: { kind: "num", width: "f64" } },
					{ name: "b", field: { kind: "str" } },
				],
			}),
		).toMatchSnapshot();
	});

	test("array", () => {
		expect(emitSnapshot({ kind: "array", element: { kind: "num", width: "f64" } })).toMatchSnapshot();
	});

	test("tuple with a rest element", () => {
		expect(
			emitSnapshot({
				kind: "tuple",
				fixed: [{ kind: "str" }],
				rest: { kind: "num", width: "f64" },
			}),
		).toMatchSnapshot();
	});

	test("dict (map)", () => {
		expect(
			emitSnapshot({
				kind: "dict",
				key: { kind: "str" },
				value: { kind: "num", width: "f64" },
				source: "map",
			}),
		).toMatchSnapshot();
	});

	test("dict (set, no value)", () => {
		expect(emitSnapshot({ kind: "dict", key: { kind: "str" }, value: undefined, source: "set" })).toMatchSnapshot();
	});

	test("optional", () => {
		expect(
			emitSnapshot({ kind: "optional", inner: { kind: "num", width: "f64" }, packed: false }),
		).toMatchSnapshot();
	});

	test("literalConst", () => {
		expect(emitSnapshot({ kind: "literalConst", value: "fixed" })).toMatchSnapshot();
	});

	test("literal", () => {
		expect(emitSnapshot({ kind: "literal", values: ["a", "b", "c"] })).toMatchSnapshot();
	});

	test("taggedUnion", () => {
		expect(
			emitSnapshot({
				kind: "taggedUnion",
				tagKey: "kind",
				variants: [
					{ tagValue: "a", fields: [{ name: "x", field: { kind: "num", width: "f64" } }] },
					{ tagValue: "b", fields: [{ name: "y", field: { kind: "str" } }] },
				],
			}),
		).toMatchSnapshot();
	});

	test("guardedUnion", () => {
		expect(
			emitSnapshot({
				kind: "guardedUnion",
				variants: [{ kind: "num", width: "f64" }, { kind: "str" }],
			}),
		).toMatchSnapshot();
	});

	test("blob", () => {
		expect(emitSnapshot({ kind: "blob" })).toMatchSnapshot();
	});

	test("recursiveRef", () => {
		const helperFields = new Map<string, Field>([
			[
				"surge_Node_1",
				{
					kind: "object",
					fields: [
						{ name: "value", field: { kind: "num", width: "f64" } },
						{ name: "next", field: { kind: "recursiveRef", helperName: "surge_Node_1" } },
					],
				},
			],
		]);
		expect(emitSnapshot({ kind: "recursiveRef", helperName: "surge_Node_1" }, helperFields)).toMatchSnapshot();
	});
});

// Regression tests for the read-order-side-effects finding in
// docs/research/september-2026-review.md in the surge repo:
// `readObjectInline` pushes each field's read *statements* in field order but
// evaluates each field's returned *expression* later, inside the object
// literal -- sound only if every returned expression is side-effect free. A
// helper call and a blob read are not, so a sibling field whose own read
// needs a statement (anything but those two, plus a handful of expression-
// only kinds) must not have its statement land ahead of an earlier-declared
// side-effecting field's binding.
describe("Emitter read-order for side-effecting fields", () => {
	test("a helper-object field followed by a plain field binds the helper call before the next statement", () => {
		const helperFields = new Map<string, Field>([
			[
				"surge_Tree_1",
				{
					kind: "object",
					fields: [{ name: "kids", field: { kind: "array", element: { kind: "num", width: "f64" } } }],
				},
			],
		]);
		const field: Field = {
			kind: "object",
			fields: [
				{
					name: "inner",
					field: {
						kind: "object",
						fields: [{ name: "kids", field: { kind: "array", element: { kind: "num", width: "f64" } } }],
						helperName: "surge_Tree_1",
					},
				},
				{ name: "zebra", field: { kind: "num", width: "f64" } },
			],
		};
		const output = emitSnapshot(field, helperFields);
		const readSection = output.slice(output.indexOf("// read"));
		const helperCallIndex = readSection.indexOf("surge_Tree_1_read()");
		const zebraAllocIndex = readSection.indexOf("__surge_readCursor = pos");
		expect(helperCallIndex).toBeGreaterThan(-1);
		expect(zebraAllocIndex).toBeGreaterThan(-1);
		expect(helperCallIndex).toBeLessThan(zebraAllocIndex);
		expect(output).toMatchSnapshot();
	});

	test("a blob field followed by a plain field binds the blob read before the next statement", () => {
		const field: Field = {
			kind: "object",
			fields: [
				{ name: "a", field: { kind: "blob" } },
				{ name: "b", field: { kind: "num", width: "f64" } },
			],
		};
		const output = emitSnapshot(field);
		const readSection = output.slice(output.indexOf("// read"));
		const blobIndex = readSection.indexOf("nextBlob()");
		const bAllocIndex = readSection.indexOf("__surge_readCursor = pos");
		expect(blobIndex).toBeGreaterThan(-1);
		expect(bAllocIndex).toBeGreaterThan(-1);
		expect(blobIndex).toBeLessThan(bAllocIndex);
		expect(output).toMatchSnapshot();
	});
});

// Regression test for the wire-format-determinism finding in
// docs/research/september-2026-review.md in the surge repo: packed
// booleans must write a whole computed byte (zeroing any unused high bits by
// construction) instead of one `packBit` call per bit into scratch memory
// that may still hold a previous payload's bits.
describe("Emitter packed region", () => {
	// The region is first on both sides: the read side needs a presence bit
	// before it reaches the optional's value.
	test("a packed optional is a presence bit at the head of its object, with no flag byte", () => {
		const output = emitSnapshot({
			kind: "object",
			fields: [
				{ name: "count", field: { kind: "optional", inner: { kind: "num", width: "u8" }, packed: true } },
				{ name: "flag", field: { kind: "bool", packed: true } },
				{ name: "label", field: { kind: "str" } },
				{ name: "maybeFlag", field: { kind: "optional", inner: { kind: "bool", packed: true }, packed: true } },
			],
		});
		// Bits in name order: count present, flag, maybeFlag present, maybeFlag value.
		expect(output).toContain(
			"(value.count !== undefined ? 1 : 0) + (value.flag ? 2 : 0) + (value.maybeFlag !== undefined ? 4 : 0) + (value.maybeFlag === true ? 8 : 0)",
		);
		const [write, read] = output.split("// read");
		expect(write.indexOf("__surge_cursor = pos")).toBeLessThan(write.indexOf("value.label"));
		expect(read.indexOf("__surge_readCursor = pos")).toBeLessThan(read.indexOf("readstring"));
		// One byte for the region and one for `count`, then the string's length
		// prefix. No flag byte, and nothing of its own for `maybeFlag`.
		expect(reservations(write, "write")).toEqual([1, 1, 4]);
		expect(reservations(read, "read")).toEqual([1, 1, 4]);
		expect(output).toMatchSnapshot();
	});
});

describe("Emitter packed tag bit", () => {
	const union = (variantCount: number): Field => ({
		kind: "taggedUnion",
		tagKey: "kind",
		packed: true,
		variants: ["a", "b", "c"].slice(0, variantCount).map((tagValue) => ({
			tagValue,
			fields: [{ name: "n", field: { kind: "num", width: "u8" } }],
		})),
	});

	test("a packed two-variant tagged union property is one tag bit, with no index byte", () => {
		const output = emitSnapshot({ kind: "object", fields: [{ name: "shape", field: union(2) }] });
		expect(output).toContain('value.shape.kind === "b" ? 1 : 0');
		expect(output).toContain("__surge_unpackBit(");
		expect(output).not.toContain("readu8(buf3"); // no index byte is read before the variant
		expect(output).toMatchSnapshot();
	});

	test("a packed tagged union with three variants keeps its index byte", () => {
		const output = emitSnapshot({ kind: "object", fields: [{ name: "shape", field: union(3) }] });
		expect(output).not.toContain("__surge_unpackBit(");
	});

	test("a packed two-variant tagged union that is not an object property keeps its index byte", () => {
		expect(emitSnapshot(union(2))).not.toContain("__surge_unpackBit(");
	});
});

describe("Emitter packed boolean padding", () => {
	test("packed booleans write one computed byte per group instead of per-bit packBit calls", () => {
		const field: Field = {
			kind: "object",
			fields: [
				{ name: "a", field: { kind: "bool", packed: true } },
				{ name: "b", field: { kind: "bool", packed: true } },
				{ name: "c", field: { kind: "bool", packed: true } },
			],
		};
		const output = emitSnapshot(field);
		const writeSection = output.slice(0, output.indexOf("// read"));
		expect(writeSection).not.toContain("packBit");
		expect(writeSection).toContain("writeu8");
		expect(output).toMatchSnapshot();
	});
});

// Regression tests for the enum-encoding finding in
// docs/research/september-2026-review.md in the surge repo: an enum index
// wider than one byte, and an O(1) lookup table instead of a linear ternary
// chain of string/index comparisons.
describe("Emitter enum index width and lookup table", () => {
	test("an enum with more than 256 members uses a 2-byte index", () => {
		const members = Array.from({ length: 300 }, (_, i) => `M${i}`);
		const output = emitSnapshot({ kind: "enum", enumName: "Big", members });
		expect(output).toContain("writeu16");
		expect(output).toContain("readu16");
		expect(output).not.toContain("writeu8");
	});

	test("an enum index is an O(1) table lookup, not a chain of Name comparisons", () => {
		const output = emitSnapshot({
			kind: "enum",
			enumName: "SortOrder",
			members: ["Custom", "LayoutOrder", "Name"],
		});
		expect(output).not.toMatch(/\.Name ===/);
		expect(output).toMatch(/_index\.get\(value\.Name\)/);
		expect(output).toMatch(/_items\[idx\d+\]/);
	});
});

describe("Emitter property names that are not identifiers", () => {
	test("a non-identifier name uses element access and a quoted key; a numeric key stays a number", () => {
		const output = emitSnapshot({
			kind: "object",
			fields: [
				{ name: "0", numericKey: true, field: { kind: "num", width: "u8" } },
				{ name: "1", field: { kind: "num", width: "u8" } },
				{ name: "my-key", field: { kind: "num", width: "u8" } },
				{ name: "plain", field: { kind: "num", width: "u8" } },
			],
		});
		expect(output).toContain("value[0])");
		expect(output).toContain('value["1"])');
		expect(output).toContain('value["my-key"])');
		expect(output).toContain("value.plain)");
		expect(output).toMatch(/\b0: buffer\.readu8/);
		expect(output).toMatch(/"1": buffer\.readu8/);
		expect(output).toMatch(/"my-key": buffer\.readu8/);
		expect(output).toMatch(/plain: buffer\.readu8/);
	});

	test("a non-identifier tag key and variant field name are quoted in a tagged union", () => {
		const output = emitSnapshot({
			kind: "taggedUnion",
			tagKey: "the-kind",
			variants: [
				{ tagValue: "a", fields: [{ name: "a-value", field: { kind: "str" } }] },
				{ tagValue: "b", fields: [] },
			],
		});
		expect(output).toContain('value["the-kind"] === "a"');
		expect(output).toContain('"the-kind": "a"');
		expect(output).toContain('"a-value": string');
		expect(output).not.toContain("value.the-kind");
	});
});

describe("Emitter union guards", () => {
	test("Roblox datatype, enum, and recursive-object variants are guarded by their runtime type", () => {
		const node: Field = { kind: "object", fields: [{ name: "x", field: { kind: "num", width: "u8" } }] };
		const output = emitSnapshot(
			{
				kind: "guardedUnion",
				variants: [
					{ kind: "cframe" },
					{ kind: "color3" },
					{ kind: "colorSequence" },
					{ kind: "enum", enumName: "SortOrder", members: ["Name"] },
					{ kind: "numberSequence" },
					{ kind: "recursiveRef", helperName: "surge_Node_1" },
					{ kind: "vector2" },
					{ kind: "vector3" },
					{ kind: "str" },
				],
			},
			new Map([["surge_Node_1", node]]),
		);
		for (const tag of [
			"CFrame",
			"Color3",
			"ColorSequence",
			"EnumItem",
			"NumberSequence",
			"table",
			"Vector2",
			"Vector3",
		]) {
			expect(output).toContain(`typeIs(value, "${tag}")`);
		}
	});
});

// One reservation per run of consecutive fixed-size fields, rather than one
// per field (what it was measured as worth is in
// docs/research/generated-code-against-hand-written.md in the surge repo).
/**
 * The constant sizes a body reserves, in order. A reservation is inline now
 * -- `cursor = posN + <size>;` -- so this is what stands in for counting
 * `alloc` calls. A variable-size reservation adds an identifier rather than a
 * literal and is deliberately not matched.
 */
function reservations(source: string, side: "write" | "read"): Array<number> {
	const cursor = side === "write" ? "__surge_cursor" : "__surge_readCursor";
	const pattern = new RegExp(`${cursor} = pos[0-9]+ [+] ([0-9]+);`, "g");
	return [...source.matchAll(pattern)].map((match) => Number(match[1]));
}

describe("Emitter shared reservations", () => {
	test("consecutive fixed-size fields share one alloc, at their own offsets", () => {
		const output = emitSnapshot({
			kind: "object",
			fields: [
				{ name: "flag", field: { kind: "bool", packed: false } },
				{ name: "id", field: { kind: "num", width: "u32" } },
				{ name: "at", field: { kind: "vector3" } },
			],
		});
		expect(output).toMatchSnapshot();
		// 1 + 4 + 12, reserved once on each side and nowhere else.
		expect(reservations(output, "write")).toEqual([17]);
		expect(reservations(output, "read")).toEqual([17]);
	});

	test("a variable-size field ends the run, and the fields after it start another", () => {
		const output = emitSnapshot({
			kind: "object",
			fields: [
				{ name: "a", field: { kind: "num", width: "u8" } },
				{ name: "b", field: { kind: "num", width: "u8" } },
				{ name: "name", field: { kind: "str" } },
				{ name: "y", field: { kind: "num", width: "f32" } },
				{ name: "z", field: { kind: "num", width: "f32" } },
			],
		});
		// Reservation order is byte order, so the two fields after the string
		// cannot join the two before it. The 4 between them is its length prefix;
		// its own bytes are the variable reservation this does not count.
		expect(reservations(output, "write")).toEqual([2, 4, 8]);
		expect(reservations(output, "read")).toEqual([2, 4, 8]);
	});

	test("a field whose bytes the packed region holds does not join a run", () => {
		const output = emitSnapshot({
			kind: "object",
			fields: [
				{ name: "on", field: { kind: "bool", packed: true } },
				{ name: "id", field: { kind: "num", width: "u32" } },
				{ name: "n", field: { kind: "num", width: "u8" } },
			],
		});
		// One byte for the packed region, then 4 + 1 shared by the two that
		// write their own bytes.
		expect(reservations(output, "write")).toEqual([1, 5]);
		expect(reservations(output, "read")).toEqual([1, 5]);
	});
});

// Luau allows 200 registers per function; 100 `const [buf, pos]` pairs in one
// scope exceed it (see Transformer 5.8 in docs/specs/transformer.md in the surge repo).
describe("Emitter local-register ceiling", () => {
	const manyFields = (count: number): Field => ({
		kind: "object",
		fields: Array.from({ length: count }, (_, i) => ({
			name: `f${i}`,
			field: { kind: "num", width: "f64" } as Field,
		})),
	});

	/** The largest number of `const` declarations that are live at once in one block scope of `printed`. */
	function maxLocalsInOneScope(printed: string): number {
		let max = 0;
		const stack = [0];
		for (const line of printed.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "{") {
				stack.push(0);
			} else if (trimmed === "}") {
				stack.pop();
			} else if (trimmed.startsWith("const [")) {
				stack[stack.length - 1] += 2;
			} else if (trimmed.startsWith("const ")) {
				stack[stack.length - 1] += 1;
			}
			max = Math.max(
				max,
				stack.reduce((a, b) => a + b, 0),
			);
		}
		return max;
	}

	test("a small object is emitted flat, with no blocks and an object literal on the read side", () => {
		const output = emitSnapshot(manyFields(20));
		expect(output).not.toMatch(/^\{$/m);
		expect(output).not.toContain("result");
	});

	test("a 150-field object is split into blocks that keep each scope far below the limit", () => {
		const output = emitSnapshot(manyFields(150));
		expect(output).toMatch(/^\{$/m);
		expect(maxLocalsInOneScope(output)).toBeLessThanOrEqual(40);
		// Every field is still written and read exactly once.
		expect(output.match(/buffer\.writef64/g)).toHaveLength(150);
		expect(output.match(/buffer\.readf64/g)).toHaveLength(150);
		expect(output).toMatch(/result\d+\.f149 = buffer\.readf64\(/);
	});

	test("a 150-element tuple is split into blocks the same way", () => {
		const output = emitSnapshot({
			kind: "tuple",
			fixed: Array.from({ length: 150 }, () => ({ kind: "num", width: "f64" }) as Field),
			rest: undefined,
		});
		expect(maxLocalsInOneScope(output)).toBeLessThanOrEqual(40);
		expect(output.match(/buffer\.writef64/g)).toHaveLength(150);
	});
});

describe("Emitter count widths", () => {
	/** Every kind that writes a count, as `[label, field]` with `length` left to the caller. */
	const counted: Array<[string, (length?: "u8" | "u16" | "u24" | "u32") => Field]> = [
		["str", (length) => ({ kind: "str", length })],
		["buffer", (length) => ({ kind: "buffer", length })],
		["array", (length) => ({ kind: "array", element: { kind: "num", width: "u8" }, length })],
		// A fixed-width key, so the dict's own count is the only count in the shape.
		[
			"dict",
			(length) => ({ kind: "dict", key: { kind: "num", width: "u8" }, value: undefined, source: "set", length }),
		],
		["tuple rest", (length) => ({ kind: "tuple", fixed: [], rest: { kind: "num", width: "u8" }, length })],
	];

	test.each(counted)("a %s writes and reads its count at the branded width", (_label, build) => {
		const output = emitSnapshot(build("u16"));
		expect(output).toContain("buffer.writeu16");
		expect(output).toContain("buffer.readu16");
		// The count is the only u16 in these shapes; nothing else moved to it.
		expect(output).not.toContain("buffer.writeu32");
		expect(output).not.toContain("buffer.readu32");
	});

	// Rule 4 of data-type-surface.md, on the bytes rather than on the IR: the
	// walker records the default as absence, and the emitter has to turn that
	// absence back into exactly the u32 every one of these wrote before.
	test.each(counted)("a %s with no branded width emits what it always did", (_label, build) => {
		expect(emitSnapshot(build())).toBe(emitSnapshot(build("u32")));
	});

	// Luau's `buffer` has no 24-bit call, so a u24 count is the same two
	// writes the `num` kind uses, and the reservation is 3 bytes and not 4.
	test("a u24 count reserves three bytes and splits into a u16 and a u8", () => {
		const output = emitSnapshot({ kind: "array", element: { kind: "num", width: "u8" }, length: "u24" });
		// The count is reserved first; the 1 after it is the element, inside the loop.
		expect(reservations(output, "write")[0]).toBe(3);
		expect(reservations(output, "read")[0]).toBe(3);
		expect(output).toContain("buffer.writeu16");
		expect(output).toContain("buffer.writeu8");
	});

	// The exact form's whole point: the count is in the type, so no bytes of
	// the payload go to saying how many there are.
	// `f32` elements, so that any unsigned read or write left in the output is
	// a count and not an element.
	test.each([
		["str", { kind: "str", length: 8 } as Field, 8],
		["buffer", { kind: "buffer", length: 16 } as Field, 16],
		["array", { kind: "array", element: { kind: "num", width: "f32" }, length: 3 } as Field, 4],
		["tuple rest", { kind: "tuple", fixed: [], rest: { kind: "num", width: "f32" }, length: 2 } as Field, 4],
	])("an exact %s writes no count at all", (_label, field, firstReservation) => {
		const output = emitSnapshot(field);
		for (const width of ["u8", "u16", "u24", "u32"]) {
			expect(output).not.toContain(`buffer.write${width}(`);
			expect(output).not.toContain(`buffer.read${width}(`);
		}
		expect(reservations(output, "write")[0]).toBe(firstReservation);
		expect(reservations(output, "read")[0]).toBe(firstReservation);
	});

	test("an exact string passes its byte count to writestring and readstring", () => {
		const output = emitSnapshot({ kind: "str", length: 8 });
		expect(output).toContain("buffer.writestring");
		expect(output).toContain("buffer.readstring");
		// The count reaches both calls, which is what truncates a longer value
		// and raises on a shorter one.
		expect(output.match(/, 8\)/g)?.length).toBeGreaterThanOrEqual(2);
	});

	test("an exact array loops a literal number of times on both sides", () => {
		const output = emitSnapshot({ kind: "array", element: { kind: "num", width: "u8" }, length: 3 });
		// Indexed on the write side so exactly three are written; `$range` on
		// the read side, whose bound is the same literal.
		expect(output).toMatch(/i[0-9]+ < 3;/);
		expect(output).toContain("$range(1, 3)");
	});

	test("a u8 count reserves one byte", () => {
		// A string's payload is reserved at a run-time length, so the count is
		// the only constant reservation in this shape.
		const output = emitSnapshot({ kind: "str", length: "u8" });
		expect(reservations(output, "write")).toEqual([1]);
		expect(reservations(output, "read")).toEqual([1]);
	});
});

describe("Emitter component widths", () => {
	test("a Vector3 writes each component at its own width, at cumulative offsets", () => {
		const output = emitSnapshot({ kind: "vector3", components: ["u8", "u24", "f32"] });
		expect(output).toMatchSnapshot();
		// 1 + 3 + 4, and the u24 is the two writes Luau's buffer has no call for.
		expect(reservations(output, "write")).toEqual([8]);
		expect(reservations(output, "read")).toEqual([8]);
	});

	// Rule 4 of data-type-surface.md on the emitter's side of the IR: the
	// walker records the all-default case as absence, and the two must agree.
	test("the default widths emit exactly what absent widths do", () => {
		expect(emitSnapshot({ kind: "vector3", components: ["f32", "f32", "f32"] })).toBe(
			emitSnapshot({ kind: "vector3" }),
		);
		expect(emitSnapshot({ kind: "cframe", position: ["f32", "f32", "f32"] })).toBe(
			emitSnapshot({ kind: "cframe" }),
		);
	});

	test("a CFrame narrows its position and leaves its rotation an f32 triple", () => {
		const output = emitSnapshot({ kind: "cframe", position: ["i16", "i16", "i16"] });
		expect(output).toMatchSnapshot();
		// 6 for the position, then the rotation's 12 at an offset that moved with it.
		expect(reservations(output, "write")).toEqual([18]);
		expect(reservations(output, "read")).toEqual([18]);
		expect(output).toContain("buffer.writei16(");
		expect(output.match(/buffer\.writef32\(/g)).toHaveLength(3);
	});

	test("a narrowed Vector3 joins the reservation of the fields beside it", () => {
		const output = emitSnapshot({
			kind: "object",
			fields: [
				{ name: "at", field: { kind: "vector3", components: ["u8", "u8", "u8"] } },
				{ name: "id", field: { kind: "num", width: "u8" } },
			],
		});
		// 3 + 1 in one alloc, where three unnarrowed components alone would be 12.
		expect(reservations(output, "write")).toEqual([4]);
		expect(reservations(output, "read")).toEqual([4]);
	});
});

describe("Emitter read-side checks", () => {
	/** The read half of `field` emitted with `checks: true`. */
	function checkedRead(field: Field): string {
		const output = emitSnapshot(field, new Map(), true);
		return output.slice(output.indexOf("// read"));
	}

	test("every read is bounded against the input length", () => {
		const output = checkedRead({ kind: "num", width: "u32" });
		expect(output).toMatchSnapshot();
		expect(output).toContain("@rbxts/surge: ");
	});

	// The default is what the read path has always been: no branch per read.
	test("checks off emits no branch and no message", () => {
		for (const field of [
			{ kind: "num", width: "u32" } as Field,
			{ kind: "array", element: { kind: "num", width: "u8" } } as Field,
			{ kind: "str" } as Field,
		]) {
			expect(emitSnapshot(field)).not.toContain("@rbxts/surge: ");
		}
	});

	test("a count is bounded by what the rest of the input could hold", () => {
		const output = checkedRead({ kind: "array", element: { kind: "num", width: "f64" } });
		expect(output).toMatchSnapshot();
		// Eight bytes an element, against the bytes left.
		expect(output).toMatch(/count[0-9]+ \* 8 > __surge_inputLength - __surge_readCursor/);
	});

	// The payload cannot bound a count of elements that read no bytes, which is
	// the denial of service the cap is for.
	test.each([
		["a literal constant", { kind: "literalConst", value: 7 } as Field],
		["a blob", { kind: "blob" } as Field],
		[
			"an object of constants",
			{ kind: "object", fields: [{ name: "a", field: { kind: "literalConst", value: "x" } }] } as Field,
		],
	])("an array of %s is capped instead", (_label, element) => {
		const output = checkedRead({ kind: "array", element });
		expect(output).toMatch(/count[0-9]+ > 16777216/);
		expect(output).not.toContain("__surge_inputLength - __surge_readCursor");
	});

	test("a dict's bound counts its key and its value", () => {
		const map = checkedRead({
			kind: "dict",
			key: { kind: "num", width: "u8" },
			value: { kind: "num", width: "u16" },
			source: "map",
		});
		expect(map).toMatch(/count[0-9]+ \* 3 >/);
		// A set writes only its keys, so an entry is the key alone.
		const set = checkedRead({ kind: "dict", key: { kind: "num", width: "u8" }, value: undefined, source: "set" });
		expect(set).toMatch(/count[0-9]+ > __surge_inputLength - __surge_readCursor/);
	});

	// The bound must never exceed what a valid value costs, or it rejects one.
	test("a bound never counts bytes a valid value can leave out", () => {
		const optional = checkedRead({
			kind: "array",
			element: { kind: "optional", inner: { kind: "num", width: "f64" }, packed: false },
		});
		// One presence byte an element, not the f64 behind it.
		expect(optional).toMatch(/count[0-9]+ > __surge_inputLength - __surge_readCursor/);
		const variants = checkedRead({
			kind: "array",
			element: {
				kind: "guardedUnion",
				variants: [
					{ kind: "num", width: "f64" },
					{ kind: "bool", packed: false },
				],
			},
		});
		// The tag, plus the smallest variant rather than the largest.
		expect(variants).toMatch(/count[0-9]+ \* 2 >/);
	});

	test("the input length is read once per deserialize", () => {
		const emitter = new Emitter(ts, ts.factory, new Map(), true);
		emitter.beginFunction();
		emitter.readField({ kind: "num", width: "u8" }, []);
		expect(printNodes(emitter.readStateDecls())).toContain("__surge_inputLength");
		const begin = printNodes(emitter.beginReadStatements(ts.factory.createIdentifier("input")));
		expect(begin).toContain("__surge_inputLength = buffer.len(__surge_input)");
		expect(begin.match(/buffer\.len/g)).toHaveLength(1);
	});
});
