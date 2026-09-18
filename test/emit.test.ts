import * as ts from "typescript";

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
