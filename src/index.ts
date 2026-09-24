import type ts from "typescript";

import { type FactoryName, resolveFactoryName } from "./detect";
import { Emitter, importAlias } from "./emit";
import { TypeWalker } from "./walk";

/**
 * `rbxts-transformer-surge`'s entry point. Registered in a project's
 * `tsconfig.json` `plugins` by package name (see docs/testing.md), roblox-ts
 * loads this as a `type: "program"` (the default) plugin and calls it with
 * `(program, config, { ts })` -- confirmed via
 * `createTransformerList.js`/`getTransformerFromFactory` in roblox-ts's own
 * source, matching docs/research/compile-time-specialization.md in the surge repo.
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

			/**
			 * Move the file's leading comments onto the injected import.
			 *
			 * Luau honours a `--!` hot comment only ahead of the first line of
			 * code, and roblox-ts hoists one above its own banner only while it
			 * still leads the first statement in the emitted list
			 * (`transformSourceFile.js`). The injected import takes that
			 * position, so without this a user's `//!native` or `//!optimize 2`
			 * is emitted behind `local TS = require(...)`, where Luau ignores
			 * it. Every leading comment moves, not only the directives, so that
			 * a file header keeps its order.
			 */
			function hoistLeadingComments(importDecl: ts.ImportDeclaration, first: ts.Statement | undefined): void {
				if (!first) {
					return;
				}
				const ranges = typescript.getLeadingCommentRanges(sourceFile.text, first.pos) ?? [];
				if (ranges.length === 0) {
					return;
				}
				typescript.setSyntheticLeadingComments(
					importDecl,
					ranges.map((range) => ({
						kind: range.kind,
						// A synthesized comment carries its text without the
						// `//` or `/* */` that delimits it in the source.
						text: sourceFile.text.slice(
							range.pos + 2,
							range.kind === typescript.SyntaxKind.SingleLineCommentTrivia ? range.end : range.end - 2,
						),
						hasTrailingNewLine: true,
						pos: -1,
						end: -1,
					})),
				);
				typescript.setEmitFlags(first, typescript.EmitFlags.NoLeadingComments);
			}

			/**
			 * The `checks` of the factory's options argument (Transformer Design
			 * §7), or `undefined` when the call site cannot be read.
			 *
			 * Only an object literal with literal property values is accepted. A
			 * value computed at run time cannot decide what is emitted at compile
			 * time, and defaulting it to `false` would leave a boundary a user
			 * meant to protect silently unchecked, so it is a diagnostic instead.
			 */
			function readChecksOption(factoryName: FactoryName, node: ts.CallExpression): boolean | undefined {
				const [options, ...rest] = node.arguments;
				if (options === undefined) {
					return false;
				}
				if (rest.length > 0) {
					report(node, `${factoryName}() takes one options argument at most.`);
					return undefined;
				}
				// `createSerializer` has no read path, so there is nothing for
				// `checks` to do there and accepting it would say otherwise.
				if (factoryName === "createSerializer") {
					report(
						options,
						`createSerializer() takes no options: "checks" is read-side, so it belongs on ` +
							`createDeserializer() or createBinarySerializer().`,
					);
					return undefined;
				}
				if (!typescript.isObjectLiteralExpression(options)) {
					report(
						options,
						`${factoryName}()'s options must be written as an object literal at the call site.`,
					);
					return undefined;
				}
				let checks = false;
				for (const property of options.properties) {
					if (
						!typescript.isPropertyAssignment(property) ||
						!typescript.isIdentifier(property.name) ||
						property.name.text !== "checks"
					) {
						report(property, `${factoryName}()'s options take one property, "checks".`);
						return undefined;
					}
					const value = property.initializer.kind;
					if (value !== typescript.SyntaxKind.TrueKeyword && value !== typescript.SyntaxKind.FalseKeyword) {
						report(
							property.initializer,
							`"checks" must be written as "true" or "false" at the call site -- it decides what is ` +
								`emitted, so it cannot be a value the game works out as it runs.`,
						);
						return undefined;
					}
					checks = value === typescript.SyntaxKind.TrueKeyword;
				}
				return checks;
			}

			function visit(node: ts.Node): ts.Node {
				if (typescript.isCallExpression(node)) {
					const factoryName = resolveFactoryName(typescript, checker, node.expression);
					if (factoryName) {
						if (node.typeArguments?.length === 1) {
							const checks = readChecksOption(factoryName, node);
							// Left untransformed: the diagnostic fails the build before emit.
							return checks === undefined
								? node
								: buildReplacement(factoryName, node, node.typeArguments[0], checks);
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
				checks: boolean,
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

				const emitter = new Emitter(typescript, f, walker.getHelperFields(), checks);

				const valueParam = f.createParameterDeclaration(
					undefined,
					undefined,
					"value",
					undefined,
					typeArgumentNode,
					undefined,
				);
				// Both bodies are emitted before either is assembled, because
				// whether this shape uses the blob side channel at all is only
				// known once they are: the emitter records `pushBlob`/`nextBlob`
				// in `usedImports` as it emits them, including from inside any
				// recursion helper it generates on the way. A shape with no blob
				// field -- which is most of them -- then pays nothing for the
				// channel: no `beginWriteBlobs` table allocation per call, and
				// no `finishWriteBlobs`/`beginReadBlobs` call either.
				emitter.beginFunction();
				const writeStatements: ts.Statement[] = [];
				emitter.writeField(rootField, f.createIdentifier("value"), writeStatements);

				emitter.beginFunction();
				const readStatements: ts.Statement[] = [];
				const resultExpr = emitter.readField(rootField, readStatements);

				const usesBlobs = emitter.usedImports.has("pushBlob") || emitter.usedImports.has("nextBlob");

				const writeBody: ts.Statement[] = [...emitter.beginWriteStatements()];
				if (usesBlobs) {
					writeBody.push(f.createExpressionStatement(surgeCall("beginWriteBlobs", [])));
				}
				writeBody.push(...writeStatements);
				writeBody.push(
					f.createReturnStatement(
						f.createObjectLiteralExpression(
							[
								f.createPropertyAssignment("buffer", emitter.finishWriteExpression()),
								f.createPropertyAssignment(
									"blobs",
									usesBlobs
										? surgeCall("finishWriteBlobs", [])
										: // `Serializer<T>` still declares the property, so it
											// needs a value; an empty literal is what the channel
											// would have returned. Asserted, because an empty array
											// literal is `never[]`.
											f.createAsExpression(
												f.createArrayLiteralExpression([]),
												f.createTypeReferenceNode("Array", [
													f.createTypeReferenceNode("defined"),
												]),
											),
								),
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
					// The parameter stays, because `Serializer<T>` declares it and a
					// caller may pass one; an underscore keeps it from failing a
					// consumer's `noUnusedParameters` when nothing reads it.
					usesBlobs ? "inputBlobs" : "_inputBlobs",
					f.createToken(typescript.SyntaxKind.QuestionToken),
					f.createTypeReferenceNode("Array", [f.createTypeReferenceNode("defined")]),
					undefined,
				);
				const readBody: ts.Statement[] = [...emitter.beginReadStatements(f.createIdentifier("input"))];
				if (usesBlobs) {
					readBody.push(
						f.createExpressionStatement(surgeCall("beginReadBlobs", [f.createIdentifier("inputBlobs")])),
					);
				}
				readBody.push(...readStatements);
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

				const needsWrite = factoryName !== "createDeserializer";
				const needsRead = factoryName !== "createSerializer";
				const iifeBody = [
					...(needsWrite ? emitter.writeStateDecls() : []),
					...(needsRead ? emitter.readStateDecls() : []),
					...emitter.getHelperDecls(),
					f.createReturnStatement(resultValue),
				];
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
			hoistLeadingComments(importDecl, visited.statements[0]);
			return f.updateSourceFile(visited, [importDecl, ...visited.statements]);
		};
	};
}
