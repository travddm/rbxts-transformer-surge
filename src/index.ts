import type ts from "typescript";

import { type FactoryName, declaredSerializedCarriesBlobs, resolveFactoryName } from "./detect";
import { ABI_MODULE, Emitter, importAlias } from "./emit";
import { TypeWalker } from "./walk";

/**
 * `rbxts-transformer-surge`'s entry point. Registered in a project's
 * `tsconfig.json` `plugins` by package name (see docs/getting-started.md in
 * the surge repo), roblox-ts loads this as a `type: "program"` (the default)
 * plugin and calls it with `(program, config, { ts })` -- confirmed via
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
			 * The `readChecks` and `writeChecks` of the factory's options argument
			 * (Transformer 3.3 in docs/specs/transformer.md in the surge repo), or
			 * `undefined` when the call site cannot be read.
			 *
			 * Only an object literal with literal property values is accepted. A
			 * value computed at run time cannot decide what is emitted at compile
			 * time, and defaulting it to `false` would leave a boundary a user
			 * meant to protect silently unchecked, so it is a diagnostic instead.
			 * Each option belongs to one side, so a factory that has no such side
			 * does not take it: accepting it would say it does something.
			 */
			function readOptions(
				factoryName: FactoryName,
				node: ts.CallExpression,
			): { readChecks: boolean; writeChecks: boolean } | undefined {
				const result = { readChecks: false, writeChecks: false };
				const [options, ...rest] = node.arguments;
				if (options === undefined) {
					return result;
				}
				if (rest.length > 0) {
					report(node, `${factoryName}() takes one options argument at most.`);
					return undefined;
				}
				if (!typescript.isObjectLiteralExpression(options)) {
					report(
						options,
						`${factoryName}()'s options must be written as an object literal at the call site.`,
					);
					return undefined;
				}
				const accepted: ReadonlyArray<"readChecks" | "writeChecks"> =
					factoryName === "createSerializer"
						? ["writeChecks"]
						: factoryName === "createDeserializer"
							? ["readChecks"]
							: ["readChecks", "writeChecks"];
				const described = accepted.map((name) => `"${name}"`).join(" and ");
				for (const property of options.properties) {
					const name =
						typescript.isPropertyAssignment(property) && typescript.isIdentifier(property.name)
							? property.name.text
							: undefined;
					if (name !== "readChecks" && name !== "writeChecks") {
						report(property, `${factoryName}()'s options take ${described}.`);
						return undefined;
					}
					if (!accepted.includes(name)) {
						report(
							property,
							name === "readChecks"
								? `${factoryName}() has no read side, so it takes no "readChecks" -- that option ` +
										`belongs on createDeserializer() or createCodec().`
								: `${factoryName}() has no write side, so it takes no "writeChecks" -- that option ` +
										`belongs on createSerializer() or createCodec().`,
						);
						return undefined;
					}
					const value = (property as ts.PropertyAssignment).initializer;
					if (
						value.kind !== typescript.SyntaxKind.TrueKeyword &&
						value.kind !== typescript.SyntaxKind.FalseKeyword
					) {
						report(
							value,
							`"${name}" must be written as "true" or "false" at the call site -- it decides what is ` +
								`emitted, so it cannot be a value the game works out as it runs.`,
						);
						return undefined;
					}
					result[name] = value.kind === typescript.SyntaxKind.TrueKeyword;
				}
				return result;
			}

			function visit(node: ts.Node): ts.Node {
				if (typescript.isCallExpression(node)) {
					const factoryName = resolveFactoryName(typescript, checker, node.expression);
					if (factoryName) {
						if (node.typeArguments?.length === 1) {
							const options = readOptions(factoryName, node);
							// Left untransformed: the diagnostic fails the build before emit.
							return options === undefined
								? node
								: buildReplacement(factoryName, node, node.typeArguments[0], options);
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
				factoryName: FactoryName,
				node: ts.CallExpression,
				typeArgumentNode: ts.TypeNode,
				options: { readChecks: boolean; writeChecks: boolean },
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

				// Only the sides the factory returns are emitted, so the closure
				// declares, and the file imports, only what those sides use.
				const needsWrite = factoryName !== "createDeserializer";
				const needsRead = factoryName !== "createSerializer";
				const emitter = new Emitter(typescript, f, walker.getHelperFields(), {
					...options,
					sides: { write: needsWrite, read: needsRead },
				});

				const valueParam = f.createParameterDeclaration(
					undefined,
					undefined,
					"value",
					undefined,
					typeArgumentNode,
					undefined,
				);
				// The bodies are emitted before either is assembled, because
				// whether this shape uses the blob side channel at all is only
				// known once they are: the emitter records `pushBlob`/`nextBlob`
				// in `usedImports` as it emits them, including from inside any
				// recursion helper it generates on the way. A shape with no blob
				// field -- which is most of them -- then pays nothing for the
				// channel: no `beginWriteBlobs` table allocation per call, and
				// no `finishWriteBlobs`/`beginReadBlobs` call either.
				const writeStatements: ts.Statement[] = [];
				if (needsWrite) {
					emitter.beginFunction();
					emitter.writeField(rootField, f.createIdentifier("value"), writeStatements);
				}

				// The package's `Serialized<T>` decides whether `serialize` returns,
				// and `deserialize` takes, the buffer alone or a table with a
				// `blobs` array. It gives the array wherever it cannot tell, which
				// costs an empty one; a blob it misses would be dropped by a caller
				// that follows the type, so that is a diagnostic below.
				const serializedCarriesBlobs = declaredSerializedCarriesBlobs(typescript, checker, node, factoryName);

				const readStatements: ts.Statement[] = [];
				let resultExpr: ts.Expression | undefined;
				// Under `readChecks`, the two locals that hold a table input's parts
				// once its shape is checked. Declared ahead of the body, so they count
				// against its locals (Transformer 5.8).
				let tableParts: { buffer: ts.Identifier; blobs: ts.Identifier } | undefined;
				if (needsRead) {
					emitter.beginFunction();
					if (options.readChecks && serializedCarriesBlobs) {
						tableParts = { buffer: emitter.fresh("inputBuffer"), blobs: emitter.fresh("inputBlobs") };
					}
					resultExpr = emitter.readField(rootField, readStatements);
				}

				const usesBlobs = emitter.usedImports.has("pushBlob") || emitter.usedImports.has("nextBlob");

				if (usesBlobs && !serializedCarriesBlobs) {
					report(
						node,
						`"${checker.typeToString(type)}" holds a value that goes into "blobs", but the result type ` +
							`@rbxts/surge declares for it is the buffer alone. The two disagree, which is a surge bug; ` +
							`please report it with this type.`,
					);
					return node;
				}

				// Built only for a side the factory returns: assembling a side
				// registers its imports, such as `finishWrite` for the write side.
				const buildSerialize = (): ts.ArrowFunction => {
					const writeBody: ts.Statement[] = [...emitter.beginWriteStatements()];
					if (usesBlobs) {
						writeBody.push(f.createExpressionStatement(surgeCall("beginWriteBlobs", [])));
					}
					writeBody.push(...writeStatements);
					const bytes = emitter.finishWriteExpression();
					let result: ts.Expression = bytes;
					if (serializedCarriesBlobs) {
						// A shape the declared result gives an array but that never fills
						// one returns it empty. Asserted, because an empty array literal is
						// `never[]`.
						const blobs = usesBlobs
							? surgeCall("finishWriteBlobs", [])
							: f.createAsExpression(
									f.createArrayLiteralExpression([]),
									f.createTypeReferenceNode("Array", [f.createTypeReferenceNode("defined")]),
								);
						result = f.createObjectLiteralExpression(
							[f.createPropertyAssignment("buffer", bytes), f.createPropertyAssignment("blobs", blobs)],
							false,
						);
					}
					writeBody.push(f.createReturnStatement(result));
					// An arrow function, not `createFunctionExpression`: roblox-ts treats a
					// function expression assigned as an object-literal property as a method
					// and injects an implicit `self` parameter, which would silently break
					// every call site that uses `Codec<T>`'s declared arrow-typed
					// `serialize`/`deserialize` properties (those get called with `.`, not `:`).
					return f.createArrowFunction(
						undefined,
						undefined,
						[valueParam],
						undefined,
						f.createToken(typescript.SyntaxKind.EqualsGreaterThanToken),
						f.createBlock(writeBody, true),
					);
				};

				const buildDeserialize = (): ts.ArrowFunction => {
					if (options.readChecks) {
						return buildCheckedDeserialize();
					}
					// `deserialize` takes what `serialize` returned. A shape that reads
					// neither bytes nor blobs, such as one made only of literals, reads
					// nothing of it; an underscore keeps the parameter from failing a
					// consumer's `noUnusedParameters`.
					const input = f.createIdentifier(emitter.usesReadBytes || usesBlobs ? "input" : "_input");
					const inputParam = f.createParameterDeclaration(
						undefined,
						undefined,
						input,
						undefined,
						serializedCarriesBlobs
							? f.createTypeLiteralNode([
									f.createPropertySignature(
										undefined,
										"buffer",
										undefined,
										f.createTypeReferenceNode("buffer"),
									),
									f.createPropertySignature(
										undefined,
										"blobs",
										undefined,
										f.createTypeReferenceNode("Array", [f.createTypeReferenceNode("defined")]),
									),
								])
							: f.createTypeReferenceNode("buffer"),
						undefined,
					);
					const readBody: ts.Statement[] = [
						...emitter.beginReadStatements(
							serializedCarriesBlobs ? f.createPropertyAccessExpression(input, "buffer") : input,
						),
					];
					if (usesBlobs) {
						readBody.push(
							f.createExpressionStatement(
								surgeCall("beginReadBlobs", [f.createPropertyAccessExpression(input, "blobs")]),
							),
						);
					}
					readBody.push(...readStatements);
					// Asserted as the type argument, which gives the value `T` as its
					// contextual type: inferred instead, a literal in an object
					// literal widens to `string` or `number`, and the result is not
					// assignable to the caller's own type. An assertion rather than a
					// declared return type, because the read side builds some values
					// with a wider type than `T` names but comparable to it, such as
					// a string enum's values as plain literals, or a blob as
					// `defined`.
					readBody.push(f.createReturnStatement(f.createAsExpression(resultExpr!, typeArgumentNode)));
					return f.createArrowFunction(
						undefined,
						undefined,
						[inputParam],
						undefined,
						f.createToken(typescript.SyntaxKind.EqualsGreaterThanToken),
						f.createBlock(readBody, true),
					);
				};

				/**
				 * Under `readChecks`, `deserialize` takes `unknown`, so a caller can
				 * pass what a remote delivered without checking it first (Runtime API
				 * 3.14). Before the body runs, it rejects anything that is not the
				 * `Serialized<T>` the call site declares: a buffer, or a table whose
				 * `buffer` is a buffer and whose `blobs` is a table (Runtime API 4.11).
				 */
				const buildCheckedDeserialize = (): ts.ArrowFunction => {
					const input = f.createIdentifier("input");
					const isNot = (value: ts.Expression, tag: string) =>
						f.createLogicalNot(emitter.callLocal("typeIs", [value, f.createStringLiteral(tag)]));
					const readBody: ts.Statement[] = [];
					if (tableParts) {
						const message =
							"deserialize was given something other than a table of a buffer and a blobs array";
						const part = (local: ts.Identifier, name: string) =>
							emitter.constStatement(
								local,
								f.createPropertyAccessExpression(
									f.createParenthesizedExpression(
										f.createAsExpression(
											input,
											f.createTypeLiteralNode([
												f.createPropertySignature(
													undefined,
													name,
													f.createToken(typescript.SyntaxKind.QuestionToken),
													f.createKeywordTypeNode(typescript.SyntaxKind.UnknownKeyword),
												),
											]),
										),
									),
									name,
								),
							);
						readBody.push(
							emitter.throwIf(isNot(input, "table"), message),
							part(tableParts.buffer, "buffer"),
							part(tableParts.blobs, "blobs"),
							emitter.throwIf(
								f.createLogicalOr(isNot(tableParts.buffer, "buffer"), isNot(tableParts.blobs, "table")),
								message,
							),
							...emitter.beginReadStatements(tableParts.buffer),
						);
						if (usesBlobs) {
							readBody.push(
								f.createExpressionStatement(
									surgeCall("beginReadBlobs", [
										f.createAsExpression(
											tableParts.blobs,
											f.createTypeReferenceNode("Array", [f.createTypeReferenceNode("defined")]),
										),
									]),
								),
							);
						}
					} else {
						readBody.push(
							emitter.throwIf(
								isNot(input, "buffer"),
								"deserialize was given something other than a buffer",
							),
							...emitter.beginReadStatements(input),
						);
					}
					readBody.push(...readStatements);
					readBody.push(f.createReturnStatement(f.createAsExpression(resultExpr!, typeArgumentNode)));
					return f.createArrowFunction(
						undefined,
						undefined,
						[
							f.createParameterDeclaration(
								undefined,
								undefined,
								input,
								undefined,
								f.createKeywordTypeNode(typescript.SyntaxKind.UnknownKeyword),
								undefined,
							),
						],
						undefined,
						f.createToken(typescript.SyntaxKind.EqualsGreaterThanToken),
						f.createBlock(readBody, true),
					);
				};

				let resultValue: ts.Expression;
				if (factoryName === "createSerializer") {
					resultValue = buildSerialize();
				} else if (factoryName === "createDeserializer") {
					resultValue = buildDeserialize();
				} else {
					resultValue = f.createObjectLiteralExpression(
						[
							f.createPropertyAssignment("serialize", buildSerialize()),
							f.createPropertyAssignment("deserialize", buildDeserialize()),
						],
						false,
					);
				}

				emitter.usedImports.forEach((name) => usedImports.add(name));

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
				f.createStringLiteral(ABI_MODULE),
			);
			hoistLeadingComments(importDecl, visited.statements[0]);
			return f.updateSourceFile(visited, [importDecl, ...visited.statements]);
		};
	};
}
