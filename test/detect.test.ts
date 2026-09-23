import * as ts from "typescript";

import { getDataTypeBrand, getSurgeBrand, resolveFactoryName } from "../src/detect";
import { createFixtureProgram, findDeclaration } from "./harness";

/** Resolves the `ts.CallExpression` of the (assumed unique) top-level call statement named `callName`. */
function findCall(sourceFile: ts.SourceFile, callName: string): ts.CallExpression {
	let found: ts.CallExpression | undefined;
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callName) {
			found = node;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	if (!found) {
		throw new Error(`call to '${callName}' not found in test source`);
	}
	return found;
}

describe("resolveFactoryName", () => {
	test("resolves a direct call to createSerializer from @rbxts/surge", () => {
		const { checker, sourceFile, cleanup } = createFixtureProgram(
			`import { createSerializer } from "@rbxts/surge"; createSerializer<number>();`,
			{ surge: true },
		);
		try {
			const call = findCall(sourceFile, "createSerializer");
			expect(resolveFactoryName(ts, checker, call.expression)).toBe("createSerializer");
		} finally {
			cleanup();
		}
	});

	test("follows a re-export/alias through to the real declaration", () => {
		const { checker, sourceFile, cleanup } = createFixtureProgram(
			`import { createBinarySerializer as make } from "@rbxts/surge"; make<number>();`,
			{ surge: true },
		);
		try {
			const call = findCall(sourceFile, "make");
			expect(resolveFactoryName(ts, checker, call.expression)).toBe("createBinarySerializer");
		} finally {
			cleanup();
		}
	});

	test("rejects a same-named local declaration that isn't from @rbxts/surge", () => {
		const { checker, sourceFile, cleanup } = createFixtureProgram(
			`function createSerializer<T>(): void {} createSerializer<number>();`,
			{ surge: true },
		);
		try {
			const call = findCall(sourceFile, "createSerializer");
			expect(resolveFactoryName(ts, checker, call.expression)).toBeUndefined();
		} finally {
			cleanup();
		}
	});
});

