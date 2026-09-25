import type ts from "typescript";

import type { Field, FieldKey, NumWidth } from "../field";
import {
	CAPACITY,
	CURSOR,
	ERROR_PREFIX,
	INITIAL_CAPACITY,
	LOCALS_BUDGET,
	LOCALS_PER_BLOCK,
	READ_BUFFER,
	READ_CURSOR,
	READ_LENGTH,
	SCRATCH,
	importAlias,
} from "./constants";

/**
 * A reserved region of the buffer: the cursor state's buffer, the position a
 * reservation took, and a byte offset into what it reserved. The offset is what
 * lets one reservation cover more than one value -- a `CFrame` reserves 24
 * bytes once and writes its position at 0 and its rotation vector at 12.
 */
export interface Slot {
	readonly buf: ts.Identifier;
	readonly pos: ts.Identifier;
	readonly offset: number;
}

/**
 * One reservation shared by several consecutive fields. `buf` and `pos` are set
 * by the first field that asks for bytes, which is where the cursor advances;
 * `used` tracks how much of `total` the fields have taken.
 */
interface AllocRun {
	readonly fnName: "alloc" | "readAlloc";
	readonly total: number;
	used: number;
	buf?: ts.Identifier;
	pos?: ts.Identifier;
}

/** One independently emitted run of statements, with the number of locals it declares in the enclosing scope. */
export interface ScopedItem {
	readonly statements: ts.Statement[];
	readonly locals: number;
}

/**
 * The state one emitted pair of functions shares, and the statement- and
 * expression-level plumbing every field kind is built out of. `write.ts`,
 * `read.ts`, and `types.ts` take one of these rather than holding state of
 * their own, so the cursor, the local budget, and the open alloc run have
 * exactly one owner. Internal to `src/emit/`: `Emitter` is what leaves it.
 */
/** Which of a serializer's two functions a call site's factory returns. */
export interface EmitSides {
	readonly write: boolean;
	readonly read: boolean;
}

export const BOTH_SIDES: EmitSides = { write: true, read: true };

/** What a call site asks the emitter for, from its factory and its options. */
export interface EmitOptions {
	/**
	 * Emit the read-side bounds checks of the `readChecks` factory option
	 * (Transformer 5.10 in docs/specs/transformer.md in the surge repo).
	 * Off, the read path is what it always was: no branch per read, and a
	 * malformed payload is a raw Luau error or worse. Per call site, so one
	 * place can hold a checked serializer for a remote boundary and an
	 * unchecked one for its own storage.
	 */
	readonly readChecks?: boolean;
	/**
	 * Emit the write-side checks of the `writeChecks` factory option
	 * (Transformer 5.14 in docs/specs/transformer.md in the surge repo): a
	 * value whose length or count does not fit its type raises instead of
	 * being padded, truncated or wrapped.
	 */
	readonly writeChecks?: boolean;
	/**
	 * The sides the call site's factory returns. A recursion helper is
	 * emitted for these sides only: the closure declares only their state,
	 * so a helper for the other side would name state that does not exist.
	 */
	readonly sides?: EmitSides;
}

export abstract class EmitContext {
	protected tempCounter = 0;
	// Locals declared so far in the function being emitted. Locals declared
	// inside a loop or branch body are never subtracted, so this overcounts;
	// the only effect is that `pushScoped` starts using blocks earlier.
	protected liveLocals = 0;
	public readonly usedImports = new Set<string>();
	/**
	 * Whether either side reserved any bytes at all. A shape whose fields are
	 * all blobs reserves none, and declaring cursor state it never reads would
	 * fail a consumer's `noUnusedLocals` -- the same reason an unread `_input`
	 * carries an underscore.
	 */
	public usesWriteBytes = false;
	public usesReadBytes = false;
	protected readonly generatedHelpers = new Set<string>();
	protected readonly helperDecls: ts.Statement[] = [];
	private readonly enumTables = new Map<string, { itemsName: string; indexName: string }>();
	private enumTableCounter = 0;
	/**
	 * The reservation a run of consecutive fixed-size fields shares, while
	 * one is open. `alloc` order is byte order, so a run may only cover
	 * fields that reserve a constant number of bytes with nothing between
	 * them that reserves for itself: `fixedBytes` decides which those are,
	 * and `withAllocRun` sizes the run before opening it.
	 */
	private run: AllocRun | undefined;

