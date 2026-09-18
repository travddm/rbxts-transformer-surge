import * as ts from "typescript";

import { getDataTypeBrand, getPackedInnerType, resolveFactoryName } from "../src/detect";
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

describe("getDataTypeBrand / getPackedInnerType", () => {
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
			const inner = getPackedInnerType(propType);
			expect(inner).toBeDefined();
			expect(checker.typeToString(inner!)).toBe("Inner");
		} finally {
			cleanup();
		}
	});
});