describe("getDataTypeBrand / getSurgeBrand", () => {
	test("identifies a DataType.* brand by alias identity", () => {
		const { checker, sourceFile, cleanup } = createFixtureProgram(
			`import { DataType } from "@rbxts/surge"; interface T { n: DataType.u16; }`,
			{ surge: true },
		);
		try {
			const declarationNode = findDeclaration(sourceFile, "T");
			const prop = checker.getTypeAtLocation(declarationNode).getProperty("n")!;
			const propType = checker.getTypeOfSymbolAtLocation(prop, declarationNode);
			expect(getDataTypeBrand(propType)).toBe("u16");
		} finally {
			cleanup();
		}
	});

	test("a structurally identical brand-shaped type outside @rbxts/surge is not detected", () => {
		const { checker, sourceFile, cleanup } = createFixtureProgram(
			`type FakeU16 = number & { readonly _surge_u16?: never }; interface T { n: FakeU16; }`,
			{ surge: true },
		);
		try {
			const declarationNode = findDeclaration(sourceFile, "T");
			const prop = checker.getTypeAtLocation(declarationNode).getProperty("n")!;
			const propType = checker.getTypeOfSymbolAtLocation(prop, declarationNode);
			expect(getDataTypeBrand(propType)).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("unwraps Packed<T> to its inner type", () => {
		const { checker, sourceFile, cleanup } = createFixtureProgram(
			`import { DataType } from "@rbxts/surge"; interface Inner { a: boolean; } interface T { p: DataType.Packed<Inner>; }`,
			{ surge: true },
		);
		try {
			const declarationNode = findDeclaration(sourceFile, "T");
			const prop = checker.getTypeAtLocation(declarationNode).getProperty("p")!;
			const propType = checker.getTypeOfSymbolAtLocation(prop, declarationNode);
			const brand = getSurgeBrand(checker, propType);
			expect(brand?.name).toBe("Packed");
			expect(checker.typeToString(brand!.args[0])).toBe("Inner");
		} finally {
			cleanup();
		}
	});

	// A re-alias carries its own `aliasSymbol`, so alias identity alone misses
	// it; the `_surge_packed` brand property still identifies it.
	test("unwraps a re-aliased Packed<T> to its inner type", () => {
		const { checker, sourceFile, cleanup } = createFixtureProgram(
			`import { DataType } from "@rbxts/surge"; interface Inner { a: boolean; } type PackedInner = DataType.Packed<Inner>; interface T { p: PackedInner; }`,
			{ surge: true },
		);
		try {
			const declarationNode = findDeclaration(sourceFile, "T");
			const prop = checker.getTypeAtLocation(declarationNode).getProperty("p")!;
			const propType = checker.getTypeOfSymbolAtLocation(prop, declarationNode);
			const brand = getSurgeBrand(checker, propType);
			expect(brand?.name).toBe("Packed");
			expect(checker.typeToString(brand!.args[0])).toBe("Inner");
		} finally {
			cleanup();
		}
	});

	test("a _surge_packed property declared outside @rbxts/surge is not detected", () => {
		const { checker, sourceFile, cleanup } = createFixtureProgram(
			`interface Inner { a: boolean; } type Fake = Inner & { readonly _surge_packed?: [Inner] }; interface T { p: Fake; }`,
			{ surge: true },
		);
		try {
			const declarationNode = findDeclaration(sourceFile, "T");
			const prop = checker.getTypeAtLocation(declarationNode).getProperty("p")!;
			const propType = checker.getTypeOfSymbolAtLocation(prop, declarationNode);
			expect(getSurgeBrand(checker, propType)).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("reads Length<T, L>'s two type arguments", () => {
		const { checker, sourceFile, cleanup } = createFixtureProgram(
			`import { DataType } from "@rbxts/surge"; interface T { p: DataType.Length<Array<string>, DataType.u16>; }`,
			{ surge: true },
		);
		try {
			const declarationNode = findDeclaration(sourceFile, "T");
			const prop = checker.getTypeAtLocation(declarationNode).getProperty("p")!;
			const propType = checker.getTypeOfSymbolAtLocation(prop, declarationNode);
			const brand = getSurgeBrand(checker, propType);
			expect(brand?.name).toBe("Length");
			expect(getDataTypeBrand(brand!.args[1])).toBe("u16");
		} finally {
			cleanup();
		}
	});

	test("a _surge_length property declared outside @rbxts/surge is not detected", () => {
		const { checker, sourceFile, cleanup } = createFixtureProgram(
			`type Fake = string[] & { readonly _surge_length?: [string[], number] }; interface T { p: Fake; }`,
			{ surge: true },
		);
		try {
			const declarationNode = findDeclaration(sourceFile, "T");
			const prop = checker.getTypeAtLocation(declarationNode).getProperty("p")!;
			const propType = checker.getTypeOfSymbolAtLocation(prop, declarationNode);
			expect(getSurgeBrand(checker, propType)).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	// A composition flattens into an intersection carrying both brand
	// properties, so a `_surge_packed` check that ran before alias identity
	// would answer "Packed" here and drop the length with no error.
	test("Length<Packed<T>, L> resolves outermost-first, not by brand property", () => {
		const { checker, sourceFile, cleanup } = createFixtureProgram(
			`import { DataType } from "@rbxts/surge"; interface Inner { a: boolean; } interface T { p: DataType.Length<DataType.Packed<Array<Inner>>, DataType.u16>; }`,
			{ surge: true },
		);
		try {
			const declarationNode = findDeclaration(sourceFile, "T");
			const prop = checker.getTypeAtLocation(declarationNode).getProperty("p")!;
			const propType = checker.getTypeOfSymbolAtLocation(prop, declarationNode);
			// The premise: the composition flattens, so both brand properties
			// are on the one type and only the alias says which is outermost.
			expect(propType.getProperty("_surge_packed")).toBeDefined();
			expect(propType.getProperty("_surge_length")).toBeDefined();
			expect(getSurgeBrand(checker, propType)?.name).toBe("Length");
		} finally {
			cleanup();
		}
	});

	// A re-alias has no brand alias left, so both brand properties are all
	// there is to go on. The outer brand recorded the whole inner brand and
	// still carries its property; the inner one recorded its arguments before
	// the outer was applied.
	test("a re-aliased Length<Packed<T>, L> resolves to Length", () => {
		const { checker, sourceFile, cleanup } = createFixtureProgram(
			`import { DataType } from "@rbxts/surge"; interface Inner { a: boolean; } type Bounded = DataType.Length<DataType.Packed<Array<Inner>>, DataType.u16>; interface T { p: Bounded; }`,
			{ surge: true },
		);
		try {
			const declarationNode = findDeclaration(sourceFile, "T");
			const prop = checker.getTypeAtLocation(declarationNode).getProperty("p")!;
			const propType = checker.getTypeOfSymbolAtLocation(prop, declarationNode);
			expect(getSurgeBrand(checker, propType)?.name).toBe("Length");
		} finally {
			cleanup();
		}
	});

	test("a re-aliased Packed<Length<T, L>> resolves to Packed", () => {
		const { checker, sourceFile, cleanup } = createFixtureProgram(
			`import { DataType } from "@rbxts/surge"; interface Inner { a: boolean; } type PackedBounded = DataType.Packed<DataType.Length<Array<Inner>, DataType.u16>>; interface T { p: PackedBounded; }`,
			{ surge: true },
		);
		try {
			const declarationNode = findDeclaration(sourceFile, "T");
			const prop = checker.getTypeAtLocation(declarationNode).getProperty("p")!;
			const propType = checker.getTypeOfSymbolAtLocation(prop, declarationNode);
			expect(getSurgeBrand(checker, propType)?.name).toBe("Packed");
		} finally {
			cleanup();
		}
	});
});