	public constructor(
		public readonly ts_: typeof ts,
		public readonly factory: ts.NodeFactory,
		protected readonly helperFields: ReadonlyMap<string, Field>,
		options: EmitOptions = {},
	) {
		this.readChecks = options.readChecks ?? false;
		this.writeChecks = options.writeChecks ?? false;
		this.sides = options.sides ?? BOTH_SIDES;
	}

	/** See {@link EmitOptions}. */
	public readonly readChecks: boolean;
	public readonly writeChecks: boolean;
	public readonly sides: EmitSides;

	public fresh(base: string): ts.Identifier {
		this.tempCounter += 1;
		this.liveLocals += 1;
		return this.factory.createIdentifier(`${base}${this.tempCounter}`);
	}

	/** Calls a real `@rbxts/surge` export, tracked so the file-level import statement includes it. */
	public call(name: string, args: ts.Expression[]): ts.CallExpression {
		this.usedImports.add(name);
		return this.factory.createCallExpression(this.factory.createIdentifier(importAlias(name)), undefined, args);
	}

	/** Calls a locally-generated helper function (never an import from @rbxts/surge). */
	public callLocal(name: string, args: ts.Expression[]): ts.CallExpression {
		return this.factory.createCallExpression(this.factory.createIdentifier(name), undefined, args);
	}

	/** `value.name`, or `value["my-key"]`/`value[0]` when the name isn't a valid identifier. */
	public propertyAccess(value: ts.Expression, key: FieldKey): ts.Expression {
		const name = this.propertyName(key);
		return this.ts_.isIdentifier(name)
			? this.factory.createPropertyAccessExpression(value, name)
			: this.factory.createElementAccessExpression(value, name);
	}

	public propertyName(key: FieldKey): ts.Identifier | ts.StringLiteral | ts.NumericLiteral {
		if (key.numericKey) {
			return this.factory.createNumericLiteral(key.name);
		}
		return this.isIdentifierName(key.name)
			? this.factory.createIdentifier(key.name)
			: this.factory.createStringLiteral(key.name);
	}

	private isIdentifierName(name: string): boolean {
		const target = this.ts_.ScriptTarget.ESNext;
		const chars = [...name];
		return (
			chars.length > 0 &&
			chars.every((char, i) =>
				i === 0
					? this.ts_.isIdentifierStart(char.codePointAt(0)!, target)
					: this.ts_.isIdentifierPart(char.codePointAt(0)!, target),
			)
		);
	}

	/** Must be called before emitting the body of each generated function: the local budget is per function. */
	public beginFunction(): void {
		this.liveLocals = 0;
	}

	/**
	 * The scratch buffer, its capacity and the write cursor, for the head of
	 * the closure the serializer is emitted into. One buffer per serializer,
	 * not one per place: two serializers can then be in flight at once, which a
	 * single module-scoped buffer never allowed -- unless either carries a blob
	 * field, because the blob side channel is still module state in the package.
	 */
	public writeStateDecls(): ts.Statement[] {
		if (!this.usesWriteBytes) {
			return [];
		}
		return [
			this.letStatement(SCRATCH, this.bufferCall("create", [this.num(INITIAL_CAPACITY)])),
			this.letStatement(CAPACITY, this.num(INITIAL_CAPACITY)),
			this.letStatement(CURSOR, this.num(0)),
		];
	}

	/** The input buffer and the read cursor, as {@link writeStateDecls}. */
	public readStateDecls(): ts.Statement[] {
		if (!this.usesReadBytes) {
			return [];
		}
		const decls = [
			this.letStatement(READ_BUFFER, this.bufferCall("create", [this.num(0)])),
			this.letStatement(READ_CURSOR, this.num(0)),
		];
		// One `buffer.len` per `deserialize()` rather than one per check.
		if (this.readChecks) {
			decls.push(this.letStatement(READ_LENGTH, this.num(0)));
		}
		return decls;
	}

	/** Opens a `serialize()`: everything written last call is forgotten by moving one number. */
	public beginWriteStatements(): ts.Statement[] {
		return this.usesWriteBytes ? [this.assign(CURSOR, this.num(0))] : [];
	}

