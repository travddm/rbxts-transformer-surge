import * as ts from "typescript";

import { FIXED_DATATYPES } from "../src/datatypes";
import transform from "../src/index";
import { createFixtureProgram, printNodes } from "./harness";

/** Runs the real transformer over `source` and prints the resulting file, for end-to-end assertions. */
function runTransform(source: string): {
	printed: string;
	diagnostics: readonly ts.DiagnosticWithLocation[];
	cleanup: () => void;
} {
	const { program, sourceFile, cleanup } = createFixtureProgram(source, { surge: true });
	const transformer = transform(program, {}, { ts });
	const result = ts.transform(sourceFile, [transformer], program.getCompilerOptions());
	try {
		const printed = printNodes(result.transformed);
		return { printed, diagnostics: result.diagnostics ?? [], cleanup };
	} finally {
		result.dispose();
	}
}

/**
 * Type-checks the transformed file in a second program, as roblox-ts does
 * before it emits, and returns the error messages. A type error in generated
 * code fails the user's build at a position they cannot see.
 */
function typeErrorsOfGeneratedCode(source: string): string[] {
	const { printed, diagnostics, cleanup } = runTransform(source);
	const second = createFixtureProgram(printed, { surge: true });
	try {
		expect(diagnostics).toHaveLength(0);
		return ts
			.getPreEmitDiagnostics(second.program, second.sourceFile)
			.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
	} finally {
		cleanup();
		second.cleanup();
	}
}

describe("transform (end-to-end)", () => {
	test("createBinarySerializer<T>() becomes an IIFE and injects a sorted @rbxts/surge import", () => {
		const { printed, cleanup } = runTransform(
			`import { createBinarySerializer } from "@rbxts/surge";
			interface P { x: number; }
			const s = createBinarySerializer<P>();`,
		);
		try {
			expect(printed).toContain(
				'import { alloc as __surge_alloc, beginRead as __surge_beginRead, beginReadBlobs as __surge_beginReadBlobs, beginWrite as __surge_beginWrite, beginWriteBlobs as __surge_beginWriteBlobs, finishWrite as __surge_finishWrite, finishWriteBlobs as __surge_finishWriteBlobs, readAlloc as __surge_readAlloc } from "@rbxts/surge";',
			);
			expect(printed).toContain("const s = function () {");
			expect(printed).toContain("serialize:");
			expect(printed).toContain("deserialize:");
		} finally {
			cleanup();
		}
	});

	test("createSerializer<T>() produces only the serialize function, not a Serializer object", () => {
		const { printed, cleanup } = runTransform(
			`import { createSerializer } from "@rbxts/surge";
			interface P { x: number; }
			const s = createSerializer<P>();`,
		);
		try {
			expect(printed).toContain("const s = function () {");
			expect(printed).not.toContain("serialize:");
			expect(printed).not.toContain("deserialize:");
		} finally {
			cleanup();
		}
	});

	test("multiple call sites in one file share a single injected import statement", () => {
		const { printed, cleanup } = runTransform(
			`import { createSerializer, createDeserializer } from "@rbxts/surge";
			interface P { x: number; }
			const s = createSerializer<P>();
			const d = createDeserializer<P>();`,
		);
		try {
			// One combined injected import (distinct from the fixture source's own
			// `import { createSerializer, createDeserializer }` line) covering the
			// helpers both call sites need.
			expect(printed.match(/^import \{ alloc as __surge_alloc,/gm)?.length).toBe(1);
		} finally {
			cleanup();
		}
	});

	// Regression test for docs/future-work/recursive-union-types.md: this
	// used to crash the whole transform with an uncaught
	// "Maximum call stack size exceeded" instead of producing a helper.
	test("a recursive discriminated union compiles to helper declarations instead of crashing the transform", () => {
		const { printed, cleanup } = runTransform(
			`import { createBinarySerializer } from "@rbxts/surge";
			type Expr = { kind: "num"; v: number } | { kind: "add"; l: Expr; r: Expr };
			const s = createBinarySerializer<Expr>();`,
		);
		try {
			// Not a hardcoded counter suffix: `helperCounter` is a module-scoped
			// tally shared across every test in this file, so this test's own
			// number depends on how many recursive/generic fixtures ran before it.
			expect(printed).toMatch(/surge_Expr_\d+_write/);
			expect(printed).toMatch(/surge_Expr_\d+_read/);
		} finally {
			cleanup();
		}
	});

	test("a same-named local function is left untouched and no import is injected", () => {
		const { printed, cleanup } = runTransform(
			`function createSerializer<T>(): void {} createSerializer<number>();`,
		);
		try {
			expect(printed).not.toContain('from "@rbxts/surge"');
			expect(printed).toContain("createSerializer<number>()");
		} finally {
			cleanup();
		}
	});
});

describe("transform diagnostics", () => {
	test("a walk diagnostic surfaces as a ts.Diagnostic at the offending property, and the call is left untransformed", () => {
		const source = `import { createBinarySerializer } from "@rbxts/surge";
			interface P { bad: symbol; }
			const s = createBinarySerializer<P>();`;
		const { printed, diagnostics, cleanup } = runTransform(source);
		try {
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Error);
			expect(diagnostics[0].start).toBe(source.indexOf("bad: symbol;"));
			expect(diagnostics[0].length).toBe("bad: symbol;".length);
			expect(printed).toContain("createBinarySerializer<P>()");
		} finally {
			cleanup();
		}
	});

	test("a factory call without an explicit type argument reports a diagnostic instead of failing at runtime", () => {
		const source = `import { createBinarySerializer, Serializer } from "@rbxts/surge";
			interface P { x: number; }
			const s: Serializer<P> = createBinarySerializer();`;
		const { diagnostics, cleanup } = runTransform(source);
		try {
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].messageText).toContain("explicit type argument");
			expect(diagnostics[0].start).toBe(source.indexOf("createBinarySerializer()"));
		} finally {
			cleanup();
		}
	});
});

