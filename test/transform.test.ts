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
			`import { createCodec } from "@rbxts/surge";
			interface P { x: number; flag: boolean; }
			const s = createCodec<P>();`,
		);
		try {
			for (const name of ["beginWriteBlobs", "finishWriteBlobs", "beginReadBlobs"]) {
				expect(printed).not.toContain(name);
			}
			// `Serialized<P>` is the buffer alone.
			expect(printed).not.toContain("blobs:");
			expect(printed).toContain("return __surge_finishWrite(__surge_scratch, __surge_cursor);");
			// `deserialize` takes the buffer `serialize` returns.
			expect(printed).toContain("deserialize: (input: buffer) => {");
		} finally {
			cleanup();
		}
	});

	test("a shape whose declared result keeps an array it never fills returns an empty one", () => {
		// `Serialized<T>` counts any `_nominal_*` property as a Roblox type it
		// passes through; the walk checks where it is declared, and encodes
		// this one.
		const { printed, diagnostics, cleanup } = runTransform(
			`import { createCodec } from "@rbxts/surge";
			interface P { _nominal_P: "p"; x: number; }
			const s = createCodec<P>();`,
		);
		try {
			expect(diagnostics).toHaveLength(0);
			expect(printed).not.toContain("pushBlob");
			expect(printed).toContain("blobs: [] as Array<defined>");
		} finally {
			cleanup();
		}
	});

	test.each(["createCodec", "createDeserializer"])(
		"%s's deserialize takes the declared table even where it reads no blob",
		(factory) => {
			const { printed, diagnostics, cleanup } = runTransform(
				`import { ${factory} } from "@rbxts/surge";
			interface P { _nominal_P: "p"; x: number; }
			const s = ${factory}<P>();`,
			);
			try {
				expect(diagnostics).toHaveLength(0);
				expect(printed).toContain("__surge_input = input.buffer;");
				expect(printed).not.toContain("beginReadBlobs");
			} finally {
				cleanup();
			}
		},
	);

	test("a deserialize that reads nothing names its parameter for a consumer's noUnusedParameters", () => {
		const { printed, cleanup } = runTransform(
			`import { createCodec } from "@rbxts/surge";
			interface P { kind: "only"; }
			const s = createCodec<P>();`,
		);
		try {
			expect(printed).toContain("deserialize: (_input: buffer) => {");
		} finally {
			cleanup();
		}
	});

	test.each([
		["numbers, strings and booleans", "interface P { a: number; b: string; c: boolean; d?: string }", false],
		[
			"the DataType brands",
			`interface P {
				a: DataType.u8;
				b: DataType.Length<string, DataType.u8>;
				c: DataType.Packed<{ x: boolean }>;
				d: DataType.Vector<DataType.i16>;
				e: DataType.Transform<DataType.i16>;
				f: DataType.Quantized<CFrame>;
				g: DataType.Range<DataType.u8, 0, 100>;
			}`,
			false,
		],
		[
			"every Roblox type surge encodes",
			`interface P {
				a: Vector2; b: Vector3; c: CFrame; d: Color3; e: ColorSequence; f: NumberSequence; g: buffer;
				h: Vector3int16; i: UDim; j: UDim2; k: BrickColor; l: NumberRange; m: Rect; n: DateTime;
				o: Enum.KeyCode;
			}`,
			false,
		],
		[
			"arrays, tuples, maps, sets and records",
			`interface P {
				a: number[]; b: [string, boolean]; c: Map<string, number>; d: Set<string>;
				e: Record<string, number>; f: "x" | "y" | undefined;
			}`,
			false,
		],
		["a recursive object", "interface P { children: P[]; name: string }", false],
		[
			"a recursive tagged union",
			'type E = { kind: "num"; v: number } | { kind: "add"; l: E; r: E }; interface P { e: E }',
			false,
		],
		["an Instance", "interface P { part: Instance }", true],
		["an unknown", "interface P { data: unknown }", true],
		["a Roblox type surge does not encode", "interface P { region: Region3 }", true],
		["an array of Instances", "interface P { parts: BasePart[] }", true],
		["a Map keyed by Instance", "interface P { map: Map<Instance, number> }", true],
		["a blob three objects down", "interface P { a: { b: { c: unknown } } }", true],
		["a recursive object with a blob", "interface P { next?: P; part?: Instance }", true],
		["a defined", "interface P { value: defined }", true],
	])(
		"the declared result has a blobs array exactly when the walk finds a blob: %s",
		(_name, declaration, carries) => {
			const { printed, diagnostics, cleanup } = runTransform(
				`import { DataType, createCodec } from "@rbxts/surge";
			${declaration}
			const s = createCodec<P>();`,
			);
			try {
				expect(diagnostics).toHaveLength(0);
				expect(printed.includes("pushBlob")).toBe(carries);
				expect(printed.includes("blobs:")).toBe(carries);
			} finally {
				cleanup();
			}
		},
	);

	test("a Roblox type with properties of its own is a blob to the declared result type too", () => {
		// The walk passes `Vector3 & { tag: 1 }` through as a blob, so
		// `Serialized<P>` must declare the array, or the call site is a
		// diagnostic.
		const { printed, diagnostics, cleanup } = runTransform(
			`import { createCodec } from "@rbxts/surge";
			interface P { v: Vector3 & { tag: 1 }; }
			const s = createCodec<P>();`,
		);
		try {
			expect(diagnostics).toHaveLength(0);
			expect(printed).toContain("pushBlob");
			expect(printed).toContain("blobs: __surge_finishWriteBlobs()");
		} finally {
			cleanup();
		}
	});

	test("a shape with a blob field still carries the side channel", () => {
		const { printed, cleanup } = runTransform(
			`import { createCodec } from "@rbxts/surge";
			interface P { x: number; part: Instance; }
			const s = createCodec<P>();`,
		);
		try {
			for (const name of ["beginWriteBlobs", "finishWriteBlobs", "beginReadBlobs", "pushBlob", "nextBlob"]) {
				expect(printed).toContain(name);
			}
			// `deserialize` takes the table `serialize` returns.
			expect(printed).toContain("__surge_input = input.buffer;");
			expect(printed).toContain("__surge_beginReadBlobs(input.blobs);");
		} finally {
			cleanup();
		}
	});

	test("a blob reachable only through a recursion helper still carries the side channel", () => {
		const { printed, cleanup } = runTransform(
			`import { createCodec } from "@rbxts/surge";
			interface Node { part: Instance; kids: Node[]; }
			const s = createCodec<Node>();`,
		);
		try {
			expect(printed).toContain("beginWriteBlobs");
			expect(printed).toContain("pushBlob");
		} finally {
			cleanup();
		}
	});

	test("createCodec<T>() becomes an IIFE and injects a sorted @rbxts/surge import", () => {
		const { printed, cleanup } = runTransform(
			`import { createCodec } from "@rbxts/surge";
			interface P { x: number; }
			const s = createCodec<P>();`,
		);
		try {
			// No blob field, so nothing from the blob side channel is imported.
			expect(printed).toContain(
				'import { finishWrite as __surge_finishWrite, grow as __surge_grow } from "@rbxts/surge/out/abi";',
			);
			expect(printed).toContain("const s = function () {");
			expect(printed).toContain("serialize:");
			expect(printed).toContain("deserialize:");
		} finally {
			cleanup();
		}
	});

	test("createSerializer<T>() produces only the serialize function, not a Codec object", () => {
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
			`import { createCodec } from "@rbxts/surge";
			type Expr = { kind: "num"; v: number } | { kind: "add"; l: Expr; r: Expr };
			const s = createCodec<Expr>();`,
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
		const source = `import { createCodec } from "@rbxts/surge";
			interface P { bad: symbol; }
			const s = createCodec<P>();`;
		const { printed, diagnostics, cleanup } = runTransform(source);
		try {
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Error);
			expect(diagnostics[0].start).toBe(source.indexOf("bad: symbol;"));
			expect(diagnostics[0].length).toBe("bad: symbol;".length);
			expect(printed).toContain("createCodec<P>()");
		} finally {
			cleanup();
		}
	});

	test("a factory call without an explicit type argument reports a diagnostic instead of failing at runtime", () => {
		const source = `import { Codec, createCodec } from "@rbxts/surge";
			interface P { x: number; }
			const s: Codec<P> = createCodec();`;
		const { diagnostics, cleanup } = runTransform(source);
		try {
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].messageText).toContain("explicit type argument");
			expect(diagnostics[0].start).toBe(source.indexOf("createCodec()"));
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
		const source = `import { createCodec } from "@rbxts/surge";
			export function make${params}() { return createCodec<${arg}>(); }`;
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
		["an array of itself", `type T = T[];`],
		["a tuple holding an array of itself", `type T = [number, T[]];`],
		["properties of type undefined and void", `interface T { a: undefined; b: void; c: number; }`],
		["an optional property of type unknown", `interface T { anything?: unknown; list: unknown[]; }`],
	])("the generated code for %s passes the type check", (_name, declarations) => {
		const errors = typeErrorsOfGeneratedCode(
			`import { createCodec } from "@rbxts/surge";
			${declarations}
			export const s = createCodec<T>();`,
		);
		expect(errors).toEqual([]);
	});

	// Checked after the transform, a variable holds the generated code's own
	// type, so its result must still be what `Serialized<T>` declares.
	test.each([
		["no blob", "interface T { v: number; }", "return s.deserialize(s.serialize(value));"],
		[
			"a blob",
			"interface T { part: Instance; }",
			"const { buffer, blobs } = s.serialize(value); return s.deserialize({ buffer, blobs });",
		],
	])("a caller of a result with %s passes the type check", (_name, declarations, body) => {
		const errors = typeErrorsOfGeneratedCode(
			`import { createCodec } from "@rbxts/surge";
			${declarations}
			const s = createCodec<T>();
			export function send(value: T): T {
				${body}
			}`,
		);
		expect(errors).toEqual([]);
	});

	// `createDeserializer` has no `serialize` to read the declared shape from,
	// so it is read from what its `deserialize` takes.
	test.each([
		["no blob", "interface T { v: number; }"],
		["a blob", "interface T { part: Instance; }"],
		["a declared array it never fills", `interface T { _nominal_T: "t"; v: number; }`],
	])("separate factories for a result with %s pass the type check", (_name, declarations) => {
		const errors = typeErrorsOfGeneratedCode(
			`import { createDeserializer, createSerializer } from "@rbxts/surge";
			${declarations}
			const s = createSerializer<T>();
			const d = createDeserializer<T>();
			export function roundTrip(value: T): T {
				return d(s(value));
			}`,
		);
		expect(errors).toEqual([]);
	});

	// A polymorphic `this` is instantiated by the checker, so it walks as a
	// recursion rather than failing the type-parameter check.
	test.each([
		["an interface", `interface T { v: number; next?: this; }`],
		["a class", `class T { v = 1; next?: this; }`],
	])("a polymorphic this in %s compiles to a recursion helper", (_name, declarations) => {
		const { printed, diagnostics, cleanup } = runTransform(
			`import { createCodec } from "@rbxts/surge";
			${declarations}
			export const s = createCodec<T>();`,
		);
		try {
			expect(diagnostics).toHaveLength(0);
			expect(printed).toMatch(/function surge_T_\d+_write/);
		} finally {
			cleanup();
		}
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

	// A dictionary is rebuilt as a `Map` or `Set`, which constrain no key, so
	// every key the walk accepts must type-check, including those a `Record`
	// rejects: a datatype, an enum item, an object, a literal or literal union.
	test.each([
		["a boolean", "Set<boolean>"],
		["an enum item", "Map<Enum.SortOrder, number>"],
		["one literal", 'Set<"a">'],
		["a literal union", 'Set<"a" | "b">'],
		["an object", "Map<{ a: number }, number>"],
		["a Vector3", "Map<Vector3, number>"],
		["a buffer", "Set<buffer>"],
		["a branded number", "Record<DataType.u8, number>"],
	])("the generated code for a dictionary keyed by %s passes the type check", (_name, dict) => {
		const errors = typeErrorsOfGeneratedCode(
			`import { Codec, DataType, createCodec } from "@rbxts/surge";
			interface T { d: ${dict}; }
			export const s: Codec<T> = createCodec<T>();`,
		);
		expect(errors).toEqual([]);
	});

	// `deserialize` returns the type the caller declared; inferred instead, a
	// literal property widens to its primitive and the result is not assignable
	// to the caller's own type.
	test.each([
		["a literal union", `interface T { k: "a" | "b"; }`],
		["an optional literal union", `interface T { k?: "a" | "b"; }`],
		["one literal", `interface T { version: 1; }`],
		["a tuple", `interface T { pair: [string, number]; }`],
		["an array of one literal", `interface T { marks: Array<"x">; }`],
		["a string enum", `enum Color { Red = "red", Green = "green" } interface T { color: Color; }`],
		["a blob", `interface T { part: Instance; }`],
	])("a deserialize result with %s is assignable to its type argument", (_name, declarations) => {
		const errors = typeErrorsOfGeneratedCode(
			`import { Serialized, createCodec } from "@rbxts/surge";
			${declarations}
			const s = createCodec<T>();
			export function read(input: Serialized<T>): T {
				return s.deserialize(input);
			}`,
		);
		expect(errors).toEqual([]);
	});

	// Checks each row of `FIXED_DATATYPES` against `@rbxts/types`: the property
	// paths, their types, and the constructor's arguments.
	test.each(Object.keys(FIXED_DATATYPES))("the generated code for %s passes the type check", (name) => {
		const errors = typeErrorsOfGeneratedCode(
			`import { createCodec } from "@rbxts/surge";
			interface T { alone: ${name}; member: ${name} | string; maybe?: ${name}; }
			export const s = createCodec<T>();`,
		);
		expect(errors).toEqual([]);
	});

	test("the generated code for the 24-bit widths passes the type check", () => {
		const errors = typeErrorsOfGeneratedCode(
			`import { DataType, createCodec } from "@rbxts/surge";
			interface T { u: DataType.u24; i: DataType.i24; list: DataType.i24[]; }
			export const s = createCodec<T>();`,
		);
		expect(errors).toEqual([]);
	});

	test("the generated code for ranges, quantized rotations and bit sets passes the type check", () => {
		for (const options of ["", "{ writeChecks: true }"]) {
			const errors = typeErrorsOfGeneratedCode(
				`import { DataType, createCodec } from "@rbxts/surge";
				interface T {
					health: DataType.Range<number, 0, 100>;
					offset: DataType.Range<number, -1000, 1000>;
					ratio: DataType.Range<DataType.f32, 0, 1>;
					scores: Map<DataType.Range<DataType.u16, 1, 500>, DataType.Range<number, -1, 1>>;
					turn: -1 | 0 | 1;
					placement: DataType.Quantized<CFrame>;
					narrow?: DataType.Quantized<DataType.Transform<DataType.i16>>;
					flags: DataType.Packed<{ tags: Set<"a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i">; modes?: ReadonlySet<1 | -2 | true>; each: Array<Set<"x">> }>;
				}
				export const s = createCodec<T>(${options});`,
			);
			expect(errors).toEqual([]);
		}
	});

	test("the generated code for packed optionals passes the type check", () => {
		const errors = typeErrorsOfGeneratedCode(
			`import { DataType, createCodec } from "@rbxts/surge";
			interface Inner { count?: number; flag: boolean; label: string; maybeFlag?: boolean; anything?: unknown; }
			interface T { packed: DataType.Packed<Inner>; placements: DataType.Packed<{ one: CFrame; maybe?: CFrame; list: CFrame[] }>; variants: DataType.Packed<{ kind: "a"; x?: string } | { kind: "b" }>; holder: DataType.Packed<{ shape: { id: 1; n: number } | { id: 2; flag: boolean }; three: { t: "x" } | { t: "y" } | { t: "z" } }>; }
			export const s = createCodec<T>();`,
		);
		expect(errors).toEqual([]);
	});

	test("the generated code for a buffer passes the type check", () => {
		const errors = typeErrorsOfGeneratedCode(
			`import { createCodec } from "@rbxts/surge";
			interface T { alone: buffer; member: buffer | string; maybe?: buffer; list: buffer[]; }
			export const s = createCodec<T>();`,
		);
		expect(errors).toEqual([]);
	});

	test("the generated code for a shape of every common kind passes the type check", () => {
		const errors = typeErrorsOfGeneratedCode(
			`import { DataType, createCodec } from "@rbxts/surge";
			interface Everything {
				n: number; w: DataType.u16; b: boolean; s: string; o?: string;
				list: number[]; map: Map<string, number>; set: Set<string>; record: Record<string, boolean>;
				literal: "a" | "b"; constant: 1; tagged: { kind: "x"; v: number } | { kind: "y" };
				guarded: string | number | { name: string };
				position: Vector3; tint: Color3; placement: CFrame; rig: Enum.HumanoidRigType;
				colors: ColorSequence; numbers: NumberSequence; part: Instance;
				flags: DataType.Packed<{ p: boolean; q: boolean }>;
			}
			export const s = createCodec<Everything>();`,
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
			import { createCodec } from "@rbxts/surge";
			interface P { x: number; }
			const s = createCodec<P>();`,
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
			const s = createCodec<P>();
			import { createCodec } from "@rbxts/surge";
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
			import { createCodec } from "@rbxts/surge";
			interface P { x: number; }
			const s = createCodec<P>();`,
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

describe("transform readChecks option", () => {
	test("readChecks: true emits the bounds checks, and the same shape without them does not", () => {
		const source = `import { createCodec } from "@rbxts/surge";
			interface P { x: number; list: Array<number>; }
			const guarded = createCodec<P>({ readChecks: true });
			const plain = createCodec<P>();`;
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

	test("generated code with readChecks still type-checks in a second program", () => {
		expect(
			typeErrorsOfGeneratedCode(
				`import { createCodec } from "@rbxts/surge";
				interface P { x: number; list: Array<string>; map: Map<string, number>; tag: "a" | "b"; }
				const s = createCodec<P>({ readChecks: true });`,
			),
		).toEqual([]);
	});

	test("readChecks makes deserialize take unknown and check what it was given", () => {
		const source = `import { createCodec } from "@rbxts/surge";
			interface P { x: number; }
			const guarded = createCodec<P>({ readChecks: true });
			const plain = createCodec<P>();`;
		const { printed, diagnostics, cleanup } = runTransform(source);
		try {
			expect(diagnostics).toHaveLength(0);
			const [guardedHalf, plainHalf] = printed.split("const plain =");
			expect(guardedHalf).toContain("deserialize: (input: unknown) => {");
			expect(guardedHalf).toContain('if (!typeIs(input, "buffer")) {');
			expect(guardedHalf).toContain("@rbxts/surge: deserialize was given something other than a buffer");
			expect(plainHalf).toContain("deserialize: (input: buffer) => {");
		} finally {
			cleanup();
		}
	});

	// The shape checked is the `Serialized<T>` the call site declares, read
	// from `deserialize`'s first call signature, so it holds for a shape whose
	// declared table the walk never fills as well.
	test.each([
		["createCodec", "a blob", "interface P { x: number; part: Instance; }", true],
		["createDeserializer", "a blob", "interface P { x: number; part: Instance; }", true],
		["createDeserializer", "a declared table it never fills", `interface P { _nominal_P: "p"; x: number; }`, false],
	])("a readChecks %s of %s requires the table", (factory, _name, declaration, readsBlobs) => {
		const { printed, diagnostics, cleanup } = runTransform(
			`import { ${factory} } from "@rbxts/surge";
			${declaration}
			const s = ${factory}<P>({ readChecks: true });`,
		);
		try {
			expect(diagnostics).toHaveLength(0);
			expect(printed).toContain('if (!typeIs(input, "table")) {');
			expect(printed).toContain(
				"deserialize was given something other than a table of a buffer and a blobs array",
			);
			expect(printed).not.toContain('if (!typeIs(input, "buffer")) {');
			expect(printed.includes("__surge_beginReadBlobs(")).toBe(readsBlobs);
		} finally {
			cleanup();
		}
	});

	// `createDeserializer`'s declared input is `unknown` under `readChecks`, so
	// it cannot say whether `Serialized<T>` has `blobs`; a blob in the walk is
	// then no diagnostic.
	test.each([
		["no blob", "interface T { v: number; }"],
		["a blob", "interface T { v: number; part?: Instance; }"],
		["nothing to read", `interface T { kind: "only"; }`],
	])("a caller passing unknown to a readChecks deserialize of %s passes the type check", (_name, declarations) => {
		const errors = typeErrorsOfGeneratedCode(
			`import { createCodec, createDeserializer } from "@rbxts/surge";
			${declarations}
			const codec = createCodec<T>({ readChecks: true });
			const read = createDeserializer<T>({ readChecks: true });
			export function receive(input: unknown): T {
				return codec.deserialize(codec.serialize(read(input)));
			}`,
		);
		expect(errors).toEqual([]);
	});

	test("without readChecks, deserialize does not take unknown", () => {
		const errors = typeErrorsOfGeneratedCode(
			`import { createCodec } from "@rbxts/surge";
			interface T { v: number; }
			const codec = createCodec<T>();
			export function receive(input: unknown): T {
				return codec.deserialize(input);
			}`,
		);
		expect(errors).toHaveLength(1);
	});

	// The value decides what is emitted, so it cannot be one the game works out
	// as it runs; defaulting it to false would leave the boundary unchecked.
	test("a readChecks value that is not a literal reports a diagnostic", () => {
		const source = `import { createCodec } from "@rbxts/surge";
			interface P { x: number; }
			declare const untrusted: boolean;
			const s = createCodec<P>({ readChecks: untrusted });`;
		const { printed, diagnostics, cleanup } = runTransform(source);
		try {
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].messageText).toContain('must be written as "true" or "false"');
			expect(diagnostics[0].start).toBe(source.indexOf("untrusted }"));
			expect(printed).toContain("createCodec<P>({ readChecks: untrusted })");
		} finally {
			cleanup();
		}
	});

	test("an unknown option reports a diagnostic", () => {
		const { diagnostics, cleanup } = runTransform(
			`import { createCodec } from "@rbxts/surge";
			interface P { x: number; }
			const s = createCodec<P>({ readChecks: true, ...{} });`,
		);
		try {
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].messageText).toContain('options take "readChecks" and "writeChecks"');
		} finally {
			cleanup();
		}
	});

	// There is no read path to check, so accepting it would say otherwise.
	test("readChecks on createSerializer reports a diagnostic", () => {
		const { diagnostics, cleanup } = runTransform(
			`import { createSerializer } from "@rbxts/surge";
			interface P { x: number; }
			const s = createSerializer<P>({ readChecks: true });`,
		);
		try {
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].messageText).toContain(
				'createSerializer() has no read side, so it takes no "readChecks"',
			);
		} finally {
			cleanup();
		}
	});
});

describe("transform writeChecks option", () => {
	test("writeChecks: true emits the write-side checks, and the same shape without them does not", () => {
		const source = `import { DataType, createCodec } from "@rbxts/surge";
			interface P { name: DataType.Length<string, DataType.u8>; code: DataType.Length<string, 4>; }
			const guarded = createCodec<P>({ writeChecks: true });
			const plain = createCodec<P>();`;
		const { printed, diagnostics, cleanup } = runTransform(source);
		try {
			expect(diagnostics).toHaveLength(0);
			const [guardedHalf, plainHalf] = printed.split("const plain =");
			expect(guardedHalf).toContain("@rbxts/surge: serialize given a value whose count does not fit");
			expect(guardedHalf).toContain("@rbxts/surge: serialize given a value whose length is not");
			expect(plainHalf).not.toContain("@rbxts/surge: ");
		} finally {
			cleanup();
		}
	});

	test("createSerializer takes writeChecks, and its generated code type-checks", () => {
		expect(
			typeErrorsOfGeneratedCode(
				`import { DataType, createSerializer } from "@rbxts/surge";
				interface P { list: DataType.Length<Array<number>, DataType.u16>; pair: DataType.Length<Array<string | undefined>, 2>; tags: DataType.Length<Map<string, number>, DataType.u8>; }
				const s = createSerializer<P>({ writeChecks: true });`,
			),
		).toEqual([]);
	});

	// There is no write path to check, so accepting it would say otherwise.
	test("writeChecks on createDeserializer reports a diagnostic", () => {
		const { diagnostics, cleanup } = runTransform(
			`import { createDeserializer } from "@rbxts/surge";
			interface P { x: number; }
			const d = createDeserializer<P>({ writeChecks: true });`,
		);
		try {
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].messageText).toContain(
				'createDeserializer() has no write side, so it takes no "writeChecks"',
			);
		} finally {
			cleanup();
		}
	});
});
