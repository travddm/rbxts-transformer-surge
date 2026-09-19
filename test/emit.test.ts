import * as ts from "typescript";

import { FIXED_DATATYPES } from "../src/datatypes";
import { Emitter } from "../src/emit";
import type { Field } from "../src/field";
import { printNodes } from "./harness";

/** Runs `field` through `Emitter.writeField`/`readField` and prints the resulting statements, for snapshotting. */
function emitSnapshot(field: Field, helperFields: ReadonlyMap<string, Field> = new Map()): string {
	const emitter = new Emitter(ts, ts.factory, helperFields);
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

// Regression tests for docs/future-work/read-order-side-effects.md:
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
		const zebraAllocIndex = readSection.indexOf("readAlloc(8)");
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
		const bAllocIndex = readSection.indexOf("readAlloc(8)");
		expect(blobIndex).toBeGreaterThan(-1);
		expect(bAllocIndex).toBeGreaterThan(-1);
		expect(blobIndex).toBeLessThan(bAllocIndex);
		expect(output).toMatchSnapshot();
	});
});

// Regression test for docs/future-work/wire-format-determinism.md: packed
// booleans must write a whole computed byte (zeroing any unused high bits by
// construction) instead of one `packBit` call per bit into scratch memory
// that may still hold a previous payload's bits.
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

// Regression tests for docs/future-work/enum-encoding.md: an enum index
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

// Luau allows 200 registers per function; 100 `const [buf, pos]` pairs in one
// scope exceed it (see generated-code-performance.md in the surge repo).
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