describe("transform injected imports", () => {
	test("a user declaration named after a @rbxts/surge export is neither redeclared nor called by the generated code", () => {
		const { printed, cleanup } = runTransform(
			`import { createSerializer } from "@rbxts/surge";
			interface P { x: number; }
			function alloc(): void {}
			const s = createSerializer<P>();`,
		);
		try {
			expect(printed).toContain("import { alloc as __surge_alloc,");
			expect(printed).toContain("__surge_alloc(8)");
			expect(printed).not.toMatch(/[^_]alloc\(8\)/);
		} finally {
			cleanup();
		}
	});
});

describe("transform generated code", () => {
	// Each case is a shape whose generated code used to fail the type check.
	test.each([
		["a tuple whose rest element type differs from a fixed element", `type T = [string, ...number[]];`],
		[
			"an optional property of a recursive type",
			`interface Folder { name: string; entries: Entry[]; }
			interface Entry { size: number; folder?: Folder; }
			type T = Folder;`,
		],
		[
			"an optional property of a recursive discriminated union variant",
			`type T = { kind: "leaf"; label?: string } | { kind: "pair"; l: T; r: T };`,
		],
		[
			"an optional literal union property of a recursive type",
			`interface Chain { mode?: "on" | "off"; next?: Chain; } type T = Chain;`,
		],
		["a tuple property of a recursive type", `interface Scope { pair?: [Scope, number]; } type T = Scope;`],
		[
			"a Record property of a recursive type",
			`interface Tree { byName: Record<string, Tree>; counts: { [id: number]: number }; } type T = Tree;`,
		],
		["a required property of type unknown", `interface T { anything: unknown; }`],
		["an optional property of type unknown", `interface T { anything?: unknown; list: unknown[]; }`],
	])("the generated code for %s passes the type check", (_name, declarations) => {
		const errors = typeErrorsOfGeneratedCode(
			`import { createBinarySerializer } from "@rbxts/surge";
			${declarations}
			export const s = createBinarySerializer<T>();`,
		);
		expect(errors).toEqual([]);
	});

	// Checks each row of `FIXED_DATATYPES` against `@rbxts/types`: the property
	// paths, their types, and the constructor's arguments.
	test.each(Object.keys(FIXED_DATATYPES))("the generated code for %s passes the type check", (name) => {
		const errors = typeErrorsOfGeneratedCode(
			`import { createBinarySerializer } from "@rbxts/surge";
			interface T { alone: ${name}; member: ${name} | string; maybe?: ${name}; }
			export const s = createBinarySerializer<T>();`,
		);
		expect(errors).toEqual([]);
	});

	test("the generated code for the 24-bit widths passes the type check", () => {
		const errors = typeErrorsOfGeneratedCode(
			`import { DataType, createBinarySerializer } from "@rbxts/surge";
			interface T { u: DataType.u24; i: DataType.i24; list: DataType.i24[]; }
			export const s = createBinarySerializer<T>();`,
		);
		expect(errors).toEqual([]);
	});

	test("the generated code for packed optionals passes the type check", () => {
		const errors = typeErrorsOfGeneratedCode(
			`import { DataType, createBinarySerializer } from "@rbxts/surge";
			interface Inner { count?: number; flag: boolean; label: string; maybeFlag?: boolean; anything?: unknown; }
			interface T { packed: DataType.Packed<Inner>; variants: DataType.Packed<{ kind: "a"; x?: string } | { kind: "b" }>; }
			export const s = createBinarySerializer<T>();`,
		);
		expect(errors).toEqual([]);
	});

	test("the generated code for a buffer passes the type check", () => {
		const errors = typeErrorsOfGeneratedCode(
			`import { createBinarySerializer } from "@rbxts/surge";
			interface T { alone: buffer; member: buffer | string; maybe?: buffer; list: buffer[]; }
			export const s = createBinarySerializer<T>();`,
		);
		expect(errors).toEqual([]);
	});

	test("the generated code for a shape of every common kind passes the type check", () => {
		const errors = typeErrorsOfGeneratedCode(
			`import { DataType, createBinarySerializer } from "@rbxts/surge";
			interface Everything {
				n: number; w: DataType.u16; b: boolean; s: string; o?: string;
				list: number[]; map: Map<string, number>; set: Set<string>; record: Record<string, boolean>;
				literal: "a" | "b"; constant: 1; tagged: { kind: "x"; v: number } | { kind: "y" };
				guarded: string | number | { name: string };
				position: Vector3; tint: Color3; placement: CFrame; rig: Enum.HumanoidRigType;
				colors: ColorSequence; numbers: NumberSequence; part: Instance;
				flags: DataType.Packed<{ p: boolean; q: boolean }>;
			}
			export const s = createBinarySerializer<Everything>();`,
		);
		expect(errors).toEqual([]);
	});
});
