import type ts from "typescript";

import type { Field, NumWidth, ObjectFieldEntry } from "./field";

const WIDTH_BYTES: Record<NumWidth, number> = {
	f32: 4,
	f64: 8,
	u8: 1,
	u16: 2,
	u32: 4,
	i8: 1,
	i16: 2,
	i32: 4,
};

/**
 * Turns a `Field` IR tree into `write`/`read` statements (Transformer
 * Design §5). Every field, fixed or variable-size, is inlined in source
 * order with no runtime dispatch on kind -- the exception is a
 * self-referential field (an `object` carrying `helperName`, or a bare
 * `recursiveRef`), which compiles to a call into a named module-scoped
 * helper instead (§6); `ensureHelper` generates that helper's body lazily,
 * the first time it's actually referenced.
 */
export class Emitter {
	private tempCounter = 0;
	public readonly usedImports = new Set<string>();
	private readonly generatedHelpers = new Set<string>();
	private readonly helperDecls: ts.Statement[] = [];
	private readonly enumTables = new Map<string, { itemsName: string; indexName: string }>();
	private enumTableCounter = 0;

	public constructor(
		private readonly ts_: typeof ts,
		private readonly factory: ts.NodeFactory,
		private readonly helperFields: ReadonlyMap<string, Field>,
	) {}

	private fresh(base: string): ts.Identifier {
		this.tempCounter += 1;
		return this.factory.createIdentifier(`${base}${this.tempCounter}`);
	}

	/** Calls a real `@rbxts/surge` export, tracked so the file-level import statement includes it. */
	private call(name: string, args: ts.Expression[]): ts.CallExpression {
		this.usedImports.add(name);
		return this.factory.createCallExpression(this.factory.createIdentifier(name), undefined, args);
	}

	/** Calls a locally-generated helper function (never an import from @rbxts/surge). */
	private callLocal(name: string, args: ts.Expression[]): ts.CallExpression {
		return this.factory.createCallExpression(this.factory.createIdentifier(name), undefined, args);
	}

	private num(n: number): ts.Expression {
		return this.factory.createNumericLiteral(n);
	}

	private constStatement(name: ts.Identifier, initializer: ts.Expression): ts.Statement {
		return this.factory.createVariableStatement(
			undefined,
			this.factory.createVariableDeclarationList(
				[this.factory.createVariableDeclaration(name, undefined, undefined, initializer)],
				this.ts_.NodeFlags.Const,
			),
		);
	}

	/**
	 * Binds a side-effecting read expression (one that advances a cursor when
	 * evaluated, rather than being preceded by the statement that reserves its
	 * bytes) to a `const` in statement order, and returns the identifier in
	 * its place. `readObjectInline` pushes each field's read statements in
	 * field order but evaluates each field's returned expression later,
	 * inside the object literal -- sound only if every such expression is
	 * side-effect free. A bare `object`/`recursiveRef` helper call and a
	 * `blob`'s `nextBlob()` are not, so their `readField` cases route through
	 * this instead of returning the call expression directly (see
	 * read-order-side-effects.md).
	 */
	private bindSideEffect(expr: ts.Expression, out: ts.Statement[]): ts.Expression {
		const tmp = this.fresh("val");
		out.push(this.constStatement(tmp, expr));
		return tmp;
	}

	private destructureAlloc(
		fnName: "alloc" | "readAlloc",
		size: number,
	): { buf: ts.Identifier; pos: ts.Identifier; statement: ts.Statement } {
		const buf = this.fresh("buf");
		const pos = this.fresh("pos");
		const statement = this.factory.createVariableStatement(
			undefined,
			this.factory.createVariableDeclarationList(
				[
					this.factory.createVariableDeclaration(
						this.factory.createArrayBindingPattern([
							this.factory.createBindingElement(undefined, undefined, buf),
							this.factory.createBindingElement(undefined, undefined, pos),
						]),
						undefined,
						undefined,
						this.call(fnName, [this.num(size)]),
					),
				],
				this.ts_.NodeFlags.Const,
			),
		);
		return { buf, pos, statement };
	}

	/**
	 * Casts `expr` to `typeNode`, through `unknown` (never straight to `any`:
	 * roblox-ts refuses to compile a call or property access on an
	 * `any`-typed value -- confirmed by hitting exactly that compiler
	 * error). Needed wherever a union's static type doesn't have the
	 * specific variant's shape/properties (every variant branch of a
	 * tagged/guarded union): TypeScript still typechecks this generated
	 * code, and narrowing a union by an index computed at runtime isn't
	 * something its control-flow analysis can follow.
	 */
	private castTo(expr: ts.Expression, typeNode: ts.TypeNode): ts.Expression {
		const f = this.factory;
		return f.createAsExpression(
			f.createAsExpression(expr, f.createKeywordTypeNode(this.ts_.SyntaxKind.UnknownKeyword)),
			typeNode,
		);
	}

	/** `expr.size()` -- roblox-ts arrays and tuples have no `.length`; `size()` (compiling to `#expr`) is the real API. */
	private sizeOf(expr: ts.Expression): ts.Expression {
		return this.factory.createCallExpression(
			this.factory.createPropertyAccessExpression(expr, "size"),
			undefined,
			[],
		);
	}

	private bufferCall(method: string, args: ts.Expression[]): ts.Expression {
		return this.factory.createCallExpression(
			this.factory.createPropertyAccessExpression(this.factory.createIdentifier("buffer"), method),
			undefined,
			args,
		);
	}

	// ---- WRITE ----------------------------------------------------------

