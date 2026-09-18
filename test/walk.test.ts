import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as ts from "typescript";

import type { Field } from "../src/field";
import { TypeWalker, type WalkDiagnostic } from "../src/walk";

/**
 * Compiles `source` in a real, throwaway `ts.Program` (matching this
 * project's established "verify against the real compiler" approach rather
 * than hand-rolling a fake `ts.Type`) and resolves the named top-level
 * `interface`/`type` declaration's `ts.Type` and node, plus a fresh
 * `TypeWalker` bound to the same checker.
 */
function loadDeclaration(
	source: string,
	declarationName: string,
): { type: ts.Type; node: ts.Node; walker: TypeWalker; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surge-walk-test-"));
	const file = path.join(dir, "input.ts");
	fs.writeFileSync(file, source);
	const program = ts.createProgram([file], {
		strict: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ES2019,
	});
	const checker = program.getTypeChecker();
	const sourceFile = program.getSourceFile(file);
	if (!sourceFile) {
		throw new Error("failed to load the generated source file");
	}

	let declarationNode: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | undefined;
	sourceFile.forEachChild((node) => {
		if (
			(ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
			node.name.text === declarationName
		) {
			declarationNode = node;
		}
	});
	if (!declarationNode) {
		throw new Error(`declaration '${declarationName}' not found in test source`);
	}

	const type = checker.getTypeAtLocation(declarationNode.name);
	const walker = new TypeWalker(ts, checker);
	return { type, node: declarationNode, walker, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function walkDeclaration(source: string, declarationName: string): { field: Field; diagnostics: WalkDiagnostic[] } {
	const { type, node, walker, cleanup } = loadDeclaration(source, declarationName);
	try {
		return { field: walker.walk(type, node, false), diagnostics: walker.diagnostics };
	} finally {
		cleanup();
	}
}

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
