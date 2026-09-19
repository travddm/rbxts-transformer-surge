import type ts from "typescript";

import { resolveFactoryName } from "./detect";
import { Emitter, importAlias } from "./emit";
import { TypeWalker } from "./walk";

/**
 * `rbxts-transformer-surge`'s entry point. Registered in a project's
 * `tsconfig.json` `plugins` by package name (see docs/testing.md), roblox-ts
 * loads this as a `type: "program"` (the default) plugin and calls it with
 * `(program, config, { ts })` -- confirmed via
 * `createTransformerList.js`/`getTransformerFromFactory` in roblox-ts's own
 * source, matching docs/transformer.md's "Why this is portable" section.
 * Relying on the injected `ts` here (rather than importing our own
 * `typescript` dependency) is what keeps this transformer from being a
 * second source of TypeScript-version drift against whatever roblox-ts
 * itself bundles.
 */
export default function transform(program: ts.Program, _config: unknown, extras: { ts: typeof ts }) {
	const typescript = extras.ts;
	const checker = program.getTypeChecker();

	return (ctx: ts.TransformationContext) => {
		return (sourceFile: ts.SourceFile): ts.SourceFile => {
			const usedImports = new Set<string>();

			// `addDiagnostic` is internal to TypeScript (absent from
			// `typescript.d.ts`). roblox-ts adds what it collects to its own
			// diagnostics and stops the build before emit when any is an error
			// (`compileFiles.js`), so the user sees a file and position instead
			// of a Node stack trace. The string `code` follows roblox-ts's own
			// diagnostics, which print as "error TS roblox-ts: ...".
			function report(node: ts.Node, messageText: string): void {
				(ctx as unknown as { addDiagnostic(diagnostic: ts.DiagnosticWithLocation): void }).addDiagnostic({
					category: typescript.DiagnosticCategory.Error,
					code: " surge" as unknown as number,
					file: sourceFile,
					start: node.getStart(sourceFile),
					length: node.getWidth(sourceFile),
					messageText,
				});
			}

			function visit(node: ts.Node): ts.Node {
				if (typescript.isCallExpression(node)) {
					const factoryName = resolveFactoryName(typescript, checker, node.expression);
					if (factoryName) {
						if (node.typeArguments?.length === 1) {
							return buildReplacement(factoryName, node, node.typeArguments[0]);
						}
						report(
							node,
							`${factoryName}() needs an explicit type argument, for example "${factoryName}<MyType>()" -- ` +
								`the type is not inferred from the variable the result is assigned to.`,
						);
						return node;
					}
				}
				return typescript.visitEachChild(node, visit, ctx);
			}

			function surgeCall(name: string, args: ts.Expression[]): ts.Expression {
				usedImports.add(name);
				return ctx.factory.createCallExpression(
					ctx.factory.createIdentifier(importAlias(name)),
					undefined,
					args,
				);
			}

			function buildReplacement(
				factoryName: string,
				node: ts.CallExpression,
				typeArgumentNode: ts.TypeNode,
			): ts.Expression {
				const f = ctx.factory;
				const type = checker.getTypeFromTypeNode(typeArgumentNode);

				const walker = new TypeWalker(typescript, checker);
				const rootField = walker.walk(type, node, false);
				if (walker.diagnostics.length > 0) {
					for (const diagnostic of walker.diagnostics) {
						report(diagnostic.node, diagnostic.message);
					}
					// Left untransformed: the diagnostics fail the build before emit.
					return node;
				}

				const emitter = new Emitter(typescript, f, walker.getHelperFields());

				const valueParam = f.createParameterDeclaration(
					undefined,
					undefined,
					"value",
					undefined,
					typeArgumentNode,
					undefined,
				);
				const writeBody: ts.Statement[] = [
					f.createExpressionStatement(surgeCall("beginWrite", [])),
					f.createExpressionStatement(surgeCall("beginWriteBlobs", [])),
				];
				emitter.beginFunction();
				emitter.writeField(rootField, f.createIdentifier("value"), writeBody);
				writeBody.push(
					f.createReturnStatement(
						f.createObjectLiteralExpression(
							[
								f.createPropertyAssignment("buffer", surgeCall("finishWrite", [])),
								f.createPropertyAssignment("blobs", surgeCall("finishWriteBlobs", [])),
							],
							false,
						),
					),
				);
				// An arrow function, not `createFunctionExpression`: roblox-ts treats a
				// function expression assigned as an object-literal property as a method
				// and injects an implicit `self` parameter, which would silently break
				// every call site that uses `Serializer<T>`'s declared arrow-typed
				// `serialize`/`deserialize` properties (those get called with `.`, not `:`).
				const serializeFn = f.createArrowFunction(
					undefined,
					undefined,
					[valueParam],
					undefined,
					f.createToken(typescript.SyntaxKind.EqualsGreaterThanToken),
					f.createBlock(writeBody, true),
				);

				const inputParam = f.createParameterDeclaration(
					undefined,
					undefined,
					"input",
					undefined,
					f.createTypeReferenceNode("buffer"),
					undefined,
				);
				const inputBlobsParam = f.createParameterDeclaration(
					undefined,
					undefined,
					"inputBlobs",
					f.createToken(typescript.SyntaxKind.QuestionToken),
					f.createTypeReferenceNode("Array", [f.createTypeReferenceNode("defined")]),
					undefined,
				);
				const readBody: ts.Statement[] = [
					f.createExpressionStatement(surgeCall("beginRead", [f.createIdentifier("input")])),
					f.createExpressionStatement(surgeCall("beginReadBlobs", [f.createIdentifier("inputBlobs")])),
				];
				emitter.beginFunction();
				const resultExpr = emitter.readField(rootField, readBody);
				readBody.push(f.createReturnStatement(resultExpr));
				const deserializeFn = f.createArrowFunction(
					undefined,
					undefined,
					[inputParam, inputBlobsParam],
					undefined,
					f.createToken(typescript.SyntaxKind.EqualsGreaterThanToken),
					f.createBlock(readBody, true),
				);

				let resultValue: ts.Expression;
				if (factoryName === "createSerializer") {
					resultValue = serializeFn;
				} else if (factoryName === "createDeserializer") {
					resultValue = deserializeFn;
				} else {
					resultValue = f.createObjectLiteralExpression(
						[
							f.createPropertyAssignment("serialize", serializeFn),
							f.createPropertyAssignment("deserialize", deserializeFn),
						],
						false,
					);
				}

				emitter.usedImports.forEach((name) => usedImports.add(name));

				const iifeBody = [...emitter.getHelperDecls(), f.createReturnStatement(resultValue)];
				const iife = f.createCallExpression(
					f.createFunctionExpression(
						undefined,
						undefined,
						undefined,
						undefined,
						[],
						undefined,
						f.createBlock(iifeBody, true),
					),
					undefined,
					[],
				);
				return iife;
			}

			const visited = typescript.visitEachChild(sourceFile, visit, ctx);
			if (usedImports.size === 0) {
				return visited;
			}

			const f = ctx.factory;
			const importDecl = f.createImportDeclaration(
				undefined,
				f.createImportClause(
					false,
					undefined,
					f.createNamedImports(
						[...usedImports]
							.sort()
							.map((name) =>
								f.createImportSpecifier(
									false,
									f.createIdentifier(name),
									f.createIdentifier(importAlias(name)),
								),
							),
					),
				),
				f.createStringLiteral("@rbxts/surge"),
			);
			return f.updateSourceFile(visited, [importDecl, ...visited.statements]);
		};
	};
}