	public writeField(field: Field, value: ts.Expression, out: ts.Statement[]): void {
		const f = this.factory;
		switch (field.kind) {
			case "num": {
				const bytes = WIDTH_BYTES[field.width];
				const { buf, pos, statement } = this.destructureAlloc("alloc", bytes);
				out.push(statement);
				out.push(f.createExpressionStatement(this.bufferCall(`write${field.width}`, [buf, pos, value])));
				return;
			}
			case "bool": {
				const { buf, pos, statement } = this.destructureAlloc("alloc", 1);
				out.push(statement);
				out.push(
					f.createExpressionStatement(
						this.bufferCall("writeu8", [
							buf,
							pos,
							f.createConditionalExpression(value, undefined, this.num(1), undefined, this.num(0)),
						]),
					),
				);
				return;
			}
			case "str": {
				const s = this.fresh("s");
				out.push(this.constStatement(s, value));
				const lenExpr = f.createCallExpression(f.createPropertyAccessExpression(s, "size"), undefined, []);
				const { buf: lbuf, pos: lpos, statement: lstmt } = this.destructureAlloc("alloc", 4);
				out.push(lstmt);
				out.push(f.createExpressionStatement(this.bufferCall("writeu32", [lbuf, lpos, lenExpr])));
				const sbuf = this.fresh("buf");
				const spos = this.fresh("pos");
				out.push(
					f.createVariableStatement(
						undefined,
						f.createVariableDeclarationList(
							[
								f.createVariableDeclaration(
									f.createArrayBindingPattern([
										f.createBindingElement(undefined, undefined, sbuf),
										f.createBindingElement(undefined, undefined, spos),
									]),
									undefined,
									undefined,
									this.call("alloc", [lenExpr]),
								),
							],
							this.ts_.NodeFlags.Const,
						),
					),
				);
				out.push(f.createExpressionStatement(this.bufferCall("writestring", [sbuf, spos, s])));
				return;
			}
			case "vector3": {
				this.writeNum3(value, "X", "Y", "Z", "f32", out);
				return;
			}
			case "color3": {
				this.writeColor3(value, out);
				return;
			}
			case "cframe": {
				this.writeCFrame(value, out);
				return;
			}
			case "colorSequence": {
				this.writeSequence(value, "ColorSequence", out);
				return;
			}
			case "numberSequence": {
				this.writeSequence(value, "NumberSequence", out);
				return;
			}
			case "enum": {
				const bytes = field.members.length <= 256 ? 1 : 2;
				const { buf, pos, statement } = this.destructureAlloc("alloc", bytes);
				out.push(statement);
				out.push(
					f.createExpressionStatement(
						this.bufferCall(bytes === 1 ? "writeu8" : "writeu16", [
							buf,
							pos,
							this.enumIndexExpr(field.enumName, field.members, value),
						]),
					),
				);
				return;
			}
			case "object": {
				this.writeObject(field, value, out);
				return;
			}
			case "recursiveRef": {
				// `ensureHelper` is idempotent (guarded by `generatedHelpers`):
				// calling it here matters when this `recursiveRef` is the root
				// field itself (a directly recursive union/alias, not one reached
				// through an `object`'s `helperName`, which already calls it from
				// `writeObject`) -- without it, this call site would reference a
				// helper function that's never declared.
				this.ensureHelper(field.helperName);
				out.push(f.createExpressionStatement(this.callLocal(`${field.helperName}_write`, [value])));
				return;
			}
			case "array": {
				const arr = this.fresh("arr");
				out.push(this.constStatement(arr, value));
				const { buf, pos, statement } = this.destructureAlloc("alloc", 4);
				out.push(statement);
				out.push(f.createExpressionStatement(this.bufferCall("writeu32", [buf, pos, this.sizeOf(arr)])));
				const item = this.fresh("item");
				const body: ts.Statement[] = [];
				this.writeField(field.element, item, body);
				out.push(
					f.createForOfStatement(
						undefined,
						f.createVariableDeclarationList([f.createVariableDeclaration(item)], this.ts_.NodeFlags.Const),
						arr,
						f.createBlock(body, true),
					),
				);
				return;
			}
			case "tuple": {
				const tup = this.fresh("tup");
				out.push(this.constStatement(tup, value));
				field.fixed.forEach((elementField, i) => {
					this.writeField(elementField, f.createElementAccessExpression(tup, this.num(i)), out);
				});
				if (field.rest) {
					const fixedCount = field.fixed.length;
					const restCountExpr = f.createBinaryExpression(
						this.sizeOf(tup),
						this.ts_.SyntaxKind.MinusToken,
						this.num(fixedCount),
					);
					const { buf, pos, statement } = this.destructureAlloc("alloc", 4);
					out.push(statement);
					out.push(f.createExpressionStatement(this.bufferCall("writeu32", [buf, pos, restCountExpr])));
					const i = this.fresh("i");
					const body: ts.Statement[] = [];
					this.writeField(field.rest, f.createElementAccessExpression(tup, i), body);
					out.push(
						f.createForStatement(
							f.createVariableDeclarationList(
								[f.createVariableDeclaration(i, undefined, undefined, this.num(fixedCount))],
								this.ts_.NodeFlags.Let,
							),
							f.createBinaryExpression(i, this.ts_.SyntaxKind.LessThanToken, this.sizeOf(tup)),
							f.createPostfixIncrement(i),
							f.createBlock(body, true),
						),
					);
				}
				return;
			}
			case "dict": {
				this.writeDict(field, value, out);
				return;
			}
			case "optional": {
				// Bound to a local first, and narrowed via a direct `!== undefined`
				// check on that local (not a separately-computed boolean), which is
				// what lets TS narrow it to non-optional for the inner write below --
				// narrowing a repeated property-access expression like `value.x`
				// doesn't survive being routed through an intermediate variable.
				const tmp = this.fresh("opt");
				out.push(this.constStatement(tmp, value));
				const isPresent = (expr: ts.Expression) =>
					f.createBinaryExpression(
						expr,
						this.ts_.SyntaxKind.ExclamationEqualsEqualsToken,
						f.createIdentifier("undefined"),
					);
				const { buf, pos, statement } = this.destructureAlloc("alloc", 1);
				out.push(statement);
				out.push(
					f.createExpressionStatement(
						this.bufferCall("writeu8", [
							buf,
							pos,
							f.createConditionalExpression(
								isPresent(tmp),
								undefined,
								this.num(1),
								undefined,
								this.num(0),
							),
						]),
					),
				);
				const innerStatements: ts.Statement[] = [];
				this.writeField(field.inner, tmp, innerStatements);
				out.push(f.createIfStatement(isPresent(tmp), f.createBlock(innerStatements, true)));
				return;
			}
			case "literalConst": {
				return; // zero bytes -- known on both ends at compile time.
			}
			case "literal": {
				const { buf, pos, statement } = this.destructureAlloc("alloc", field.values.length <= 256 ? 1 : 2);
				out.push(statement);
				const method = field.values.length <= 256 ? "writeu8" : "writeu16";
				out.push(
					f.createExpressionStatement(
						this.bufferCall(method, [buf, pos, this.literalIndexExpr(field.values, value)]),
					),
				);
				return;
			}
			case "taggedUnion": {
				this.writeTaggedUnion(field, value, out);
				return;
			}
			case "guardedUnion": {
				this.writeGuardedUnion(field, value, out);
				return;
			}
			case "blob": {
				out.push(f.createExpressionStatement(this.call("pushBlob", [value])));
				return;
			}
		}
	}

	private writeNum3(value: ts.Expression, a: string, b: string, c: string, width: "f32", out: ts.Statement[]): void {
		const f = this.factory;
		const { buf, pos, statement } = this.destructureAlloc("alloc", 12);
		out.push(statement);
		out.push(
			f.createExpressionStatement(
				this.bufferCall(`write${width}`, [buf, pos, f.createPropertyAccessExpression(value, a)]),
			),
		);
		out.push(
			f.createExpressionStatement(
				this.bufferCall(`write${width}`, [
					buf,
					f.createBinaryExpression(pos, this.ts_.SyntaxKind.PlusToken, this.num(4)),
					f.createPropertyAccessExpression(value, b),
				]),
			),
		);
		out.push(
			f.createExpressionStatement(
				this.bufferCall(`write${width}`, [
					buf,
					f.createBinaryExpression(pos, this.ts_.SyntaxKind.PlusToken, this.num(8)),
					f.createPropertyAccessExpression(value, c),
				]),
			),
		);
	}

	private writeColor3(value: ts.Expression, out: ts.Statement[]): void {
		const f = this.factory;
		const { buf, pos, statement } = this.destructureAlloc("alloc", 3);
		out.push(statement);
		(["R", "G", "B"] as const).forEach((channel, i) => {
			const byteExpr = f.createCallExpression(
				f.createPropertyAccessExpression(f.createIdentifier("math"), "floor"),
				undefined,
				[
					f.createBinaryExpression(
						f.createPropertyAccessExpression(value, channel),
						this.ts_.SyntaxKind.AsteriskToken,
						this.num(255),
					),
				],
			);
			out.push(
				f.createExpressionStatement(
					this.bufferCall("writeu8", [
						buf,
						i === 0 ? pos : f.createBinaryExpression(pos, this.ts_.SyntaxKind.PlusToken, this.num(i)),
						byteExpr,
					]),
				),
			);
		});
	}