	/** Opens a `deserialize()`, taking the buffer the caller passed. */
	public beginReadStatements(input: ts.Expression): ts.Statement[] {
		if (!this.usesReadBytes) {
			return [];
		}
		const statements = [this.assign(READ_BUFFER, input), this.assign(READ_CURSOR, this.num(0))];
		if (this.readChecks) {
			statements.push(
				this.assign(READ_LENGTH, this.bufferCall("len", [this.factory.createIdentifier(READ_BUFFER)])),
			);
		}
		return statements;
	}

	/**
	 * Closes a `serialize()`. A shape that reserved nothing -- every field a
	 * blob -- has no scratch buffer to copy out of, and an empty result is what
	 * the copy would have produced.
	 */
	public finishWriteExpression(): ts.Expression {
		return this.usesWriteBytes
			? this.call("finishWrite", [this.factory.createIdentifier(SCRATCH), this.factory.createIdentifier(CURSOR)])
			: this.bufferCall("create", [this.num(0)]);
	}

	public letStatement(name: string, initializer: ts.Expression): ts.Statement {
		return this.factory.createVariableStatement(
			undefined,
			this.factory.createVariableDeclarationList(
				[
					this.factory.createVariableDeclaration(
						this.factory.createIdentifier(name),
						undefined,
						undefined,
						initializer,
					),
				],
				this.ts_.NodeFlags.Let,
			),
		);
	}

	public measure(emit: (out: ts.Statement[]) => void): ScopedItem {
		const before = this.liveLocals;
		const statements: ts.Statement[] = [];
		emit(statements);
		return { statements, locals: this.liveLocals - before };
	}

	/** Whether the items just measured took the current function past `LOCALS_BUDGET`, so `pushScoped` will use blocks. */
	public needsBlocks(): boolean {
		return this.liveLocals > LOCALS_BUDGET;
	}

	/**
	 * Appends independently emitted items to `out`: inline while the function
	 * is within `LOCALS_BUDGET`, otherwise as consecutive blocks. No item may
	 * refer to a local that another item declares.
	 */
	public pushScoped(items: ReadonlyArray<ScopedItem>, out: ts.Statement[]): void {
		if (!this.needsBlocks()) {
			for (const item of items) {
				out.push(...item.statements);
			}
			return;
		}
		let group: ts.Statement[] = [];
		let groupLocals = 0;
		const flush = () => {
			if (group.length > 0) {
				out.push(this.factory.createBlock(group, true));
			}
			group = [];
			groupLocals = 0;
		};
		for (const item of items) {
			if (groupLocals > 0 && groupLocals + item.locals > LOCALS_PER_BLOCK) {
				flush();
			}
			group.push(...item.statements);
			groupLocals += item.locals;
			this.liveLocals -= item.locals;
		}
		flush();
	}

	public num(n: number): ts.Expression {
		// `createNumericLiteral` asserts on a negative number: the minus sign is an operator.
		return n < 0
			? this.factory.createPrefixUnaryExpression(
					this.ts_.SyntaxKind.MinusToken,
					this.factory.createNumericLiteral(-n),
				)
			: this.factory.createNumericLiteral(n);
	}

	public constStatement(name: ts.Identifier, initializer: ts.Expression): ts.Statement {
		return this.factory.createVariableStatement(
			undefined,
			this.factory.createVariableDeclarationList(
				[this.factory.createVariableDeclaration(name, undefined, undefined, initializer)],
				this.ts_.NodeFlags.Const,
			),
		);
	}

	/**
	 * A write loop over `value[from]` up to but not including `value[to]`, for
	 * a body that indexes the value rather than iterating it. A C-style `for`
	 * and not `countedLoop`'s `$range`, because roblox-ts applies its own
	 * 0-to-1 index shift to `value[i]` and a `$range` index is already 1-based.
	 * The exact form's bound is a numeric literal, which roblox-ts can prove is
	 * an integer, so this still lowers to a numeric `for`.
	 */
	public indexedLoop(index: ts.Identifier, from: number, to: ts.Expression, body: ts.Statement[]): ts.Statement {
		const f = this.factory;
		return f.createForStatement(
			f.createVariableDeclarationList(
				[f.createVariableDeclaration(index, undefined, undefined, this.num(from))],
				this.ts_.NodeFlags.Let,
			),
			f.createBinaryExpression(index, this.ts_.SyntaxKind.LessThanToken, to),
			f.createPostfixIncrement(index),
			f.createBlock(body, true),
		);
	}

