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
	test("a shape with no blob field pays nothing for the blob side channel", () => {
		const { printed, cleanup } = runTransform(
			`import { createBinarySerializer } from "@rbxts/surge";
			interface P { x: number; flag: boolean; }
			const s = createBinarySerializer<P>();`,
		);
		try {
			for (const name of ["beginWriteBlobs", "finishWriteBlobs", "beginReadBlobs"]) {
				expect(printed).not.toContain(name);
			}
			// The property is still there, because `Serializer<T>` declares it.
			expect(printed).toContain("blobs: [] as Array<defined>");
			// Nothing reads the parameter, so its name keeps a consumer's
			// `noUnusedParameters` quiet.
			expect(printed).toContain("_inputBlobs");
		} finally {
			cleanup();
		}
	});

	test("a shape with a blob field still carries the side channel", () => {
		const { printed, cleanup } = runTransform(
			`import { createBinarySerializer } from "@rbxts/surge";
			interface P { x: number; part: Instance; }
			const s = createBinarySerializer<P>();`,
		);
		try {
			for (const name of ["beginWriteBlobs", "finishWriteBlobs", "beginReadBlobs", "pushBlob", "nextBlob"]) {
				expect(printed).toContain(name);
			}
			expect(printed).not.toContain("_inputBlobs");
		} finally {
			cleanup();
		}
	});

	test("a blob reachable only through a recursion helper still carries the side channel", () => {
		const { printed, cleanup } = runTransform(
			`import { createBinarySerializer } from "@rbxts/surge";
			interface Node { part: Instance; kids: Node[]; }
			const s = createBinarySerializer<Node>();`,
		);
		try {
			expect(printed).toContain("beginWriteBlobs");
			expect(printed).toContain("pushBlob");
		} finally {
			cleanup();
		}
	});

	test("createBinarySerializer<T>() becomes an IIFE and injects a sorted @rbxts/surge import", () => {
		const { printed, cleanup } = runTransform(
			`import { createBinarySerializer } from "@rbxts/surge";
			interface P { x: number; }
			const s = createBinarySerializer<P>();`,
		);
		try {
			// No blob field, so nothing from the blob side channel is imported.
			expect(printed).toContain(
				'import { finishWrite as __surge_finishWrite, grow as __surge_grow } from "@rbxts/surge";',
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
			expect(printed.match(/^import [{] finishWrite as __surge_finishWrite,/gm)?.length).toBe(1);
		} finally {
			cleanup();
		}
	});

	// Regression test for the recursive-union-types finding in
	// docs/research/september-2026-review.md in the surge repo: this
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

	// A serializer is generated for one concrete type. Transformed, an
	// unconstrained parameter became a blob serializer, and a constrained one
	// a serializer for its constraint that dropped every other property.
	test.each([
		["an unconstrained type parameter", "<T>", "T"],
		["a type parameter constrained to an object type", "<T extends { a: number }>", "T"],
		["an object type with a type-parameter property", "<T>", "{ v: T }"],
	])("a call site inside a generic function whose type argument is %s reports a diagnostic", (_name, params, arg) => {
		const source = `import { createBinarySerializer } from "@rbxts/surge";
			export function make${params}() { return createBinarySerializer<${arg}>(); }`;
		const { printed, diagnostics, cleanup } = runTransform(source);
		try {
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].messageText).toContain("depends on a type parameter");
			// Left untransformed: nothing was generated and nothing imported.
			expect(printed).not.toContain("__surge_");
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
			function grow(): void {}
			const s = createSerializer<P>();`,
		);
		try {
			expect(printed).toContain("grow as __surge_grow");
			expect(printed).toContain("__surge_grow(__surge_scratch,");
			expect(printed).not.toMatch(/[^_]grow[(]__surge_scratch/);
		} finally {
			cleanup();
		}
	});

	test("a createDeserializer call site imports and emits nothing of the write side", () => {
		const { printed, cleanup } = runTransform(
			`import { createDeserializer } from "@rbxts/surge";
			interface T { v: number; next?: T; }
			export const d = createDeserializer<T>();`,
		);
		try {
			expect(printed).toMatch(/function surge_T_\d+_read/);
			expect(printed).not.toMatch(/finishWrite|__surge_grow|__surge_scratch|_write\b/);
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

	// A factory that returns one function declares only that side's state, so a
	// recursion helper emitted for the other side would name state that does
	// not exist.
	const recursiveShapes = [
		["a recursive object", `interface T { v: number; next?: T; tags: string[]; }`],
		["a recursive discriminated union", `type T = { kind: "leaf"; label: string } | { kind: "pair"; l: T; r: T };`],
	];
	test.each(
		["createSerializer", "createDeserializer"].flatMap((factory) =>
			recursiveShapes.map(([name, declarations]) => [factory, name, declarations]),
		),
	)("%s on %s generates code that passes the type check", (factory, _name, declarations) => {
		const errors = typeErrorsOfGeneratedCode(
			`import { ${factory} } from "@rbxts/surge";
			${declarations}
			export const s = ${factory}<T>();`,
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
			interface T { packed: DataType.Packed<Inner>; placements: DataType.Packed<{ one: CFrame; maybe?: CFrame; list: CFrame[] }>; variants: DataType.Packed<{ kind: "a"; x?: string } | { kind: "b" }>; holder: DataType.Packed<{ shape: { id: 1; n: number } | { id: 2; flag: boolean }; three: { t: "x" } | { t: "y" } | { t: "z" } }>; }
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

	test("a file directive stays ahead of the injected import", () => {
		// Luau honours a `--!` hot comment only ahead of the first line of code,
		// and roblox-ts hoists one above its own banner only while it leads the
		// first statement. The injected import takes that position, so the
		// comments have to move with it.
		const { printed, cleanup } = runTransform(
			`//!optimize 2
			import { createBinarySerializer } from "@rbxts/surge";
			interface P { x: number; }
			const s = createBinarySerializer<P>();`,
		);
		try {
			expect(printed.indexOf("//!optimize 2")).toBeLessThan(
				printed.indexOf("import { finishWrite as __surge_finishWrite"),
			);
			expect(printed.split("//!optimize 2")).toHaveLength(2);
		} finally {
			cleanup();
		}
	});

	test("a directive survives when the first statement is the one being rewritten", () => {
		// The import does not have to be first: whatever statement the header
		// comments are attached to is the one they have to be taken off.
		const { printed, cleanup } = runTransform(
			`//!optimize 2
			const s = createBinarySerializer<P>();
			import { createBinarySerializer } from "@rbxts/surge";
			interface P { x: number; }`,
		);
		try {
			expect(printed.indexOf("//!optimize 2")).toBeLessThan(
				printed.indexOf("import { finishWrite as __surge_finishWrite"),
			);
			expect(printed.split("//!optimize 2")).toHaveLength(2);
		} finally {
			cleanup();
		}
	});

	test("a header comment above a directive keeps its order", () => {
		const { printed, cleanup } = runTransform(
			`//!native
			// What this file is for.
			import { createBinarySerializer } from "@rbxts/surge";
			interface P { x: number; }
			const s = createBinarySerializer<P>();`,
		);
		try {
			expect(printed.indexOf("//!native")).toBeLessThan(printed.indexOf("// What this file is for."));
			expect(printed.indexOf("// What this file is for.")).toBeLessThan(
				printed.indexOf("import { finishWrite as __surge_finishWrite"),
			);
		} finally {
			cleanup();
		}
	});
});

describe("transform checks option", () => {
	test("checks: true emits the bounds checks, and the same shape without them does not", () => {
		const source = `import { createBinarySerializer } from "@rbxts/surge";
			interface P { x: number; list: Array<number>; }
			const guarded = createBinarySerializer<P>({ checks: true });
			const plain = createBinarySerializer<P>();`;
		const { printed, diagnostics, cleanup } = runTransform(source);
		try {
			expect(diagnostics).toHaveLength(0);
			// One call site checked and one not, in one file: the option is per
			// call site, so a place can hold a boundary serializer and its own.
			expect(printed.match(/@rbxts\/surge: deserialize read past the end/g)?.length).toBeGreaterThan(0);
			const [guardedHalf, plainHalf] = printed.split("const plain =");
			expect(guardedHalf).toContain("@rbxts/surge: ");
			expect(plainHalf).not.toContain("@rbxts/surge: ");
		} finally {
			cleanup();
		}
	});

	test("generated code with checks still type-checks in a second program", () => {
		expect(
			typeErrorsOfGeneratedCode(
				`import { createBinarySerializer } from "@rbxts/surge";
				interface P { x: number; list: Array<string>; map: Map<string, number>; tag: "a" | "b"; }
				const s = createBinarySerializer<P>({ checks: true });`,
			),
		).toEqual([]);
	});

	// The value decides what is emitted, so it cannot be one the game works out
	// as it runs; defaulting it to false would leave the boundary unchecked.
	test("a checks value that is not a literal reports a diagnostic", () => {
		const source = `import { createBinarySerializer } from "@rbxts/surge";
			interface P { x: number; }
			declare const untrusted: boolean;
			const s = createBinarySerializer<P>({ checks: untrusted });`;
		const { printed, diagnostics, cleanup } = runTransform(source);
		try {
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].messageText).toContain('must be written as "true" or "false"');
			expect(diagnostics[0].start).toBe(source.indexOf("untrusted }"));
			expect(printed).toContain("createBinarySerializer<P>({ checks: untrusted })");
		} finally {
			cleanup();
		}
	});

	test("an unknown option reports a diagnostic", () => {
		const { diagnostics, cleanup } = runTransform(
			`import { createBinarySerializer } from "@rbxts/surge";
			interface P { x: number; }
			const s = createBinarySerializer<P>({ checks: true, ...{} });`,
		);
		try {
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].messageText).toContain('one property, "checks"');
		} finally {
			cleanup();
		}
	});

	// There is no read path to check, so accepting it would say otherwise.
	test("checks on createSerializer reports a diagnostic", () => {
		const { diagnostics, cleanup } = runTransform(
			`import { createSerializer } from "@rbxts/surge";
			interface P { x: number; }
			const s = createSerializer<P>({ checks: true });`,
		);
		try {
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].messageText).toContain("createSerializer() takes no options");
		} finally {
			cleanup();
		}
	});
});