	private writeCFrame(value: ts.Expression, out: ts.Statement[]): void {
		const f = this.factory;
		this.writeNum3(f.createPropertyAccessExpression(value, "Position"), "X", "Y", "Z", "f32", out);
		const axis = this.fresh("axis");
		const angle = this.fresh("angle");
		out.push(
			f.createVariableStatement(
				undefined,
				f.createVariableDeclarationList(
					[
						f.createVariableDeclaration(
							f.createArrayBindingPattern([
								f.createBindingElement(undefined, undefined, axis),
								f.createBindingElement(undefined, undefined, angle),
							]),
							undefined,
							undefined,
							f.createCallExpression(
								f.createPropertyAccessExpression(value, "ToAxisAngle"),
								undefined,
								[],
							),
						),
					],
					this.ts_.NodeFlags.Const,
				),
			),
		);
		const rv = this.fresh("rv");
		out.push(
			this.constStatement(
				rv,
				f.createCallExpression(f.createPropertyAccessExpression(axis, "mul"), undefined, [angle]),
			),
		);
		this.writeNum3(rv, "X", "Y", "Z", "f32", out);
	}

	private writeSequence(value: ts.Expression, kind: "ColorSequence" | "NumberSequence", out: ts.Statement[]): void {
		const f = this.factory;
		const keypoints = this.fresh("keypoints");
		out.push(this.constStatement(keypoints, f.createPropertyAccessExpression(value, "Keypoints")));
		const { buf, pos, statement } = this.destructureAlloc("alloc", 1);
		out.push(statement);
		out.push(f.createExpressionStatement(this.bufferCall("writeu8", [buf, pos, this.sizeOf(keypoints)])));
		const kp = this.fresh("kp");
		const body: ts.Statement[] = [];
		const { buf: kbuf, pos: kpos, statement: kstmt } = this.destructureAlloc("alloc", 4);
		body.push(kstmt);
		body.push(
			f.createExpressionStatement(
				this.bufferCall("writef32", [kbuf, kpos, f.createPropertyAccessExpression(kp, "Time")]),
			),
		);
		if (kind === "ColorSequence") {
			const colorBody: ts.Statement[] = [];
			this.writeColor3(f.createPropertyAccessExpression(kp, "Value"), colorBody);
			body.push(...colorBody);
		} else {
			const { buf: vbuf, pos: vpos, statement: vstmt } = this.destructureAlloc("alloc", 4);
			body.push(vstmt);
			body.push(
				f.createExpressionStatement(
					this.bufferCall("writef32", [vbuf, vpos, f.createPropertyAccessExpression(kp, "Value")]),
				),
			);
		}
		out.push(
			f.createForOfStatement(
				undefined,
				f.createVariableDeclarationList([f.createVariableDeclaration(kp)], this.ts_.NodeFlags.Const),
				keypoints,
				f.createBlock(body, true),
			),
		);
	}