	/**
	 * A read loop that runs `count` times, over a body that never reads the
	 * index.
	 *
	 * `$range` is roblox-ts's numeric-for macro: `for (const i of $range(1,
	 * count))` lowers to `for i = 1, count do`. A plain
	 * `for (let i = 0; i < count; i++)` does not -- roblox-ts only emits a
	 * numeric `for` when it can prove the bound is an integer
	 * (`transformForStatement.js`'s `isProbablyInteger`), and a
	 * `buffer.readu32` result is just `number`, so it lowers to a `while`
	 * loop with a `_shouldIncrement` flag that every element read pays for.
	 * The index name starts with `_` because the body never uses it, and
	 * TypeScript reports an unused `for`-`of` variable under `noUnusedLocals`
	 * unless it does: the generated file is type-checked in the consumer's
	 * own project, under the consumer's own options.
	 */
	public countedLoop(index: ts.Identifier, count: ts.Expression, body: ts.Statement[]): ts.Statement {
		const f = this.factory;
		return f.createForOfStatement(
			undefined,
			f.createVariableDeclarationList([f.createVariableDeclaration(index)], this.ts_.NodeFlags.Const),
			f.createCallExpression(f.createIdentifier("$range"), undefined, [this.num(1), count]),
			f.createBlock(body, true),
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
	 * this instead of returning the call expression directly (the
	 * read-order-side-effects finding in
	 * docs/research/september-2026-review.md in the surge repo).
	 */
	public bindSideEffect(expr: ts.Expression, out: ts.Statement[]): ts.Expression {
		const tmp = this.fresh("val");
		out.push(this.constStatement(tmp, expr));
		return tmp;
	}

	/**
	 * Reserves `size` bytes and returns the buffer and the position to use,
	 * plus the statements that declare them, which the caller pushes.
	 *
	 * While a run is open (see {@link withAllocRun}) the bytes come out of
	 * the run's single reservation instead: the first caller emits the one
	 * reservation for the whole run, and each later caller gets a position
	 * local computed from it -- a register move, not even the four
	 * instructions below.
	 */
	public destructureAlloc(
		fnName: "alloc" | "readAlloc",
		size: number | ts.Expression,
	): { buf: ts.Identifier; pos: ts.Identifier; statements: ts.Statement[] } {
		const run = this.run;
		if (run !== undefined) {
			// `fixedBytes` admits only fields that reserve a constant number
			// of bytes from the matching function, so neither can happen; a
			// standalone reservation in the middle of a run would put its
			// bytes after the run's, which is not where the read side looks.
			if (fnName !== run.fnName || typeof size !== "number") {
				throw new Error("surge: a field inside an alloc run reserved on its own");
			}
			if (run.used + size > run.total) {
				throw new Error(`surge: an alloc run overran ${run.total} bytes`);
			}
			const offset = run.used;
			run.used += size;
			if (offset === 0) {
				const first = this.rawDestructureAlloc(fnName, run.total);
				run.buf = first.buf;
				run.pos = first.pos;
				return first;
			}
			const pos = this.fresh("pos");
			return {
				buf: run.buf!,
				pos,
				statements: [this.constStatement(pos, this.offsetFrom(run.pos!, offset))],
			};
		}
		return this.rawDestructureAlloc(fnName, size);
	}

	/**
	 * The reservation itself, inline: take the cursor, advance it, and on the
	 * write side compare against the capacity and grow on the branch that is
	 * not taken. The cursor and the buffer are locals of the closure this code
	 * is emitted into, not module state in `@rbxts/surge`, which is what makes
	 * this four instructions instead of a call into another module. What
	 * removing that call was worth is in
	 * docs/research/generated-code-against-hand-written.md in the surge repo.
	 *
	 * `buf` is the state identifier itself rather than a fresh local, so every
	 * `buffer.writeXX` reads whichever buffer is current -- which is what makes
	 * a growth between two reservations safe, and what `backpatchU32` used to
	 * need a runtime function for.
	 */
	private rawDestructureAlloc(
		fnName: "alloc" | "readAlloc",
		size: number | ts.Expression,
	): { buf: ts.Identifier; pos: ts.Identifier; statements: ts.Statement[] } {
		const f = this.factory;
		const pos = this.fresh("pos");
		const sizeExpr = typeof size === "number" ? this.num(size) : size;
		if (fnName === "readAlloc") {
			this.usesReadBytes = true;
			const statements = [
				this.constStatement(pos, f.createIdentifier(READ_CURSOR)),
				this.assign(READ_CURSOR, f.createBinaryExpression(pos, this.ts_.SyntaxKind.PlusToken, sizeExpr)),
			];
			if (this.readChecks) {
				statements.push(
					this.throwIf(
						f.createBinaryExpression(
							f.createIdentifier(READ_CURSOR),
							this.ts_.SyntaxKind.GreaterThanToken,
							f.createIdentifier(READ_LENGTH),
						),
						"deserialize read past the end of the input buffer",
					),
				);
			}
			return { buf: f.createIdentifier(READ_BUFFER), pos, statements };
		}
		this.usesWriteBytes = true;
		return {
			buf: f.createIdentifier(SCRATCH),
			pos,
			statements: [
				this.constStatement(pos, f.createIdentifier(CURSOR)),
				this.assign(CURSOR, f.createBinaryExpression(pos, this.ts_.SyntaxKind.PlusToken, sizeExpr)),
				f.createIfStatement(
					f.createBinaryExpression(
						f.createIdentifier(CURSOR),
						this.ts_.SyntaxKind.GreaterThanToken,
						f.createIdentifier(CAPACITY),
					),
					f.createBlock(
						[
							this.assign(
								SCRATCH,
								this.call("grow", [f.createIdentifier(SCRATCH), pos, f.createIdentifier(CURSOR)]),
							),
							this.assign(CAPACITY, this.bufferCall("len", [f.createIdentifier(SCRATCH)])),
						],
						true,
					),
				),
			],
		};
	}

	/** `name = value;`, for the closure-scoped cursor state. */
	public assign(name: string, value: ts.Expression): ts.Statement {
		return this.factory.createExpressionStatement(
			this.factory.createBinaryExpression(
				this.factory.createIdentifier(name),
				this.ts_.SyntaxKind.EqualsToken,
				value,
			),
		);
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
	public castTo(expr: ts.Expression, typeNode: ts.TypeNode): ts.Expression {
		const f = this.factory;
		return f.createAsExpression(
			f.createAsExpression(expr, f.createKeywordTypeNode(this.ts_.SyntaxKind.UnknownKeyword)),
			typeNode,
		);
	}

	/** `expr.size()` -- roblox-ts arrays and tuples have no `.length`; `size()` (compiling to `#expr`) is the real API. */
	public sizeOf(expr: ts.Expression): ts.Expression {
		return this.factory.createCallExpression(
			this.factory.createPropertyAccessExpression(expr, "size"),
			undefined,
			[],
		);
	}

	public bufferCall(method: string, args: ts.Expression[]): ts.Expression {
		return this.factory.createCallExpression(
			this.factory.createPropertyAccessExpression(this.factory.createIdentifier("buffer"), method),
			undefined,
			args,
		);
	}

	/**
	 * A rejection, as a thrown string so a caller's `pcall` sees the same shape
	 * it sees from the Luau `buffer` errors these replace. The message says what
	 * failed and never quotes a number out of the payload: the bytes are the
	 * hostile input, and a message is not the place to repeat them.
	 */
	public throwIf(condition: ts.Expression, message: string): ts.Statement {
		const f = this.factory;
		return f.createIfStatement(
			condition,
			f.createBlock([f.createThrowStatement(f.createStringLiteral(`${ERROR_PREFIX}${message}`))], true),
		);
	}

	/**
	 * Luau's `buffer` has no 24-bit calls, so `u24` and `i24` are a `u16` of
	 * the low bits and a `u8` of the high bits. `bit32` reduces a negative
	 * number modulo 2^32, so the same two writes store an `i24` in two's
	 * complement with no branch on the sign.
	 */
	public writeNumberAt(
		width: NumWidth,
		buf: ts.Expression,
		pos: ts.Expression,
		value: ts.Expression,
	): ts.Statement[] {
		const f = this.factory;
		if (width !== "u24" && width !== "i24") {
			return [f.createExpressionStatement(this.bufferCall(`write${width}`, [buf, pos, value]))];
		}
		const low = f.createBinaryExpression(value, this.ts_.SyntaxKind.AmpersandToken, this.num(0xffff));
		const high = f.createBinaryExpression(
			f.createParenthesizedExpression(
				f.createBinaryExpression(
					value,
					this.ts_.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
					this.num(16),
				),
			),
			this.ts_.SyntaxKind.AmpersandToken,
			this.num(0xff),
		);
		return [
			f.createExpressionStatement(this.bufferCall("writeu16", [buf, pos, low])),
			f.createExpressionStatement(this.bufferCall("writeu8", [buf, this.offsetFrom(pos, 2), high])),
		];
	}

	public readNumberAt(width: NumWidth, buf: ts.Expression, pos: ts.Expression): ts.Expression {
		const f = this.factory;
		if (width !== "u24" && width !== "i24") {
			return this.bufferCall(`read${width}`, [buf, pos]);
		}
		const unsigned = f.createBinaryExpression(
			this.bufferCall("readu16", [buf, pos]),
			this.ts_.SyntaxKind.PlusToken,
			f.createBinaryExpression(
				this.bufferCall("readu8", [buf, this.offsetFrom(pos, 2)]),
				this.ts_.SyntaxKind.AsteriskToken,
				this.num(0x10000),
			),
		);
		if (width === "u24") {
			return unsigned;
		}
		// Sign extension: flipping bit 23 and subtracting its weight maps 0x800000..0xFFFFFF to the negatives.
		return f.createBinaryExpression(
			f.createParenthesizedExpression(
				f.createBinaryExpression(
					f.createParenthesizedExpression(unsigned),
					this.ts_.SyntaxKind.CaretToken,
					this.num(0x800000),
				),
			),
			this.ts_.SyntaxKind.MinusToken,
			this.num(0x800000),
		);
	}

	/**
	 * Emits `body` with one reservation of `total` bytes shared by every
	 * field it emits. The caller has already summed `total` from
	 * `fixedBytes`, and the run is checked against it on both sides: a field
	 * that reserves more than the run has left, or leaves bytes unused, is
	 * an emitter bug and throws rather than compiling to a buffer the read
	 * side disagrees with.
	 */
	public withAllocRun(fnName: "alloc" | "readAlloc", total: number, body: () => void): void {
		const saved = this.run;
		const run: AllocRun = { fnName, total, used: 0 };
		this.run = run;
		try {
			body();
		} finally {
			this.run = saved;
		}
		if (run.used !== total) {
			throw new Error(`surge: an alloc run reserved ${total} bytes and used ${run.used}`);
		}
	}

	/** The position `offset` bytes into `slot`, as one addition and not two. */
	public at(slot: Slot, offset: number): ts.Expression {
		return this.offsetFrom(slot.pos, slot.offset + offset);
	}

	public offsetFrom(pos: ts.Expression, offset: number): ts.Expression {
		return offset === 0
			? pos
			: this.factory.createBinaryExpression(pos, this.ts_.SyntaxKind.PlusToken, this.num(offset));
	}

	/**
	 * Declares the write-side `{[name]: index}` map and read-side
	 * `EnumItem[]` for one enum field (an O(1) lookup, not the linear ternary
	 * chain this replaced -- see the enum-encoding finding in
	 * docs/research/september-2026-review.md in the surge repo; the index they
	 * hold is Wire format 4.12 in docs/specs/wire-format.md there), and
	 * returns their names, generating the
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
	public ensureEnumTable(enumName: string, members: ReadonlyArray<string>): { itemsName: string; indexName: string } {
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

	public literalValueExpr(value: string | number | boolean | undefined): ts.Expression {
		const f = this.factory;
		if (value === undefined) return f.createIdentifier("undefined");
		if (typeof value === "string") return f.createStringLiteral(value);
		if (typeof value === "number") return this.num(value);
		return value ? f.createTrue() : f.createFalse();
	}

	/**
	 * Generates the named recursive helper's write and read functions, once
	 * per name. Both sides reach it from here, and `Emitter` implements it
	 * because it is the one place that holds both.
	 */
	public abstract ensureHelper(name: string): void;
}
