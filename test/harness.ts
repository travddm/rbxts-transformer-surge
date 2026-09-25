import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as ts from "typescript";

import type { Field } from "../src/field";
import { TypeWalker, type WalkDiagnostic } from "../src/walk";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const ROBLOX_TYPE_ROOTS = path.join(__dirname, "..", "node_modules", "@rbxts");

export interface FixtureOptions {
	/**
	 * Compiles with `noLib`/`typeRoots` pointed at the dev-installed
	 * `@rbxts/types` (and, transitively via its own `/// <reference types=".."
	 * />`, `@rbxts/compiler-types`), matching how a real roblox-ts project
	 * resolves `Instance`, `Enum.*`, `Vector3`, sequences, `defined`, and
	 * `buffer`. Implied by `surge`, since the real `@rbxts/surge` uses
	 * `buffer`/`defined` itself.
	 */
	readonly roblox?: boolean;
	/**
	 * Adds `test/fixtures/rbxts-surge` (a hand-maintained stand-in for the
	 * real `@rbxts/surge`, which lives in a separate repository -- see
	 * Package boundaries in surge's docs/coding-standards.md) to the program under the
	 * `@rbxts/surge` package name, so `DataType.*`, `Packed<T>`, and the
	 * `createCodec`/`createSerializer`/`createDeserializer`
	 * factories can appear in fixture source and be resolved by
	 * `detect.ts`'s package-identity check.
	 */
	readonly surge?: boolean;
}

export interface FixtureProgram {
	readonly program: ts.Program;
	readonly checker: ts.TypeChecker;
	readonly sourceFile: ts.SourceFile;
	readonly cleanup: () => void;
}

/**
 * Compiles `source` in a real, throwaway `ts.Program` (matching this
 * project's established "verify against the real compiler" approach rather
 * than hand-rolling a fake `ts.Type`).
 */
export function createFixtureProgram(source: string, options: FixtureOptions = {}): FixtureProgram {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surge-transformer-test-"));
	const file = path.join(dir, "input.ts");
	fs.writeFileSync(file, source);

	const compilerOptions: ts.CompilerOptions = {
		strict: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ES2019,
		module: ts.ModuleKind.CommonJS,
		moduleResolution: ts.ModuleResolutionKind.Node10,
		baseUrl: FIXTURES_DIR,
		paths: options.surge
			? { "@rbxts/surge": ["rbxts-surge/index"], "@rbxts/surge/*": ["rbxts-surge/*"] }
			: undefined,
	};
	if (options.roblox || options.surge) {
		compilerOptions.noLib = true;
		compilerOptions.typeRoots = [ROBLOX_TYPE_ROOTS];
		compilerOptions.types = ["types"];
	}

	const program = ts.createProgram([file], compilerOptions);
	const checker = program.getTypeChecker();
	const sourceFile = program.getSourceFile(file);
	if (!sourceFile) {
		throw new Error("failed to load the generated source file");
	}
	return { program, checker, sourceFile, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Finds a top-level `interface`/`type` declaration by name. */
export function findDeclaration(
	sourceFile: ts.SourceFile,
	declarationName: string,
): ts.InterfaceDeclaration | ts.TypeAliasDeclaration {
	let found: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | undefined;
	sourceFile.forEachChild((node) => {
		if (
			(ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
			node.name.text === declarationName
		) {
			found = node;
		}
	});
	if (!found) {
		throw new Error(`declaration '${declarationName}' not found in test source`);
	}
	return found;
}

/**
 * Compiles `source` and resolves the named top-level `interface`/`type`
 * declaration's `ts.Type` and node, plus a fresh `TypeWalker` bound to the
 * same checker.
 */
export function loadDeclaration(
	source: string,
	declarationName: string,
	options: FixtureOptions = {},
): { type: ts.Type; node: ts.Node; walker: TypeWalker; cleanup: () => void } {
	const { checker, sourceFile, cleanup } = createFixtureProgram(source, options);
	const declarationNode = findDeclaration(sourceFile, declarationName);
	const type = checker.getTypeAtLocation(declarationNode.name);
	const walker = new TypeWalker(ts, checker);
	return { type, node: declarationNode, walker, cleanup };
}

export function walkDeclaration(
	source: string,
	declarationName: string,
	options: FixtureOptions = {},
): { field: Field; diagnostics: WalkDiagnostic[] } {
	const { type, node, walker, cleanup } = loadDeclaration(source, declarationName, options);
	try {
		return { field: walker.walk(type, node, false), diagnostics: walker.diagnostics };
	} finally {
		cleanup();
	}
}

/**
 * Prints synthetic nodes built with `ts.factory`/`Emitter` (which have no
 * real source file of their own), for snapshotting generated write/read
 * statements.
 */
export function printNodes(nodes: readonly ts.Node[]): string {
	const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
	const resultFile = ts.createSourceFile("printed.ts", "", ts.ScriptTarget.ES2019, false, ts.ScriptKind.TS);
	return nodes.map((node) => printer.printNode(ts.EmitHint.Unspecified, node, resultFile)).join("\n");
}