	private enumIndexExpr(enumName: string, members: ReadonlyArray<string>, value: ts.Expression): ts.Expression {
		const { indexName } = this.ensureEnumTable(enumName, members);
		const f = this.factory;
		return f.createNonNullExpression(
			f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier(indexName), "get"), undefined, [
				f.createPropertyAccessExpression(value, "Name"),
			]),
		);
	}

	/**
	 * Declares the write-side `{[name]: index}` map and read-side
	 * `EnumItem[]` for one enum field (Type Coverage in transformer.md
	 * promises an O(1) lookup, not the linear ternary chain this replaced --
	 * see enum-encoding.md), and returns their names, generating the
	 * declarations only the first time this exact member list is seen.
	 * Keyed by the full member list rather than `enumName`: a field using
	 * only a subset of an enum's members (still classified with that enum's
	 * `enumName`) needs its own table, indexed 0..subset.length-1, not the
	 * full enum's table.
	 *
	 * The index side is keyed by `value.Name` (a plain string), not the
	 * `EnumItem` value itself: confirmed by execution under Lune (the
	 * headless round-trip harness in `tests/`) that `Enum.<X>.<Y>` there
	 * does not return the same object on repeated access -- `a == b` is
	 * `true` (Lune gives `EnumItem` a custom equality), but raw Luau table
	 * indexing doesn't consult that, so `t[a]` after `t[b] = ...` misses.
	 * Real Roblox's `EnumItem`s are true engine singletons and wouldn't hit
	 * this, but nothing about `{[EnumItem]: index}` guarantees it, and a
	 * string key sidesteps the question entirely at no extra cost.
	 */
	private ensureEnumTable(
		enumName: string,
		members: ReadonlyArray<string>,
	): { itemsName: string; indexName: string } {
		const key = `${enumName}|${members.join("|")}`;
		const cached = this.enumTables.get(key);
		if (cached) {
			return cached;
		}
		this.enumTableCounter += 1;
		const base = `surge_${enumName}_${this.enumTableCounter}`;
		const entry = { itemsName: `${base}_items`, indexName: `${base}_index` };
		this.enumTables.set(key, entry);

		const f = this.factory;
		const enumMember = (name: string) =>
			f.createPropertyAccessExpression(
				f.createPropertyAccessExpression(f.createIdentifier("Enum"), enumName),
				name,
			);
		this.helperDecls.push(
			this.constStatement(
				f.createIdentifier(entry.itemsName),
				f.createArrayLiteralExpression(members.map(enumMember)),
			),
		);
		const indexEntries = members.map((name, i) =>
			f.createArrayLiteralExpression([f.createStringLiteral(name), this.num(i)]),
		);
		this.helperDecls.push(
			this.constStatement(
				f.createIdentifier(entry.indexName),
				f.createNewExpression(f.createIdentifier("Map"), undefined, [
					f.createArrayLiteralExpression(indexEntries),
				]),
			),
		);
		return entry;
	}

	private literalValueExpr(value: string | number | boolean): ts.Expression {
		const f = this.factory;
		if (typeof value === "string") return f.createStringLiteral(value);
		if (typeof value === "number") return this.num(value);
		return value ? f.createTrue() : f.createFalse();
	}

	private literalIndexExpr(
		values: ReadonlyArray<string | number | boolean | undefined>,
		value: ts.Expression,
	): ts.Expression {
		const f = this.factory;
		let expr: ts.Expression = this.num(values.length - 1);
		for (let i = values.length - 2; i >= 0; i--) {
			const v = values[i];
			const check =
				v === undefined
					? f.createBinaryExpression(
							value,
							this.ts_.SyntaxKind.EqualsEqualsEqualsToken,
							f.createIdentifier("undefined"),
						)
					: f.createBinaryExpression(
							value,
							this.ts_.SyntaxKind.EqualsEqualsEqualsToken,
							this.literalValueExpr(v),
						);
			expr = f.createConditionalExpression(check, undefined, this.num(i), undefined, expr);
		}
		return expr;
	}

	/**
	 * Casts to a real `Map<K,V>`/`Set<K>` type (never `any`: roblox-ts
	 * outright refuses to compile a call/method on an `any`-typed value --
	 * confirmed by hitting exactly that error -- so the placeholder has to be
	 * a real, usable type). This is what lets the write loop below iterate a
	 * plain `Record` with `for...of` destructuring even though TypeScript
	 * itself has no iteration protocol for a bare indexed object: the cast
	 * only affects what the *type checker* sees, and a `Record`'s runtime
	 * representation is already an indistinguishable plain table (Type
	 * Coverage in transformer.md), so the cast is lossless either way.
	 */
	private asMapOrSet(value: ts.Expression, keyField: Field, valueField: Field | undefined): ts.Expression {
		const f = this.factory;
		const typeNode = valueField
			? f.createTypeReferenceNode("Map", [this.fieldToTypeNode(keyField), this.fieldToTypeNode(valueField)])
			: f.createTypeReferenceNode("Set", [this.fieldToTypeNode(keyField)]);
		return f.createAsExpression(
			f.createAsExpression(value, f.createKeywordTypeNode(this.ts_.SyntaxKind.UnknownKeyword)),
			typeNode,
		);
	}

	private writeDict(field: Extract<Field, { kind: "dict" }>, value: ts.Expression, out: ts.Statement[]): void {
		const f = this.factory;
		const isSet = field.value === undefined;
		const dictTmp = this.fresh("dict");
		out.push(this.constStatement(dictTmp, value));
		const { buf: cbuf, pos: cpos, statement: cstmt } = this.destructureAlloc("alloc", 4);
		out.push(cstmt);
		const count = this.fresh("count");
		out.push(
			f.createVariableStatement(
				undefined,
				f.createVariableDeclarationList(
					[f.createVariableDeclaration(count, undefined, undefined, this.num(0))],
					this.ts_.NodeFlags.Let,
				),
			),
		);
		const k = this.fresh("k");
		const body: ts.Statement[] = [];
		this.writeField(field.key, k, body);
		if (!isSet) {
			const v = this.fresh("v");
			this.writeField(field.value!, v, body);
			body.push(
				f.createExpressionStatement(f.createPostfixUnaryExpression(count, this.ts_.SyntaxKind.PlusPlusToken)),
			);
			out.push(
				f.createForOfStatement(
					undefined,
					f.createVariableDeclarationList(
						[
							f.createVariableDeclaration(
								f.createArrayBindingPattern([
									f.createBindingElement(undefined, undefined, k),
									f.createBindingElement(undefined, undefined, v),
								]),
							),
						],
						this.ts_.NodeFlags.Const,
					),
					this.asMapOrSet(dictTmp, field.key, field.value),
					f.createBlock(body, true),
				),
			);
		} else {
			body.push(
				f.createExpressionStatement(f.createPostfixUnaryExpression(count, this.ts_.SyntaxKind.PlusPlusToken)),
			);
			out.push(
				f.createForOfStatement(
					undefined,
					f.createVariableDeclarationList([f.createVariableDeclaration(k)], this.ts_.NodeFlags.Const),
					this.asMapOrSet(dictTmp, field.key, undefined),
					f.createBlock(body, true),
				),
			);
		}
		out.push(f.createExpressionStatement(this.call("backpatchU32", [cpos, count])));
		void cbuf;
	}

	private writeObject(field: Extract<Field, { kind: "object" }>, value: ts.Expression, out: ts.Statement[]): void {
		if (field.helperName) {
			this.ensureHelper(field.helperName);
			out.push(this.factory.createExpressionStatement(this.callLocal(`${field.helperName}_write`, [value])));
			return;
		}
		this.writeObjectInline(field.fields, value, out);
	}

	private writeObjectInline(
		fields: ReadonlyArray<ObjectFieldEntry>,
		value: ts.Expression,
		out: ts.Statement[],
	): void {
		const f = this.factory;
		const packedBools = fields.filter((e) => e.field.kind === "bool" && e.field.packed);
		const normal = fields.filter((e) => !(e.field.kind === "bool" && e.field.packed));
		for (const entry of normal) {
			this.writeField(entry.field, f.createPropertyAccessExpression(value, entry.name), out);
		}
		if (packedBools.length > 0) {
			const byteCount = Math.ceil(packedBools.length / 8);
			const { buf, pos, statement } = this.destructureAlloc("alloc", byteCount);
			out.push(statement);
			// One `writeu8` per byte, computed from all its bits at once, rather
			// than one `packBit` call per bit into the reused scratch region:
			// `alloc()` doesn't zero a region it didn't just grow into, so a
			// bit-at-a-time write would leave any bit past `packedBools.length`
			// holding whatever an earlier `serialize()` call left there (see
			// wire-format-determinism.md). Computing the whole byte writes every
			// bit, including the unused high ones (implicitly zero), so the
			// result is deterministic by construction.
			for (let byteIndex = 0; byteIndex < byteCount; byteIndex++) {
				const chunk = packedBools.slice(byteIndex * 8, byteIndex * 8 + 8);
				const byteExpr = this.packedByteExpr(chunk, value);
				const offset =
					byteIndex === 0
						? pos
						: f.createBinaryExpression(pos, this.ts_.SyntaxKind.PlusToken, this.num(byteIndex));
				out.push(f.createExpressionStatement(this.bufferCall("writeu8", [buf, offset, byteExpr])));
			}
		}
	}

	/** Sums `1 << bitIndex` for each true entry in `entries` (bit 0 = the byte's least-significant bit, matching `unpackBit`'s `buffer.readbits`). */
	private packedByteExpr(entries: ReadonlyArray<ObjectFieldEntry>, value: ts.Expression): ts.Expression {
		const f = this.factory;
		let expr: ts.Expression | undefined;
		entries.forEach((entry, bitIndex) => {
			const term = f.createConditionalExpression(
				f.createPropertyAccessExpression(value, entry.name),
				undefined,
				this.num(1 << bitIndex),
				undefined,
				this.num(0),
			);
			expr = expr ? f.createBinaryExpression(expr, this.ts_.SyntaxKind.PlusToken, term) : term;
		});
		return expr!;
	}

	private writeTaggedUnion(
		field: Extract<Field, { kind: "taggedUnion" }>,
		value: ts.Expression,
		out: ts.Statement[],
	): void {
		const f = this.factory;
		const tagExpr = f.createPropertyAccessExpression(value, field.tagKey);
		const idxBytes = field.variants.length <= 256 ? 1 : 2;
		const idx = this.fresh("idx");
		out.push(
			this.constStatement(
				idx,
				this.literalIndexExpr(
					field.variants.map((v) => v.tagValue),
					tagExpr,
				),
			),
		);
		const { buf, pos, statement } = this.destructureAlloc("alloc", idxBytes);
		out.push(statement);
		out.push(
			f.createExpressionStatement(this.bufferCall(idxBytes === 1 ? "writeu8" : "writeu16", [buf, pos, idx])),
		);

		let chain: ts.Statement | undefined;
		for (let i = field.variants.length - 1; i >= 0; i--) {
			const branch: ts.Statement[] = [];
			const variantType = this.objectShapeTypeNode(field.variants[i].fields);
			this.writeObjectInline(field.variants[i].fields, this.castTo(value, variantType), branch);
			const cond = f.createBinaryExpression(idx, this.ts_.SyntaxKind.EqualsEqualsEqualsToken, this.num(i));
			chain = f.createIfStatement(cond, f.createBlock(branch, true), chain);
		}
		if (chain) out.push(chain);
	}

	private writeGuardedUnion(
		field: Extract<Field, { kind: "guardedUnion" }>,
		value: ts.Expression,
		out: ts.Statement[],
	): void {
		const f = this.factory;
		const idxBytes = field.variants.length <= 256 ? 1 : 2;
		const idx = this.fresh("idx");
		let idxExpr: ts.Expression = this.num(field.variants.length - 1);
		for (let i = field.variants.length - 2; i >= 0; i--) {
			idxExpr = f.createConditionalExpression(
				this.guardFor(field.variants[i], value),
				undefined,
				this.num(i),
				undefined,
				idxExpr,
			);
		}
		out.push(this.constStatement(idx, idxExpr));
		const { buf, pos, statement } = this.destructureAlloc("alloc", idxBytes);
		out.push(statement);
		out.push(
			f.createExpressionStatement(this.bufferCall(idxBytes === 1 ? "writeu8" : "writeu16", [buf, pos, idx])),
		);

		let chain: ts.Statement | undefined;
		for (let i = field.variants.length - 1; i >= 0; i--) {
			const branch: ts.Statement[] = [];
			this.writeField(field.variants[i], this.castTo(value, this.fieldToTypeNode(field.variants[i])), branch);
			const cond = f.createBinaryExpression(idx, this.ts_.SyntaxKind.EqualsEqualsEqualsToken, this.num(i));
			chain = f.createIfStatement(cond, f.createBlock(branch, true), chain);
		}
		if (chain) out.push(chain);
	}

	private guardFor(field: Field, value: ts.Expression): ts.Expression {
		const f = this.factory;
		const typeIs = (tag: string) => this.callLocal("typeIs", [value, f.createStringLiteral(tag)]);
		switch (field.kind) {
			case "num":
				return typeIs("number");
			case "str":
				return typeIs("string");
			case "bool":
				return typeIs("boolean");
			case "literalConst":
				return f.createBinaryExpression(
					value,
					this.ts_.SyntaxKind.EqualsEqualsEqualsToken,
					this.literalValueExpr(field.value),
				);
			case "object":
			case "array":
			case "tuple":
			case "dict":
				return typeIs("table");
			default:
				throw new Error(
					`surge: guarded unions only support string/number/boolean/literal primitives plus at most one table-shaped ` +
						`variant (object/array/tuple/Map/Set/Record) -- "${field.kind}" as a bare union member isn't supported.`,
				);
		}
	}

	// ---- READ -------------------------------------------------------------

	public readField(field: Field, out: ts.Statement[]): ts.Expression {
		const f = this.factory;
		switch (field.kind) {
			case "num": {
				const bytes = WIDTH_BYTES[field.width];
				const { buf, pos, statement } = this.destructureAlloc("readAlloc", bytes);
				out.push(statement);
				return this.bufferCall(`read${field.width}`, [buf, pos]);
			}
			case "bool": {
				const { buf, pos, statement } = this.destructureAlloc("readAlloc", 1);
				out.push(statement);
				return f.createBinaryExpression(
					this.bufferCall("readu8", [buf, pos]),
					this.ts_.SyntaxKind.ExclamationEqualsEqualsToken,
					this.num(0),
				);
			}
			case "str": {
				const { buf: lbuf, pos: lpos, statement: lstmt } = this.destructureAlloc("readAlloc", 4);
				out.push(lstmt);
				const len = this.fresh("len");
				out.push(this.constStatement(len, this.bufferCall("readu32", [lbuf, lpos])));
				const sbuf = this.fresh("buf");
				const spos = this.fresh("pos");
				out.push(
					f.createVariableStatement(
						undefined,
						f.createVariableDeclarationList(
							[
								f.createVariableDeclaration(
									f.createArrayBindingPattern([
										f.createBindingElement(undefined, undefined, sbuf),
										f.createBindingElement(undefined, undefined, spos),
									]),
									undefined,
									undefined,
									this.call("readAlloc", [len]),
								),
							],
							this.ts_.NodeFlags.Const,
						),
					),
				);
				return this.bufferCall("readstring", [sbuf, spos, len]);
			}
			case "vector3": {
				const [x, y, z] = this.readNum3("f32", out);
				return f.createNewExpression(f.createIdentifier("Vector3"), undefined, [x, y, z]);
			}
			case "color3": {
				return this.readColor3(out);
			}
			case "cframe": {
				return this.readCFrame(out);
			}
			case "colorSequence": {
				return this.readSequence("ColorSequence", out);
			}
			case "numberSequence": {
				return this.readSequence("NumberSequence", out);
			}
			case "enum": {
				const bytes = field.members.length <= 256 ? 1 : 2;
				const { buf, pos, statement } = this.destructureAlloc("readAlloc", bytes);
				out.push(statement);
				const idx = this.fresh("idx");
				out.push(this.constStatement(idx, this.bufferCall(bytes === 1 ? "readu8" : "readu16", [buf, pos])));
				return this.enumFromIndexExpr(field.enumName, field.members, idx);
			}
			case "object": {
				return this.readObject(field, out);
			}
			case "recursiveRef": {
				this.ensureHelper(field.helperName);
				return this.bindSideEffect(this.callLocal(`${field.helperName}_read`, []), out);
			}
			case "array": {
				const { buf, pos, statement } = this.destructureAlloc("readAlloc", 4);
				out.push(statement);
				const count = this.fresh("count");
				out.push(this.constStatement(count, this.bufferCall("readu32", [buf, pos])));
				const result = this.fresh("result");
				out.push(
					f.createVariableStatement(
						undefined,
						f.createVariableDeclarationList(
							[
								f.createVariableDeclaration(
									result,
									undefined,
									undefined,
									f.createArrayLiteralExpression([]),
								),
							],
							this.ts_.NodeFlags.Const,
						),
					),
				);
				const i = this.fresh("i");
				const body: ts.Statement[] = [];
				const itemExpr = this.readField(field.element, body);
				body.push(
					f.createExpressionStatement(
						f.createCallExpression(f.createPropertyAccessExpression(result, "push"), undefined, [itemExpr]),
					),
				);
				out.push(
					f.createForStatement(
						f.createVariableDeclarationList(
							[f.createVariableDeclaration(i, undefined, undefined, this.num(0))],
							this.ts_.NodeFlags.Let,
						),
						f.createBinaryExpression(i, this.ts_.SyntaxKind.LessThanToken, count),
						f.createPostfixIncrement(i),
						f.createBlock(body, true),
					),
				);
				return result;
			}
			case "tuple": {
				const result = this.fresh("tup");
				out.push(
					f.createVariableStatement(
						undefined,
						f.createVariableDeclarationList(
							[
								f.createVariableDeclaration(
									result,
									undefined,
									undefined,
									f.createArrayLiteralExpression([]),
								),
							],
							this.ts_.NodeFlags.Const,
						),
					),
				);
				for (const elementField of field.fixed) {
					const elementExpr = this.readField(elementField, out);
					out.push(
						f.createExpressionStatement(
							f.createCallExpression(f.createPropertyAccessExpression(result, "push"), undefined, [
								elementExpr,
							]),
						),
					);
				}
				if (field.rest) {
					const { buf, pos, statement } = this.destructureAlloc("readAlloc", 4);
					out.push(statement);
					const count = this.fresh("count");
					out.push(this.constStatement(count, this.bufferCall("readu32", [buf, pos])));
					const i = this.fresh("i");
					const body: ts.Statement[] = [];
					const restExpr = this.readField(field.rest, body);
					body.push(
						f.createExpressionStatement(
							f.createCallExpression(f.createPropertyAccessExpression(result, "push"), undefined, [
								restExpr,
							]),
						),
					);
					out.push(
						f.createForStatement(
							f.createVariableDeclarationList(
								[f.createVariableDeclaration(i, undefined, undefined, this.num(0))],
								this.ts_.NodeFlags.Let,
							),
							f.createBinaryExpression(i, this.ts_.SyntaxKind.LessThanToken, count),
							f.createPostfixIncrement(i),
							f.createBlock(body, true),
						),
					);
				}
				return result;
			}
			case "dict": {
				return this.readDict(field, out);
			}
			case "optional": {
				const { buf, pos, statement } = this.destructureAlloc("readAlloc", 1);
				out.push(statement);
				const present = this.fresh("present");
				out.push(
					this.constStatement(
						present,
						f.createBinaryExpression(
							this.bufferCall("readu8", [buf, pos]),
							this.ts_.SyntaxKind.ExclamationEqualsEqualsToken,
							this.num(0),
						),
					),
				);
				const result = this.fresh("opt");
				out.push(
					f.createVariableStatement(
						undefined,
						f.createVariableDeclarationList([f.createVariableDeclaration(result)], this.ts_.NodeFlags.Let),
					),
				);
				const innerStatements: ts.Statement[] = [];
				const innerExpr = this.readField(field.inner, innerStatements);
				innerStatements.push(
					f.createExpressionStatement(
						f.createBinaryExpression(result, this.ts_.SyntaxKind.EqualsToken, innerExpr),
					),
				);
				out.push(f.createIfStatement(present, f.createBlock(innerStatements, true)));
				return result;
			}
			case "literalConst": {
				return this.literalValueExpr(field.value);
			}
			case "literal": {
				const bytes = field.values.length <= 256 ? 1 : 2;
				const { buf, pos, statement } = this.destructureAlloc("readAlloc", bytes);
				out.push(statement);
				const idx = this.fresh("idx");
				out.push(this.constStatement(idx, this.bufferCall(bytes === 1 ? "readu8" : "readu16", [buf, pos])));
				return this.literalFromIndexExpr(field.values, idx);
			}
			case "taggedUnion": {
				return this.readTaggedUnion(field, out);
			}
			case "guardedUnion": {
				return this.readGuardedUnion(field, out);
			}
			case "blob": {
				return this.bindSideEffect(this.call("nextBlob", []), out);
			}
		}
	}

	private readNum3(width: "f32", out: ts.Statement[]): [ts.Expression, ts.Expression, ts.Expression] {
		const { buf, pos, statement } = this.destructureAlloc("readAlloc", 12);
		out.push(statement);
		const x = this.bufferCall(`read${width}`, [buf, pos]);
		const y = this.bufferCall(`read${width}`, [
			buf,
			this.factory.createBinaryExpression(pos, this.ts_.SyntaxKind.PlusToken, this.num(4)),
		]);
		const z = this.bufferCall(`read${width}`, [
			buf,
			this.factory.createBinaryExpression(pos, this.ts_.SyntaxKind.PlusToken, this.num(8)),
		]);
		return [x, y, z];
	}

	private readColor3(out: ts.Statement[]): ts.Expression {
		const f = this.factory;
		const { buf, pos, statement } = this.destructureAlloc("readAlloc", 3);
		out.push(statement);
		const channel = (i: number) =>
			f.createBinaryExpression(
				this.bufferCall("readu8", [
					buf,
					i === 0 ? pos : f.createBinaryExpression(pos, this.ts_.SyntaxKind.PlusToken, this.num(i)),
				]),
				this.ts_.SyntaxKind.SlashToken,
				this.num(255),
			);
		return f.createNewExpression(f.createIdentifier("Color3"), undefined, [channel(0), channel(1), channel(2)]);
	}

	private readCFrame(out: ts.Statement[]): ts.Expression {
		const f = this.factory;
		const [px, py, pz] = this.readNum3("f32", out);
		const position = this.fresh("pos");
		out.push(
			this.constStatement(
				position,
				f.createNewExpression(f.createIdentifier("Vector3"), undefined, [px, py, pz]),
			),
		);
		const [rx, ry, rz] = this.readNum3("f32", out);
		const rv = this.fresh("rv");
		out.push(
			this.constStatement(rv, f.createNewExpression(f.createIdentifier("Vector3"), undefined, [rx, ry, rz])),
		);
		const angle = this.fresh("angle");
		out.push(this.constStatement(angle, f.createPropertyAccessExpression(rv, "Magnitude")));
		const rotation = this.fresh("rotation");
		const axisExpr = f.createConditionalExpression(
			f.createBinaryExpression(angle, this.ts_.SyntaxKind.GreaterThanToken, f.createNumericLiteral("1e-6")),
			undefined,
			f.createPropertyAccessExpression(rv, "Unit"),
			undefined,
			f.createPropertyAccessExpression(f.createIdentifier("Vector3"), "zAxis"),
		);
		out.push(
			this.constStatement(
				rotation,
				f.createCallExpression(
					f.createPropertyAccessExpression(f.createIdentifier("CFrame"), "fromAxisAngle"),
					undefined,
					[axisExpr, angle],
				),
			),
		);
		return f.createCallExpression(f.createPropertyAccessExpression(rotation, "add"), undefined, [position]);
	}

	private readSequence(kind: "ColorSequence" | "NumberSequence", out: ts.Statement[]): ts.Expression {
		const f = this.factory;
		const { buf, pos, statement } = this.destructureAlloc("readAlloc", 1);
		out.push(statement);
		const count = this.fresh("count");
		out.push(this.constStatement(count, this.bufferCall("readu8", [buf, pos])));
		const keypoints = this.fresh("keypoints");
		out.push(
			f.createVariableStatement(
				undefined,
				f.createVariableDeclarationList(
					[f.createVariableDeclaration(keypoints, undefined, undefined, f.createArrayLiteralExpression([]))],
					this.ts_.NodeFlags.Const,
				),
			),
		);
		const i = this.fresh("i");
		const body: ts.Statement[] = [];
		const { buf: tbuf, pos: tpos, statement: tstmt } = this.destructureAlloc("readAlloc", 4);
		body.push(tstmt);
		const time = this.fresh("time");
		body.push(this.constStatement(time, this.bufferCall("readf32", [tbuf, tpos])));
		let valueExpr: ts.Expression;
		if (kind === "ColorSequence") {
			valueExpr = this.readColor3(body);
		} else {
			const { buf: vbuf, pos: vpos, statement: vstmt } = this.destructureAlloc("readAlloc", 4);
			body.push(vstmt);
			valueExpr = this.bufferCall("readf32", [vbuf, vpos]);
		}
		const keypoint = f.createNewExpression(f.createIdentifier(`${kind}Keypoint`), undefined, [time, valueExpr]);
		body.push(
			f.createExpressionStatement(
				f.createCallExpression(f.createPropertyAccessExpression(keypoints, "push"), undefined, [keypoint]),
			),
		);
		out.push(
			f.createForStatement(
				f.createVariableDeclarationList(
					[f.createVariableDeclaration(i, undefined, undefined, this.num(0))],
					this.ts_.NodeFlags.Let,
				),
				f.createBinaryExpression(i, this.ts_.SyntaxKind.LessThanToken, count),
				f.createPostfixIncrement(i),
				f.createBlock(body, true),
			),
		);
		return f.createNewExpression(f.createIdentifier(kind), undefined, [keypoints]);
	}

	private enumFromIndexExpr(enumName: string, members: ReadonlyArray<string>, idx: ts.Expression): ts.Expression {
		const { itemsName } = this.ensureEnumTable(enumName, members);
		return this.factory.createElementAccessExpression(this.factory.createIdentifier(itemsName), idx);
	}

	private literalFromIndexExpr(
		values: ReadonlyArray<string | number | boolean | undefined>,
		idx: ts.Expression,
	): ts.Expression {
		const f = this.factory;
		const last = values[values.length - 1];
		let expr: ts.Expression = last === undefined ? f.createIdentifier("undefined") : this.literalValueExpr(last);
		for (let i = values.length - 2; i >= 0; i--) {
			const v = values[i];
			const branchExpr = v === undefined ? f.createIdentifier("undefined") : this.literalValueExpr(v);
			expr = f.createConditionalExpression(
				f.createBinaryExpression(idx, this.ts_.SyntaxKind.EqualsEqualsEqualsToken, this.num(i)),
				undefined,
				branchExpr,
				undefined,
				expr,
			);
		}
		return expr;
	}

	private readDict(field: Extract<Field, { kind: "dict" }>, out: ts.Statement[]): ts.Expression {
		const f = this.factory;
		const isSet = field.value === undefined;
		const { buf, pos, statement } = this.destructureAlloc("readAlloc", 4);
		out.push(statement);
		const count = this.fresh("count");
		out.push(this.constStatement(count, this.bufferCall("readu32", [buf, pos])));
		const result = this.fresh("result");
		// Reconstructed as a `Record` regardless of `field.source`: that's the
		// only one of the three TypeScript shapes whose plain `result[key] =`
		// bracket-write actually type-checks (`Map`/`Set` require `.set()`/
		// `.add()`, which the loop below doesn't use). Cast to the real shape
		// only in the returned expression, once reconstruction is done.
		const recordType = f.createTypeReferenceNode("Record", [
			this.fieldToTypeNode(field.key),
			isSet ? f.createKeywordTypeNode(this.ts_.SyntaxKind.BooleanKeyword) : this.fieldToTypeNode(field.value!),
		]);
		out.push(
			f.createVariableStatement(
				undefined,
				f.createVariableDeclarationList(
					[f.createVariableDeclaration(result, undefined, recordType, f.createObjectLiteralExpression([]))],
					this.ts_.NodeFlags.Const,
				),
			),
		);
		const i = this.fresh("i");
		const body: ts.Statement[] = [];
		const keyExpr = this.readField(field.key, body);
		if (isSet) {
			body.push(
				f.createExpressionStatement(
					f.createBinaryExpression(
						f.createElementAccessExpression(result, keyExpr),
						this.ts_.SyntaxKind.EqualsToken,
						f.createTrue(),
					),
				),
			);
		} else {
			const valueExpr = this.readField(field.value!, body);
			body.push(
				f.createExpressionStatement(
					f.createBinaryExpression(
						f.createElementAccessExpression(result, keyExpr),
						this.ts_.SyntaxKind.EqualsToken,
						valueExpr,
					),
				),
			);
		}
		out.push(
			f.createForStatement(
				f.createVariableDeclarationList(
					[f.createVariableDeclaration(i, undefined, undefined, this.num(0))],
					this.ts_.NodeFlags.Let,
				),
				f.createBinaryExpression(i, this.ts_.SyntaxKind.LessThanToken, count),
				f.createPostfixIncrement(i),
				f.createBlock(body, true),
			),
		);
		if (field.source === "record") {
			return result;
		}
		return f.createAsExpression(
			f.createAsExpression(result, f.createKeywordTypeNode(this.ts_.SyntaxKind.UnknownKeyword)),
			this.asMapOrSetTypeNode(field),
		);
	}

	private asMapOrSetTypeNode(field: Extract<Field, { kind: "dict" }>): ts.TypeNode {
		const f = this.factory;
		return field.value
			? f.createTypeReferenceNode("Map", [this.fieldToTypeNode(field.key), this.fieldToTypeNode(field.value)])
			: f.createTypeReferenceNode("Set", [this.fieldToTypeNode(field.key)]);
	}

	private readObject(field: Extract<Field, { kind: "object" }>, out: ts.Statement[]): ts.Expression {
		if (field.helperName) {
			this.ensureHelper(field.helperName);
			return this.bindSideEffect(this.callLocal(`${field.helperName}_read`, []), out);
		}
		return this.readObjectInline(field.fields, out);
	}

	private readObjectInline(fields: ReadonlyArray<ObjectFieldEntry>, out: ts.Statement[]): ts.Expression {
		const f = this.factory;
		const packedBools = fields.filter((e) => e.field.kind === "bool" && e.field.packed);
		const normal = fields.filter((e) => !(e.field.kind === "bool" && e.field.packed));
		const props: ts.ObjectLiteralElementLike[] = [];
		for (const entry of normal) {
			const expr = this.readField(entry.field, out);
			props.push(f.createPropertyAssignment(entry.name, expr));
		}
		if (packedBools.length > 0) {
			const byteCount = Math.ceil(packedBools.length / 8);
			const { buf, pos, statement } = this.destructureAlloc("readAlloc", byteCount);
			out.push(statement);
			packedBools.forEach((entry, i) => {
				props.push(f.createPropertyAssignment(entry.name, this.call("unpackBit", [buf, pos, this.num(i)])));
			});
		}
		return f.createObjectLiteralExpression(props, true);
	}

	private readTaggedUnion(field: Extract<Field, { kind: "taggedUnion" }>, out: ts.Statement[]): ts.Expression {
		const f = this.factory;
		const idxBytes = field.variants.length <= 256 ? 1 : 2;
		const { buf, pos, statement } = this.destructureAlloc("readAlloc", idxBytes);
		out.push(statement);
		const idx = this.fresh("idx");
		out.push(this.constStatement(idx, this.bufferCall(idxBytes === 1 ? "readu8" : "readu16", [buf, pos])));
		const result = this.fresh("result");
		out.push(
			f.createVariableStatement(
				undefined,
				f.createVariableDeclarationList(
					[f.createVariableDeclaration(result, undefined, this.fieldToTypeNode(field))],
					this.ts_.NodeFlags.Let,
				),
			),
		);

		const branchFor = (i: number): ts.Statement[] => {
			const variant = field.variants[i];
			const branch: ts.Statement[] = [];
			const objExpr = this.readObjectInline(variant.fields, branch);
			const withTag = f.createObjectLiteralExpression(
				[
					f.createSpreadAssignment(objExpr),
					f.createPropertyAssignment(field.tagKey, this.literalValueExpr(variant.tagValue)),
				],
				true,
			);
			branch.push(
				f.createExpressionStatement(f.createBinaryExpression(result, this.ts_.SyntaxKind.EqualsToken, withTag)),
			);
			return branch;
		};
		// Built with variant 0 as an unconditional `else` (not `else if (idx
		// === 0)`), so TypeScript's definite-assignment analysis sees `result`
		// as assigned on every path -- it has no way to know our own index
		// values are exhaustive otherwise.
		let chain: ts.Statement = f.createBlock(branchFor(0), true);
		for (let i = 1; i < field.variants.length; i++) {
			const cond = f.createBinaryExpression(idx, this.ts_.SyntaxKind.EqualsEqualsEqualsToken, this.num(i));
			chain = f.createIfStatement(cond, f.createBlock(branchFor(i), true), chain);
		}
		out.push(chain);
		return result;
	}

	private readGuardedUnion(field: Extract<Field, { kind: "guardedUnion" }>, out: ts.Statement[]): ts.Expression {
		const f = this.factory;
		const idxBytes = field.variants.length <= 256 ? 1 : 2;
		const { buf, pos, statement } = this.destructureAlloc("readAlloc", idxBytes);
		out.push(statement);
		const idx = this.fresh("idx");
		out.push(this.constStatement(idx, this.bufferCall(idxBytes === 1 ? "readu8" : "readu16", [buf, pos])));
		const result = this.fresh("result");
		out.push(
			f.createVariableStatement(
				undefined,
				f.createVariableDeclarationList(
					[f.createVariableDeclaration(result, undefined, this.fieldToTypeNode(field))],
					this.ts_.NodeFlags.Let,
				),
			),
		);

		const branchFor = (i: number): ts.Statement[] => {
			const branch: ts.Statement[] = [];
			const expr = this.readField(field.variants[i], branch);
			branch.push(
				f.createExpressionStatement(f.createBinaryExpression(result, this.ts_.SyntaxKind.EqualsToken, expr)),
			);
			return branch;
		};
		let chain: ts.Statement = f.createBlock(branchFor(0), true);
		for (let i = 1; i < field.variants.length; i++) {
			const cond = f.createBinaryExpression(idx, this.ts_.SyntaxKind.EqualsEqualsEqualsToken, this.num(i));
			chain = f.createIfStatement(cond, f.createBlock(branchFor(i), true), chain);
		}
		out.push(chain);
		return result;
	}

	// ---- recursive helpers --------------------------------------------

	/**
	 * A named reference to the type alias `ensureHelper` declares for this
	 * helper -- never an inline type literal. `any`/`unknown` can't stand in
	 * for it: roblox-ts's `for...of` lowering outright doesn't support an
	 * `any`-typed iterable ("ForOf iteration type not implemented: any",
	 * confirmed by hitting this while `value: any` was the recursive
	 * helper's parameter type), and a self-referential structural type can
	 * only be written through a name, not inlined -- inlining would recurse
	 * forever building the type itself, before any code generation happens.
	 */
	private helperTypeRef(name: string): ts.TypeNode {
		this.ensureHelper(name);
		return this.factory.createTypeReferenceNode(`${name}_Type`);
	}

	private objectShapeTypeNode(fields: ReadonlyArray<ObjectFieldEntry>): ts.TypeNode {
		const f = this.factory;
		return f.createTypeLiteralNode(
			fields.map((entry) =>
				f.createPropertySignature(undefined, entry.name, undefined, this.fieldToTypeNode(entry.field)),
			),
		);
	}

	/** The best-effort structural type of a `Field`, for internal declarations only (never shown to a caller). */
	private fieldToTypeNode(field: Field): ts.TypeNode {
		const f = this.factory;
		const kw = (k: ts.KeywordTypeSyntaxKind) => f.createKeywordTypeNode(k);
		switch (field.kind) {
			case "num":
				return kw(this.ts_.SyntaxKind.NumberKeyword);
			case "bool":
				return kw(this.ts_.SyntaxKind.BooleanKeyword);
			case "str":
				return kw(this.ts_.SyntaxKind.StringKeyword);
			case "vector3":
				return f.createTypeReferenceNode("Vector3");
			case "cframe":
				return f.createTypeReferenceNode("CFrame");
			case "color3":
				return f.createTypeReferenceNode("Color3");
			case "colorSequence":
				return f.createTypeReferenceNode("ColorSequence");
			case "numberSequence":
				return f.createTypeReferenceNode("NumberSequence");
			case "enum":
				return f.createTypeReferenceNode(f.createQualifiedName(f.createIdentifier("Enum"), field.enumName));
			case "object":
				return field.helperName ? this.helperTypeRef(field.helperName) : this.objectShapeTypeNode(field.fields);
			case "recursiveRef":
				return this.helperTypeRef(field.helperName);
			case "array":
				return f.createArrayTypeNode(this.fieldToTypeNode(field.element));
			case "tuple": {
				const members = field.fixed.map((el) => this.fieldToTypeNode(el));
				if (field.rest) {
					members.push(f.createRestTypeNode(f.createArrayTypeNode(this.fieldToTypeNode(field.rest))));
				}
				return f.createTupleTypeNode(members);
			}
			case "dict":
				return field.value
					? f.createTypeReferenceNode("Map", [
							this.fieldToTypeNode(field.key),
							this.fieldToTypeNode(field.value),
						])
					: f.createTypeReferenceNode("Set", [this.fieldToTypeNode(field.key)]);
			case "optional":
				return f.createUnionTypeNode([
					this.fieldToTypeNode(field.inner),
					kw(this.ts_.SyntaxKind.UndefinedKeyword),
				]);
			case "literalConst":
				return f.createLiteralTypeNode(
					this.literalValueExpr(field.value) as ts.LiteralExpression | ts.BooleanLiteral,
				);
			case "literal":
				return f.createUnionTypeNode(
					field.values.map((v) =>
						v === undefined
							? kw(this.ts_.SyntaxKind.UndefinedKeyword)
							: f.createLiteralTypeNode(
									this.literalValueExpr(v) as ts.LiteralExpression | ts.BooleanLiteral,
								),
					),
				);
			case "taggedUnion":
				return f.createUnionTypeNode(
					field.variants.map((variant) =>
						f.createTypeLiteralNode([
							f.createPropertySignature(
								undefined,
								field.tagKey,
								undefined,
								f.createLiteralTypeNode(
									this.literalValueExpr(variant.tagValue) as ts.LiteralExpression | ts.BooleanLiteral,
								),
							),
							...variant.fields.map((entry) =>
								f.createPropertySignature(
									undefined,
									entry.name,
									undefined,
									this.fieldToTypeNode(entry.field),
								),
							),
						]),
					),
				);
			case "guardedUnion":
				return f.createUnionTypeNode(field.variants.map((v) => this.fieldToTypeNode(v)));
			case "blob":
				return kw(this.ts_.SyntaxKind.UnknownKeyword);
		}
	}

	private ensureHelper(name: string): void {
		if (this.generatedHelpers.has(name)) {
			return;
		}
		this.generatedHelpers.add(name);
		const field = this.helperFields.get(name);
		if (!field) {
			throw new Error(`surge: internal error -- no resolved field for recursive helper "${name}"`);
		}
		// Building this body can never recurse into this same helper: for an
		// `object`, `field.fields` is used directly below (`writeObjectInline`/
		// `readObjectInline`), bypassing the `field.helperName` check that
		// `writeObject`/`readObject` make -- the marker is there, just unused
		// here. Every other kind has no such marker to carry in the first
		// place, so the walker (see `walk.ts`'s `resolved`/`walkUnion` doc
		// comments) only ever hands back the bare structure for those; the
		// first call site to finish walking a recursive one instead resolves
		// to `recursiveRef`, and that's what a *nested* reference inside this
		// very `field` will be.
		const f = this.factory;

		const typeNode = field.kind === "object" ? this.objectShapeTypeNode(field.fields) : this.fieldToTypeNode(field);
		this.helperDecls.push(f.createTypeAliasDeclaration(undefined, `${name}_Type`, undefined, typeNode));
		const typeRef = f.createTypeReferenceNode(`${name}_Type`);

		const valueParam = f.createParameterDeclaration(undefined, undefined, "value", undefined, typeRef, undefined);
		const writeBody: ts.Statement[] = [];
		if (field.kind === "object") {
			this.writeObjectInline(field.fields, f.createIdentifier("value"), writeBody);
		} else {
			this.writeField(field, f.createIdentifier("value"), writeBody);
		}
		this.helperDecls.push(
			f.createFunctionDeclaration(
				undefined,
				undefined,
				`${name}_write`,
				undefined,
				[valueParam],
				undefined,
				f.createBlock(writeBody, true),
			),
		);

		const readBody: ts.Statement[] = [];
		const resultExpr =
			field.kind === "object" ? this.readObjectInline(field.fields, readBody) : this.readField(field, readBody);
		readBody.push(f.createReturnStatement(resultExpr));
		this.helperDecls.push(
			f.createFunctionDeclaration(
				undefined,
				undefined,
				`${name}_read`,
				undefined,
				[],
				typeRef,
				f.createBlock(readBody, true),
			),
		);
	}

	public getHelperDecls(): ts.Statement[] {
		return this.helperDecls;
	}
}
