import * as ts from "typescript";

import transform from "../src/index";
import { createFixtureProgram, printNodes } from "./harness";

/** Runs the real transformer over `source` and prints the resulting file, for end-to-end assertions. */
function runTransform(source: string): { printed: string; cleanup: () => void } {
	const { program, sourceFile, cleanup } = createFixtureProgram(source, { surge: true });
	const transformer = transform(program, {}, { ts });
	const result = ts.transform(sourceFile, [transformer], program.getCompilerOptions());
	try {
		const printed = printNodes(result.transformed);
		return { printed, cleanup };
	} finally {
		result.dispose();
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
				'import { alloc, beginRead, beginReadBlobs, beginWrite, beginWriteBlobs, finishWrite, finishWriteBlobs, readAlloc } from "@rbxts/surge";',
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
			expect(printed.match(/^import \{ alloc,/gm)?.length).toBe(1);
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
