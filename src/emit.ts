import type ts from "typescript";

import { FIXED_DATATYPES } from "./datatypes";
import type { ComponentWidths, CountSpec, Field, FieldKey, LengthWidth, NumWidth, ObjectFieldEntry } from "./field";
import { DEFAULT_COMPONENT_WIDTH, DEFAULT_LENGTH_WIDTH } from "./field";

/** What a `vector3`'s or a `cframe` position's absent widths mean. */
const DEFAULT_COMPONENTS: ComponentWidths = [DEFAULT_COMPONENT_WIDTH, DEFAULT_COMPONENT_WIDTH, DEFAULT_COMPONENT_WIDTH];

const WIDTH_BYTES: Record<NumWidth, number> = {
	f32: 4,
	f64: 8,
	u8: 1,
	u16: 2,
	u24: 3,
	u32: 4,
	i8: 1,
	i16: 2,
	i24: 3,
	i32: 4,
};

// Luau allows 200 registers per function, and every local the emitter
// declares holds one until its scope ends (confirmed with Lune's
// `luau.compile`: 100 `const [buf, pos] = alloc(n)` pairs in one function
// fail with "Out of local registers"). Past `LOCALS_BUDGET` live locals the
// emitter wraps runs of at most `LOCALS_PER_BLOCK` locals in a block, which
// roblox-ts compiles to `do ... end`; Luau frees a block's registers at its
// `end`. The budget leaves the rest of the 200 to parameters, loop state,
// expression temporaries, and the temporaries roblox-ts adds itself.
const LOCALS_BUDGET = 120;
const LOCALS_PER_BLOCK = 32;
// A run of K fields declares K locals: the position the reservation took, then
// one more for each field after the first. `pushScoped` cannot split a run,
// because every field after the first reads the reservation's locals, so a run
// has to fit in the block `pushScoped` would give it. The bound is one field
// short of the block, which is one more than a run now needs.
const ALLOC_RUN_FIELDS = LOCALS_PER_BLOCK - 1;

// The injected `@rbxts/surge` imports are aliased so that a user's own
// `grow` (or any other export's name), at the top level or in a scope
// enclosing the call site, can neither collide with nor shadow them.
export function importAlias(name: string): string {
	return `__surge_${name}`;
}

// The cursor state, declared in the closure each serializer is emitted into
// rather than owned by `@rbxts/surge`. A reservation is then a compare and two
// moves here instead of a call into another module, which is the whole of the
// cost on a shape with one field per element (Transformer Design §4 in
// transformer.md). They carry the import prefix for the same reason the
// aliases do: nothing a user wrote can collide with them.
const SCRATCH = importAlias("scratch");
const CAPACITY = importAlias("capacity");
const CURSOR = importAlias("cursor");
const READ_BUFFER = importAlias("input");
const READ_CURSOR = importAlias("readCursor");
const READ_LENGTH = importAlias("inputLength");
/** What a serializer starts with, doubled by `grow` from there. */
const INITIAL_CAPACITY = 64;
/** The largest form `writePackedCFrame` can write: header, position, rotation. */
const PACKED_CFRAME_MAX_BYTES = 25;
// A `cframe`'s rotation is always an f32 axis-angle triple. `DataType.Transform`
// sets the widths of the position, and of nothing else.
const ROTATION_BYTES = 12;
/** The prefix every check's message carries, so one `pcall` can tell a rejection from a bug. */
const ERROR_PREFIX = "@rbxts/surge: ";
/**
 * The largest count `checks` accepts for an element that consumes no bytes
 * (a literal constant, a blob, an object made only of those). Such an element
 * costs nothing, so the payload's own length cannot bound it and the count
 * needs a bound of its own. This is the largest count a `u24` prefix could
 * have written: a shape that means to carry more than sixteen million absent
 * or constant elements says so with a wider `DataType.Length`.
 */
const ZERO_SIZE_COUNT_CAP = 1 << 24;

function tagKeyOf(field: Extract<Field, { kind: "taggedUnion" }>): FieldKey {
	return { name: field.tagKey, numericKey: field.tagKeyNumeric };
}

interface PackedBit {
	readonly entry: ObjectFieldEntry;
	/** `present`: whether an optional has a value. `value`: a boolean. `tag`: which of a tagged union's two variants. */
	readonly role: "present" | "value" | "tag";
}

/**
 * A reserved region of the buffer: the cursor state's buffer, the position a
 * reservation took, and a byte offset into what it reserved. The offset is what
 * lets one reservation cover more than one value -- a `CFrame` reserves 24
 * bytes once and writes its position at 0 and its rotation vector at 12.
 */
interface Slot {
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
interface ScopedItem {
	readonly statements: ts.Statement[];
	readonly locals: number;
}

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
	// Locals declared so far in the function being emitted. Locals declared
	// inside a loop or branch body are never subtracted, so this overcounts;
	// the only effect is that `pushScoped` starts using blocks earlier.
	private liveLocals = 0;
	public readonly usedImports = new Set<string>();
	/**
	 * Whether either side reserved any bytes at all. A shape whose fields are
	 * all blobs reserves none, and declaring cursor state it never reads would
	 * fail a consumer's `noUnusedLocals` -- the same reason `_inputBlobs`
	 * carries an underscore.
	 */
	public usesWriteBytes = false;
	public usesReadBytes = false;
	private readonly generatedHelpers = new Set<string>();
	private readonly helperDecls: ts.Statement[] = [];
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
		private readonly ts_: typeof ts,
		private readonly factory: ts.NodeFactory,
		private readonly helperFields: ReadonlyMap<string, Field>,
		/**
		 * Emit the read-side bounds checks of the `checks` factory option
		 * (Transformer Design §7). Off, the read path is what it always was:
		 * no branch per read, and a malformed payload is a raw Luau error or
		 * worse. Per call site, so one place can hold a checked serializer for
		 * a remote boundary and an unchecked one for its own storage.
		 */
		private readonly checks = false,
	) {}

	private fresh(base: string): ts.Identifier {
		this.tempCounter += 1;
		this.liveLocals += 1;
		return this.factory.createIdentifier(`${base}${this.tempCounter}`);
	}

	/** Calls a real `@rbxts/surge` export, tracked so the file-level import statement includes it. */
	private call(name: string, args: ts.Expression[]): ts.CallExpression {
		this.usedImports.add(name);
		return this.factory.createCallExpression(this.factory.createIdentifier(importAlias(name)), undefined, args);
	}

	/** Calls a locally-generated helper function (never an import from @rbxts/surge). */
	private callLocal(name: string, args: ts.Expression[]): ts.CallExpression {
		return this.factory.createCallExpression(this.factory.createIdentifier(name), undefined, args);
	}

	/** `value.name`, or `value["my-key"]`/`value[0]` when the name isn't a valid identifier. */
	private propertyAccess(value: ts.Expression, key: FieldKey): ts.Expression {
		const name = this.propertyName(key);
		return this.ts_.isIdentifier(name)
			? this.factory.createPropertyAccessExpression(value, name)
			: this.factory.createElementAccessExpression(value, name);
	}

	private propertyName(key: FieldKey): ts.Identifier | ts.StringLiteral | ts.NumericLiteral {
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
		if (this.checks) {
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
		if (this.checks) {
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

	private letStatement(name: string, initializer: ts.Expression): ts.Statement {
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

	private measure(emit: (out: ts.Statement[]) => void): ScopedItem {
		const before = this.liveLocals;
		const statements: ts.Statement[] = [];
		emit(statements);
		return { statements, locals: this.liveLocals - before };
	}

	/** Whether the items just measured took the current function past `LOCALS_BUDGET`, so `pushScoped` will use blocks. */
	private needsBlocks(): boolean {
		return this.liveLocals > LOCALS_BUDGET;
	}

	/**
	 * Appends independently emitted items to `out`: inline while the function
	 * is within `LOCALS_BUDGET`, otherwise as consecutive blocks. No item may
	 * refer to a local that another item declares.
	 */
	private pushScoped(items: ReadonlyArray<ScopedItem>, out: ts.Statement[]): void {
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
	/**
	 * A write loop over `value[from]` up to but not including `value[to]`, for
	 * a body that indexes the value rather than iterating it. A C-style `for`
	 * and not `countedLoop`'s `$range`, because roblox-ts applies its own
	 * 0-to-1 index shift to `value[i]` and a `$range` index is already 1-based.
	 * The exact form's bound is a numeric literal, which roblox-ts can prove is
	 * an integer, so this still lowers to a numeric `for`.
	 */
	private indexedLoop(index: ts.Identifier, from: number, to: ts.Expression, body: ts.Statement[]): ts.Statement {
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

	private countedLoop(index: ts.Identifier, count: ts.Expression, body: ts.Statement[]): ts.Statement {
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
	 * this instead of returning the call expression directly (see
	 * read-order-side-effects.md).
	 */
	private bindSideEffect(expr: ts.Expression, out: ts.Statement[]): ts.Expression {
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
	private destructureAlloc(
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
	 * this four instructions instead of a call into another module. Measured,
	 * that call was worth 2.64x on a row with one field per element (What
	 * rolling the hot paths into the generated code is worth, in
	 * future-work/generated-code-performance.md).
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
			if (this.checks) {
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

	/**
	 * Reads a packed `CFrame`, whose size is in its own header, so the read
	 * cursor can only be advanced by what the call reports back.
	 */
	private readPackedCFrame(out: ts.Statement[]): ts.Expression {
		const f = this.factory;
		this.usesReadBytes = true;
		const value = this.fresh("val");
		const used = this.fresh("size");
		out.push(
			f.createVariableStatement(
				undefined,
				f.createVariableDeclarationList(
					[
						f.createVariableDeclaration(
							f.createArrayBindingPattern([
								f.createBindingElement(undefined, undefined, value),
								f.createBindingElement(undefined, undefined, used),
							]),
							undefined,
							undefined,
							this.call("readPackedCFrame", [
								f.createIdentifier(READ_BUFFER),
								f.createIdentifier(READ_CURSOR),
							]),
						),
					],
					this.ts_.NodeFlags.Const,
				),
			),
		);
		out.push(
			this.assign(
				READ_CURSOR,
				f.createBinaryExpression(f.createIdentifier(READ_CURSOR), this.ts_.SyntaxKind.PlusToken, used),
			),
		);
		return value;
	}

	/** `name = value;`, for the closure-scoped cursor state. */
	private assign(name: string, value: ts.Expression): ts.Statement {
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
				const { buf, pos, statements } = this.destructureAlloc("alloc", bytes);
				out.push(...statements);
				out.push(...this.writeNumber(field.width, buf, pos, value));
				return;
			}
			case "bool": {
				const { buf, pos, statements } = this.destructureAlloc("alloc", 1);
				out.push(...statements);
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
				const strExact = this.exactCount(field.length);
				if (strExact !== undefined) {
					const { buf, pos, statements } = this.destructureAlloc("alloc", strExact);
					out.push(...statements);
					// The fourth argument is a byte count, so a longer string is
					// truncated to it and a shorter one raises `string length overflow`.
					out.push(
						f.createExpressionStatement(this.bufferCall("writestring", [buf, pos, s, this.num(strExact)])),
					);
					return;
				}
				const strWidth = this.lengthWidth(field.length);
				const {
					buf: lbuf,
					pos: lpos,
					statements: lstmt,
				} = this.destructureAlloc("alloc", WIDTH_BYTES[strWidth]);
				out.push(...lstmt);
				out.push(...this.writeNumber(strWidth, lbuf, lpos, lenExpr));
				const { buf: sbuf, pos: spos, statements: sstmt } = this.destructureAlloc("alloc", lenExpr);
				out.push(...sstmt);
				out.push(f.createExpressionStatement(this.bufferCall("writestring", [sbuf, spos, s])));
				return;
			}
			case "vector2": {
				this.writeNum2(value, "X", "Y", "f32", out);
				return;
			}
			case "datatype": {
				this.writeDatatype(field.name, value, out);
				return;
			}
			case "buffer": {
				const source = this.fresh("src");
				out.push(this.constStatement(source, value));
				const bufferExact = this.exactCount(field.length);
				if (bufferExact !== undefined) {
					const { buf, pos, statements } = this.destructureAlloc("alloc", bufferExact);
					out.push(...statements);
					// `buffer.copy`'s count is what is read from the source, so a
					// shorter source is out of bounds and a longer one is truncated.
					out.push(
						f.createExpressionStatement(
							this.bufferCall("copy", [buf, pos, source, this.num(0), this.num(bufferExact)]),
						),
					);
					return;
				}
				const len = this.fresh("len");
				out.push(this.constStatement(len, this.bufferCall("len", [source])));
				const bufferWidth = this.lengthWidth(field.length);
				const {
					buf: lbuf,
					pos: lpos,
					statements: lstmt,
				} = this.destructureAlloc("alloc", WIDTH_BYTES[bufferWidth]);
				out.push(...lstmt);
				out.push(...this.writeNumber(bufferWidth, lbuf, lpos, len));
				const { buf, pos, statements } = this.destructureAlloc("alloc", len);
				out.push(...statements);
				out.push(f.createExpressionStatement(this.bufferCall("copy", [buf, pos, source, this.num(0), len])));
				return;
			}
			case "vector3": {
				const widths = this.componentsOf(field.components);
				const { buf, pos, statements } = this.destructureAlloc("alloc", this.componentBytes(widths));
				out.push(...statements);
				this.writeNum3(value, "X", "Y", "Z", widths, { buf, pos, offset: 0 }, out);
				return;
			}
			case "color3": {
				this.writeColor3(value, out);
				return;
			}
			case "cframe": {
				if (field.packed) {
					// The packed form branches on the value, so it is a runtime function
					// (cframe.ts in @rbxts/surge) and not inlined code. It writes 1, 13 or
					// 25 bytes: reserve the largest, then pull the cursor back to what it
					// actually used. Reserving first is what guarantees the room.
					const { buf, pos, statements } = this.destructureAlloc("alloc", PACKED_CFRAME_MAX_BYTES);
					out.push(...statements);
					out.push(
						this.assign(
							CURSOR,
							this.factory.createBinaryExpression(
								pos,
								this.ts_.SyntaxKind.PlusToken,
								this.call("writePackedCFrame", [buf, pos, value]),
							),
						),
					);
					return;
				}
				this.writeCFrame(value, field.position, out);
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
				const { buf, pos, statements } = this.destructureAlloc("alloc", bytes);
				out.push(...statements);
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
				const arrayExact = this.exactCount(field.length);
				if (arrayExact !== undefined) {
					// Indexed rather than `for...of`, so exactly this many are
					// written however many the value holds. A longer one is
					// ignored past the bound. A shorter one writes `nil`
					// elements, which raises for every element kind but an
					// optional -- `nil` is what an absent optional writes, so
					// there it pads instead (pinned in collections.spec.ts).
					const i = this.fresh("i");
					const body: ts.Statement[] = [];
					this.writeField(field.element, f.createElementAccessExpression(arr, i), body);
					out.push(this.indexedLoop(i, 0, this.num(arrayExact), body));
					return;
				}
				const arrayWidth = this.lengthWidth(field.length);
				const { buf, pos, statements } = this.destructureAlloc("alloc", WIDTH_BYTES[arrayWidth]);
				out.push(...statements);
				out.push(...this.writeNumber(arrayWidth, buf, pos, this.sizeOf(arr)));
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
				this.pushScoped(
					field.fixed.map((elementField, i) =>
						this.measure((itemOut) =>
							this.writeField(elementField, f.createElementAccessExpression(tup, this.num(i)), itemOut),
						),
					),
					out,
				);
				if (field.rest) {
					const fixedCount = field.fixed.length;
					const restExact = this.exactCount(field.length);
					if (restExact !== undefined) {
						const i = this.fresh("i");
						const body: ts.Statement[] = [];
						this.writeField(
							field.rest,
							this.castTo(f.createElementAccessExpression(tup, i), this.fieldToTypeNode(field.rest)),
							body,
						);
						out.push(this.indexedLoop(i, fixedCount, this.num(fixedCount + restExact), body));
						return;
					}
					const restCountExpr = f.createBinaryExpression(
						this.sizeOf(tup),
						this.ts_.SyntaxKind.MinusToken,
						this.num(fixedCount),
					);
					const restWidth = this.lengthWidth(field.length);
					const { buf, pos, statements } = this.destructureAlloc("alloc", WIDTH_BYTES[restWidth]);
					out.push(...statements);
					out.push(...this.writeNumber(restWidth, buf, pos, restCountExpr));
					const i = this.fresh("i");
					const body: ts.Statement[] = [];
					// `tup[i]` has the union of every element type; the index is
					// past the fixed elements, so it is a rest element.
					this.writeField(
						field.rest,
						this.castTo(f.createElementAccessExpression(tup, i), this.fieldToTypeNode(field.rest)),
						body,
					);
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
				this.writeOptional(field, value, out, true);
				return;
			}
			case "literalConst": {
				return; // zero bytes -- known on both ends at compile time.
			}
			case "literal": {
				const { buf, pos, statements } = this.destructureAlloc("alloc", field.values.length <= 256 ? 1 : 2);
				out.push(...statements);
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
				// `pushBlob` takes `defined`, and the static type of a blob can be `unknown`.
				const asDefined = this.castTo(value, f.createTypeReferenceNode("defined"));
				out.push(f.createExpressionStatement(this.call("pushBlob", [asDefined])));
				return;
			}
		}
	}

	/**
	 * The width of the count a variable-length kind writes ahead of its
	 * contents. Absent means `u32`, which is what all five of them wrote
	 * before `DataType.Length<T, L>` existed, so an unbranded shape's bytes
	 * do not move (see field.ts).
	 */
	private lengthWidth(length: CountSpec | undefined): LengthWidth {
		return typeof length === "number" ? DEFAULT_LENGTH_WIDTH : (length ?? DEFAULT_LENGTH_WIDTH);
	}

	/**
	 * The element or byte count of the exact form, where no count is written
	 * at all and both sides use this number, or `undefined` for the counted
	 * form. The value has to have exactly this many: a longer one is
	 * truncated, and a shorter one raises wherever writing the missing part
	 * touches it -- except for an optional element, which pads. The type
	 * states the length and nothing checks it until write-side validation
	 * lands (data-type-surface.md).
	 */
	private exactCount(length: CountSpec | undefined): number | undefined {
		return typeof length === "number" ? length : undefined;
	}

	/**
	 * A rejection, as a thrown string so a caller's `pcall` sees the same shape
	 * it sees from the Luau `buffer` errors these replace. The message says what
	 * failed and never quotes a number out of the payload: the bytes are the
	 * hostile input, and a message is not the place to repeat them.
	 */
	private throwIf(condition: ts.Expression, message: string): ts.Statement {
		const f = this.factory;
		return f.createIfStatement(
			condition,
			f.createBlock([f.createThrowStatement(f.createStringLiteral(`${ERROR_PREFIX}${message}`))], true),
		);
	}

	/**
	 * A lower bound on the bytes `field` reads, used to reject a count no
	 * payload of this length could hold. It must never overstate: a bound above
	 * what a valid value actually costs would reject that value. Anything whose
	 * cost depends on the payload contributes what it cannot avoid writing --
	 * a container its count, an optional nothing, a blob nothing -- and a
	 * recursive reference contributes nothing at all.
	 */
	private minBytes(field: Field): number {
		switch (field.kind) {
			case "num":
				return WIDTH_BYTES[field.width];
			case "bool":
				return field.packed ? 0 : 1;
			case "vector2":
				return 8;
			case "vector3":
				return this.componentBytes(field.components);
			case "color3":
				return 3;
			case "cframe":
				// The packed form's smallest value is its header alone.
				return field.packed ? 1 : this.componentBytes(field.position) + ROTATION_BYTES;
			case "datatype":
				return FIXED_DATATYPES[field.name].components.reduce(
					(total, component) => total + WIDTH_BYTES[component.width],
					0,
				);
			case "enum":
				return field.members.length <= 256 ? 1 : 2;
			case "literal":
				return field.values.length <= 256 ? 1 : 2;
			case "colorSequence":
			case "numberSequence":
				// The keypoint count, with no keypoints behind it.
				return 1;
			case "str":
			case "buffer":
			case "array":
			case "dict":
				return this.countBytes(field.length);
			case "tuple":
				return (
					field.fixed.reduce((total, element) => total + this.minBytes(element), 0) +
					(field.rest === undefined ? 0 : this.countBytes(field.length))
				);
			case "object":
				// The packed region is left out rather than counted: it is bytes a
				// valid value does read, so leaving it out only lowers the bound.
				// An object whose fields are all packed therefore bounds at zero and
				// falls to the cap, which rejects the same payloads a byte at a time
				// later. Counting the region would be tighter and is not worth the
				// risk of counting it differently from the emitter.
				return field.fields.reduce((total, entry) => total + this.minBytes(entry.field), 0);
			case "taggedUnion":
				// The tag is an index of the same width a `literal` uses, except
				// where the enclosing object's packed region holds it as one bit --
				// which only a direct property of such an object does, so a packed
				// two-variant union elsewhere still reads a byte this leaves out.
				return (
					(field.packed === true && field.variants.length === 2 ? 0 : field.variants.length <= 256 ? 1 : 2) +
					Math.min(
						...field.variants.map((variant) =>
							variant.fields.reduce((total, entry) => total + this.minBytes(entry.field), 0),
						),
					)
				);
			case "guardedUnion":
				return 1 + Math.min(...field.variants.map((variant) => this.minBytes(variant)));
			// An `optional` may be absent, a `blob` travels outside the buffer, a
			// `literalConst` is the type itself, and a `recursiveRef` cannot be
			// bounded without walking itself.
			case "optional":
				return field.packed ? 0 : 1;
			case "blob":
			case "literalConst":
			case "recursiveRef":
				return 0;
		}
	}

	/** The bytes a count of its own costs: none in the exact form, which writes no count. */
	private countBytes(length: CountSpec | undefined): number {
		return this.exactCount(length) === undefined ? WIDTH_BYTES[this.lengthWidth(length)] : 0;
	}

	/**
	 * Rejects a count the rest of the payload cannot hold. An element with a
	 * minimum size gives a bound in bytes; one that costs nothing (a constant, a
	 * blob) has no such bound, so the count itself is capped -- that case is the
	 * denial of service, where a short payload declares billions of elements and
	 * the loop runs every one.
	 */
	private checkCount(count: ts.Expression, element: Field, out: ts.Statement[]): void {
		this.checkCountOfBytes(count, this.minBytes(element), out);
	}

	/** {@link checkCount} for a `dict`, whose entry is a key and, unless it is a set, a value. */
	private checkEntryCount(count: ts.Expression, field: Extract<Field, { kind: "dict" }>, out: ts.Statement[]): void {
		const value = field.value;
		this.checkCountOfBytes(count, this.minBytes(field.key) + (value === undefined ? 0 : this.minBytes(value)), out);
	}

	private checkCountOfBytes(count: ts.Expression, min: number, out: ts.Statement[]): void {
		if (!this.checks) {
			return;
		}
		const f = this.factory;
		if (min === 0) {
			out.push(
				this.throwIf(
					f.createBinaryExpression(
						count,
						this.ts_.SyntaxKind.GreaterThanToken,
						this.num(ZERO_SIZE_COUNT_CAP),
					),
					"deserialize found a count past the limit for an element that reads no bytes",
				),
			);
			return;
		}
		const needed =
			min === 1 ? count : f.createBinaryExpression(count, this.ts_.SyntaxKind.AsteriskToken, this.num(min));
		out.push(
			this.throwIf(
				f.createBinaryExpression(
					needed,
					this.ts_.SyntaxKind.GreaterThanToken,
					f.createBinaryExpression(
						f.createIdentifier(READ_LENGTH),
						this.ts_.SyntaxKind.MinusToken,
						f.createIdentifier(READ_CURSOR),
					),
				),
				"deserialize found a count larger than the input buffer can hold",
			),
		);
	}

	/** The widths a `vector3`'s or a `cframe` position's components are stored at, with absence resolved. */
	private componentsOf(widths?: ComponentWidths): ComponentWidths {
		return widths ?? DEFAULT_COMPONENTS;
	}

	private componentBytes(widths?: ComponentWidths): number {
		return this.componentsOf(widths).reduce((total, width) => total + WIDTH_BYTES[width], 0);
	}

	/**
	 * Luau's `buffer` has no 24-bit calls, so `u24` and `i24` are a `u16` of
	 * the low bits and a `u8` of the high bits. `bit32` reduces a negative
	 * number modulo 2^32, so the same two writes store an `i24` in two's
	 * complement with no branch on the sign.
	 */
	private writeNumber(width: NumWidth, buf: ts.Expression, pos: ts.Expression, value: ts.Expression): ts.Statement[] {
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

	private readNumber(width: NumWidth, buf: ts.Expression, pos: ts.Expression): ts.Expression {
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

	/** `pos`, or `pos + offset` past the first component of a fixed-size value. */
	/**
	 * The bytes a field always reserves, in one piece, from one
	 * `alloc`/`readAlloc` at the start of its emission -- or `undefined`
	 * when it reserves nothing of the kind: a size known only at run time
	 * (`str`, `buffer`), a reservation around a branch or a loop
	 * (`optional`, `array`, `dict`, the sequences, both unions), one made
	 * inside a runtime function (a packed `cframe`) or a generated helper
	 * (`object`, `recursiveRef`), or a side-table entry (`blob`).
	 *
	 * Only the fields this admits may share a reservation with their
	 * neighbours, because `alloc` order is byte order: anything that
	 * reserves for itself in the middle of a run would write its bytes after
	 * the run's, and the read side reads them where it put them.
	 */
	private fixedBytes(field: Field): number | undefined {
		switch (field.kind) {
			case "num":
				return WIDTH_BYTES[field.width];
			case "bool":
				return 1;
			case "vector2":
				return 8;
			case "vector3":
				return this.componentBytes(field.components);
			case "color3":
				return 3;
			case "cframe":
				return field.packed ? undefined : this.componentBytes(field.position) + ROTATION_BYTES;
			case "datatype":
				return FIXED_DATATYPES[field.name].components.reduce(
					(total, component) => total + WIDTH_BYTES[component.width],
					0,
				);
			case "enum":
				return field.members.length <= 256 ? 1 : 2;
			case "literal":
				return field.values.length <= 256 ? 1 : 2;
			case "literalConst":
				return 0;
			default:
				return undefined;
		}
	}

	/**
	 * Splits `entries` into the groups one reservation can cover: a maximal
	 * run of neighbours `shareable` accepts, or a single entry it does not.
	 * A run of one is returned as a group of one, so the caller emits it the
	 * way it always did. Runs stop at `ALLOC_RUN_FIELDS` so that one always
	 * fits in a block.
	 */
	private allocRuns<T>(entries: ReadonlyArray<T>, shareable: (entry: T) => boolean): Array<Array<T>> {
		const groups: Array<Array<T>> = [];
		for (const entry of entries) {
			const last = groups[groups.length - 1];
			if (last !== undefined && last.length < ALLOC_RUN_FIELDS && shareable(entry) && shareable(last[0])) {
				last.push(entry);
			} else {
				groups.push([entry]);
			}
		}
		return groups;
	}

	/**
	 * Emits `body` with one reservation of `total` bytes shared by every
	 * field it emits. The caller has already summed `total` from
	 * `fixedBytes`, and the run is checked against it on both sides: a field
	 * that reserves more than the run has left, or leaves bytes unused, is
	 * an emitter bug and throws rather than compiling to a buffer the read
	 * side disagrees with.
	 */
	private withAllocRun(fnName: "alloc" | "readAlloc", total: number, body: () => void): void {
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
	private at(slot: Slot, offset: number): ts.Expression {
		return this.offsetFrom(slot.pos, slot.offset + offset);
	}

	private offsetFrom(pos: ts.Expression, offset: number): ts.Expression {
		return offset === 0
			? pos
			: this.factory.createBinaryExpression(pos, this.ts_.SyntaxKind.PlusToken, this.num(offset));
	}

	private writeDatatype(name: string, value: ts.Expression, out: ts.Statement[]): void {
		const f = this.factory;
		const { components } = FIXED_DATATYPES[name];
		const size = components.reduce((total, component) => total + WIDTH_BYTES[component.width], 0);
		const { buf, pos, statements } = this.destructureAlloc("alloc", size);
		out.push(...statements);
		let offset = 0;
		for (const component of components) {
			const read = component.path.reduce<ts.Expression>(
				(target, key) => f.createPropertyAccessExpression(target, key),
				value,
			);
			out.push(
				f.createExpressionStatement(
					this.bufferCall(`write${component.width}`, [buf, this.offsetFrom(pos, offset), read]),
				),
			);
			offset += WIDTH_BYTES[component.width];
		}
	}

	private readDatatype(name: string, out: ts.Statement[]): ts.Expression {
		const f = this.factory;
		const { components, factoryMethod } = FIXED_DATATYPES[name];
		const size = components.reduce((total, component) => total + WIDTH_BYTES[component.width], 0);
		const { buf, pos, statements } = this.destructureAlloc("readAlloc", size);
		out.push(...statements);
		let offset = 0;
		const args = components.map((component) => {
			const read = this.bufferCall(`read${component.width}`, [buf, this.offsetFrom(pos, offset)]);
			offset += WIDTH_BYTES[component.width];
			return read;
		});
		return factoryMethod === undefined
			? f.createNewExpression(f.createIdentifier(name), undefined, args)
			: f.createCallExpression(
					f.createPropertyAccessExpression(f.createIdentifier(name), factoryMethod),
					undefined,
					args,
				);
	}

	private writeNum2(value: ts.Expression, a: string, b: string, width: "f32", out: ts.Statement[]): void {
		const f = this.factory;
		const { buf, pos, statements } = this.destructureAlloc("alloc", 8);
		out.push(...statements);
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
	}

	/**
	 * Writes three components, each at its own width, into the bytes `slot`
	 * starts at. The caller reserves `componentBytes(widths)` of them.
	 */
	private writeNum3(
		value: ts.Expression,
		a: string,
		b: string,
		c: string,
		widths: ComponentWidths,
		slot: Slot,
		out: ts.Statement[],
	): void {
		const f = this.factory;
		let offset = 0;
		[a, b, c].forEach((component, i) => {
			out.push(
				...this.writeNumber(
					widths[i],
					slot.buf,
					this.at(slot, offset),
					f.createPropertyAccessExpression(value, component),
				),
			);
			offset += WIDTH_BYTES[widths[i]];
		});
	}

	private writeColor3(value: ts.Expression, out: ts.Statement[]): void {
		const f = this.factory;
		const { buf, pos, statements } = this.destructureAlloc("alloc", 3);
		out.push(...statements);
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

	private writeCFrame(value: ts.Expression, position: ComponentWidths | undefined, out: ts.Statement[]): void {
		const f = this.factory;
		const widths = this.componentsOf(position);
		const positionBytes = this.componentBytes(widths);
		// One reservation for both halves. `ToAxisAngle` and `Vector3.mul`
		// sit between the two writes, and neither can grow the scratch
		// buffer, so `buf` is still the buffer `alloc` handed back when the
		// rotation is written.
		const { buf, pos, statements } = this.destructureAlloc("alloc", positionBytes + ROTATION_BYTES);
		out.push(...statements);
		this.writeNum3(
			f.createPropertyAccessExpression(value, "Position"),
			"X",
			"Y",
			"Z",
			widths,
			{ buf, pos, offset: 0 },
			out,
		);
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
		this.writeNum3(rv, "X", "Y", "Z", DEFAULT_COMPONENTS, { buf, pos, offset: positionBytes }, out);
	}

	private writeSequence(value: ts.Expression, kind: "ColorSequence" | "NumberSequence", out: ts.Statement[]): void {
		const f = this.factory;
		const keypoints = this.fresh("keypoints");
		out.push(this.constStatement(keypoints, f.createPropertyAccessExpression(value, "Keypoints")));
		const { buf, pos, statements } = this.destructureAlloc("alloc", 1);
		out.push(...statements);
		out.push(f.createExpressionStatement(this.bufferCall("writeu8", [buf, pos, this.sizeOf(keypoints)])));
		const kp = this.fresh("kp");
		const body: ts.Statement[] = [];
		const { buf: kbuf, pos: kpos, statements: kstmt } = this.destructureAlloc("alloc", 4);
		body.push(...kstmt);
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
			const { buf: vbuf, pos: vpos, statements: vstmt } = this.destructureAlloc("alloc", 8);
			body.push(...vstmt);
			body.push(
				f.createExpressionStatement(
					this.bufferCall("writef32", [vbuf, vpos, f.createPropertyAccessExpression(kp, "Value")]),
				),
			);
			// fbs drops the envelope. It is part of the value, so it is kept here.
			body.push(
				f.createExpressionStatement(
					this.bufferCall("writef32", [
						vbuf,
						this.offsetFrom(vpos, 4),
						f.createPropertyAccessExpression(kp, "Envelope"),
					]),
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
		const countWidth = this.lengthWidth(field.length);
		const { buf: cbuf, pos: cpos, statements: cstmt } = this.destructureAlloc("alloc", WIDTH_BYTES[countWidth]);
		out.push(...cstmt);
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
		out.push(...this.writeNumber(countWidth, cbuf, cpos, count));
	}

	private writeObject(field: Extract<Field, { kind: "object" }>, value: ts.Expression, out: ts.Statement[]): void {
		if (field.helperName) {
			this.ensureHelper(field.helperName);
			out.push(this.factory.createExpressionStatement(this.callLocal(`${field.helperName}_write`, [value])));
			return;
		}
		this.writeObjectInline(field.fields, value, out);
	}

	/**
	 * The bits of an object's packed region, in wire order. Both sides build
	 * the region from this one list, so the bit order cannot differ between
	 * them. A packed `boolean` is one value bit. A packed `optional` is one
	 * presence bit, and an optional packed `boolean` is a presence bit and a
	 * value bit with no bytes of its own. A packed tagged union with two
	 * variants is one tag bit, set for the second variant.
	 */
	private packedBits(fields: ReadonlyArray<ObjectFieldEntry>): PackedBit[] {
		const bits: PackedBit[] = [];
		for (const entry of fields) {
			const field = entry.field;
			if (field.kind === "bool" && field.packed) {
				bits.push({ entry, role: "value" });
			} else if (field.kind === "optional" && field.packed) {
				bits.push({ entry, role: "present" });
				if (field.inner.kind === "bool" && field.inner.packed) {
					bits.push({ entry, role: "value" });
				}
			} else if (field.kind === "taggedUnion" && field.packed && field.variants.length === 2) {
				bits.push({ entry, role: "tag" });
			}
		}
		return bits;
	}

	/** Whether the packed region holds all of this field, so it writes nothing in the field sequence. */
	private isAllPackedBits(field: Field): boolean {
		if (field.kind === "bool") {
			return field.packed;
		}
		return field.kind === "optional" && field.packed && field.inner.kind === "bool" && field.inner.packed;
	}

	private writeObjectInline(
		fields: ReadonlyArray<ObjectFieldEntry>,
		value: ts.Expression,
		out: ts.Statement[],
	): void {
		// The packed region comes first: the read side needs an optional's
		// presence bit before it reaches that optional's value.
		const bits = this.packedBits(fields);
		const items: ScopedItem[] = [];
		if (bits.length > 0) {
			items.push(this.measure((itemOut) => this.writePackedBits(bits, value, itemOut)));
		}
		// A field whose bytes the packed region already holds writes nothing
		// here; one whose presence or tag is a bit writes the rest of itself
		// through its own path, so neither can share a reservation.
		const written = fields.filter((entry) => !this.isAllPackedBits(entry.field));
		const shareable = (entry: ObjectFieldEntry) =>
			!bits.some((bit) => bit.entry === entry) && this.fixedBytes(entry.field) !== undefined;
		for (const group of this.allocRuns(written, shareable)) {
			if (group.length > 1) {
				const total = group.reduce((sum, entry) => sum + this.fixedBytes(entry.field)!, 0);
				items.push(
					this.measure((itemOut) => {
						this.withAllocRun("alloc", total, () => {
							for (const entry of group) {
								this.writeField(entry.field, this.propertyAccess(value, entry), itemOut);
							}
						});
					}),
				);
				continue;
			}
			const entry = group[0];
			const field = entry.field;
			items.push(
				this.measure((itemOut) => {
					const property = this.propertyAccess(value, entry);
					if (field.kind === "optional" && field.packed) {
						this.writeOptional(field, property, itemOut, false);
					} else if (bits.some((bit) => bit.entry === entry && bit.role === "tag")) {
						this.writeTaggedUnion(
							field as Extract<Field, { kind: "taggedUnion" }>,
							property,
							itemOut,
							false,
						);
					} else {
						this.writeField(field, property, itemOut);
					}
				}),
			);
		}
		this.pushScoped(items, out);
	}

	private writeOptional(
		field: Extract<Field, { kind: "optional" }>,
		value: ts.Expression,
		out: ts.Statement[],
		writeFlag: boolean,
	): void {
		const f = this.factory;
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
		// Without the flag, the presence bit is in the enclosing object's packed region.
		if (writeFlag) {
			const { buf, pos, statements } = this.destructureAlloc("alloc", 1);
			out.push(...statements);
			out.push(
				f.createExpressionStatement(
					this.bufferCall("writeu8", [
						buf,
						pos,
						f.createConditionalExpression(isPresent(tmp), undefined, this.num(1), undefined, this.num(0)),
					]),
				),
			);
		}
		const innerStatements: ts.Statement[] = [];
		this.writeField(field.inner, tmp, innerStatements);
		out.push(f.createIfStatement(isPresent(tmp), f.createBlock(innerStatements, true)));
	}

	private writePackedBits(bits: ReadonlyArray<PackedBit>, value: ts.Expression, out: ts.Statement[]): void {
		const f = this.factory;
		const byteCount = Math.ceil(bits.length / 8);
		const { buf, pos, statements } = this.destructureAlloc("alloc", byteCount);
		out.push(...statements);
		// One `writeu8` per byte, computed from all its bits at once, rather
		// than one `packBit` call per bit into the reused scratch region:
		// `alloc()` doesn't zero a region it didn't just grow into, so a
		// bit-at-a-time write would leave any bit past `bits.length`
		// holding whatever an earlier `serialize()` call left there (see
		// wire-format-determinism.md). Computing the whole byte writes every
		// bit, including the unused high ones (implicitly zero), so the
		// result is deterministic by construction.
		for (let byteIndex = 0; byteIndex < byteCount; byteIndex++) {
			const chunk = bits.slice(byteIndex * 8, byteIndex * 8 + 8);
			const byteExpr = this.packedByteExpr(chunk, value);
			out.push(
				f.createExpressionStatement(
					this.bufferCall("writeu8", [buf, this.offsetFrom(pos, byteIndex), byteExpr]),
				),
			);
		}
	}

	/** Sums `1 << bitIndex` for each set bit in `bits` (bit 0 = the byte's least-significant bit, matching `unpackBit`'s `buffer.readbits`). */
	private packedByteExpr(bits: ReadonlyArray<PackedBit>, value: ts.Expression): ts.Expression {
		const f = this.factory;
		let expr: ts.Expression | undefined;
		bits.forEach(({ entry, role }, bitIndex) => {
			const property = this.propertyAccess(value, entry);
			let condition: ts.Expression = property;
			if (role === "tag" && entry.field.kind === "taggedUnion") {
				condition = f.createBinaryExpression(
					this.propertyAccess(property, tagKeyOf(entry.field)),
					this.ts_.SyntaxKind.EqualsEqualsEqualsToken,
					this.literalValueExpr(entry.field.variants[1].tagValue),
				);
			} else if (role === "present") {
				condition = f.createBinaryExpression(
					property,
					this.ts_.SyntaxKind.ExclamationEqualsEqualsToken,
					f.createIdentifier("undefined"),
				);
			} else if (entry.field.kind === "optional") {
				// The value bit of an optional boolean: `undefined` is not a condition TypeScript accepts.
				condition = f.createBinaryExpression(
					property,
					this.ts_.SyntaxKind.EqualsEqualsEqualsToken,
					f.createTrue(),
				);
			}
			const term = f.createConditionalExpression(
				condition,
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
		// `false` when the enclosing object's packed region holds the tag as one bit.
		writeIndex = true,
	): void {
		const f = this.factory;
		const tagExpr = this.propertyAccess(value, tagKeyOf(field));
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
		if (writeIndex) {
			const { buf, pos, statements } = this.destructureAlloc("alloc", idxBytes);
			out.push(...statements);
			out.push(
				f.createExpressionStatement(this.bufferCall(idxBytes === 1 ? "writeu8" : "writeu16", [buf, pos, idx])),
			);
		}

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
		const { buf, pos, statements } = this.destructureAlloc("alloc", idxBytes);
		out.push(...statements);
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
			// A `recursiveRef` is a table too: only an object type or a union is
			// ever walked into a helper, and a union is never a member of
			// another union.
			case "object":
			case "array":
			case "tuple":
			case "dict":
			case "recursiveRef":
				return typeIs("table");
			case "vector2":
				return typeIs("Vector2");
			case "datatype":
				return typeIs(field.name);
			case "buffer":
				return typeIs("buffer");
			case "vector3":
				return typeIs("Vector3");
			case "cframe":
				return typeIs("CFrame");
			case "color3":
				return typeIs("Color3");
			case "colorSequence":
				return typeIs("ColorSequence");
			case "numberSequence":
				return typeIs("NumberSequence");
			case "enum":
				return typeIs("EnumItem");
			default:
				// `classifyUnion` in walk.ts reports a diagnostic for every other
				// kind, so none of them reaches the emitter.
				throw new Error(`surge: internal error -- no union guard for a "${field.kind}" variant`);
		}
	}

	// ---- READ -------------------------------------------------------------

	public readField(field: Field, out: ts.Statement[]): ts.Expression {
		const f = this.factory;
		switch (field.kind) {
			case "num": {
				const bytes = WIDTH_BYTES[field.width];
				const { buf, pos, statements } = this.destructureAlloc("readAlloc", bytes);
				out.push(...statements);
				return this.readNumber(field.width, buf, pos);
			}
			case "bool": {
				const { buf, pos, statements } = this.destructureAlloc("readAlloc", 1);
				out.push(...statements);
				return f.createBinaryExpression(
					this.bufferCall("readu8", [buf, pos]),
					this.ts_.SyntaxKind.ExclamationEqualsEqualsToken,
					this.num(0),
				);
			}
			case "str": {
				const strExact = this.exactCount(field.length);
				if (strExact !== undefined) {
					const { buf, pos, statements } = this.destructureAlloc("readAlloc", strExact);
					out.push(...statements);
					return this.bufferCall("readstring", [buf, pos, this.num(strExact)]);
				}
				const strWidth = this.lengthWidth(field.length);
				const {
					buf: lbuf,
					pos: lpos,
					statements: lstmt,
				} = this.destructureAlloc("readAlloc", WIDTH_BYTES[strWidth]);
				out.push(...lstmt);
				const len = this.fresh("len");
				out.push(this.constStatement(len, this.readNumber(strWidth, lbuf, lpos)));
				const { buf: sbuf, pos: spos, statements: sstmt } = this.destructureAlloc("readAlloc", len);
				out.push(...sstmt);
				return this.bufferCall("readstring", [sbuf, spos, len]);
			}
			case "vector2": {
				const [x, y] = this.readNum2("f32", out);
				return f.createNewExpression(f.createIdentifier("Vector2"), undefined, [x, y]);
			}
			case "datatype": {
				return this.readDatatype(field.name, out);
			}
			case "buffer": {
				const bufferExact = this.exactCount(field.length);
				if (bufferExact !== undefined) {
					const { buf, pos, statements } = this.destructureAlloc("readAlloc", bufferExact);
					out.push(...statements);
					const exactResult = this.fresh("bytes");
					out.push(this.constStatement(exactResult, this.bufferCall("create", [this.num(bufferExact)])));
					out.push(
						f.createExpressionStatement(
							this.bufferCall("copy", [exactResult, this.num(0), buf, pos, this.num(bufferExact)]),
						),
					);
					return exactResult;
				}
				const bufferWidth = this.lengthWidth(field.length);
				const {
					buf: lbuf,
					pos: lpos,
					statements: lstmt,
				} = this.destructureAlloc("readAlloc", WIDTH_BYTES[bufferWidth]);
				out.push(...lstmt);
				const len = this.fresh("len");
				out.push(this.constStatement(len, this.readNumber(bufferWidth, lbuf, lpos)));
				const { buf, pos, statements } = this.destructureAlloc("readAlloc", len);
				out.push(...statements);
				// A copy: the input buffer holds the whole payload, and the caller owns the result.
				const result = this.fresh("bytes");
				out.push(this.constStatement(result, this.bufferCall("create", [len])));
				out.push(f.createExpressionStatement(this.bufferCall("copy", [result, this.num(0), buf, pos, len])));
				return result;
			}
			case "vector3": {
				const widths = this.componentsOf(field.components);
				const { buf, pos, statements } = this.destructureAlloc("readAlloc", this.componentBytes(widths));
				out.push(...statements);
				const [x, y, z] = this.readNum3(widths, { buf, pos, offset: 0 });
				return f.createNewExpression(f.createIdentifier("Vector3"), undefined, [x, y, z]);
			}
			case "color3": {
				return this.readColor3(out);
			}
			case "cframe": {
				return field.packed ? this.readPackedCFrame(out) : this.readCFrame(field.position, out);
			}
			case "colorSequence": {
				return this.readSequence("ColorSequence", out);
			}
			case "numberSequence": {
				return this.readSequence("NumberSequence", out);
			}
			case "enum": {
				const bytes = field.members.length <= 256 ? 1 : 2;
				const { buf, pos, statements } = this.destructureAlloc("readAlloc", bytes);
				out.push(...statements);
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
				// The exact form writes no count, so the loop bound is the
				// literal the type carries instead of a value read back.
				const arrayExact = this.exactCount(field.length);
				let count: ts.Expression;
				if (arrayExact === undefined) {
					const arrayWidth = this.lengthWidth(field.length);
					const { buf, pos, statements } = this.destructureAlloc("readAlloc", WIDTH_BYTES[arrayWidth]);
					out.push(...statements);
					const countLocal = this.fresh("count");
					out.push(this.constStatement(countLocal, this.readNumber(arrayWidth, buf, pos)));
					this.checkCount(countLocal, field.element, out);
					count = countLocal;
				} else {
					count = this.num(arrayExact);
				}
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
				const i = this.fresh("_i");
				const body: ts.Statement[] = [];
				const itemExpr = this.readField(field.element, body);
				body.push(
					f.createExpressionStatement(
						f.createCallExpression(f.createPropertyAccessExpression(result, "push"), undefined, [itemExpr]),
					),
				);
				out.push(this.countedLoop(i, count, body));
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
				this.pushScoped(
					field.fixed.map((elementField) =>
						this.measure((itemOut) => {
							const elementExpr = this.readField(elementField, itemOut);
							itemOut.push(
								f.createExpressionStatement(
									f.createCallExpression(
										f.createPropertyAccessExpression(result, "push"),
										undefined,
										[elementExpr],
									),
								),
							);
						}),
					),
					out,
				);
				if (field.rest) {
					const restExact = this.exactCount(field.length);
					let count: ts.Expression;
					if (restExact === undefined) {
						const restWidth = this.lengthWidth(field.length);
						const { buf, pos, statements } = this.destructureAlloc("readAlloc", WIDTH_BYTES[restWidth]);
						out.push(...statements);
						const countLocal = this.fresh("count");
						out.push(this.constStatement(countLocal, this.readNumber(restWidth, buf, pos)));
						this.checkCount(countLocal, field.rest, out);
						count = countLocal;
					} else {
						count = this.num(restExact);
					}
					const i = this.fresh("_i");
					const body: ts.Statement[] = [];
					const restExpr = this.readField(field.rest, body);
					body.push(
						f.createExpressionStatement(
							f.createCallExpression(f.createPropertyAccessExpression(result, "push"), undefined, [
								restExpr,
							]),
						),
					);
					out.push(this.countedLoop(i, count, body));
				}
				// `result` is inferred as an array of the union of what was
				// pushed, which is not assignable to a tuple type.
				return this.castTo(result, this.fieldToTypeNode(field));
			}
			case "dict": {
				return this.readDict(field, out);
			}
			case "optional": {
				return this.readOptional(field, out, undefined);
			}
			case "literalConst": {
				return this.literalValueExpr(field.value);
			}
			case "literal": {
				const bytes = field.values.length <= 256 ? 1 : 2;
				const { buf, pos, statements } = this.destructureAlloc("readAlloc", bytes);
				out.push(...statements);
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

	private readNum2(width: "f32", out: ts.Statement[]): [ts.Expression, ts.Expression] {
		const { buf, pos, statements } = this.destructureAlloc("readAlloc", 8);
		out.push(...statements);
		const x = this.bufferCall(`read${width}`, [buf, pos]);
		const y = this.bufferCall(`read${width}`, [
			buf,
			this.factory.createBinaryExpression(pos, this.ts_.SyntaxKind.PlusToken, this.num(4)),
		]);
		return [x, y];
	}

	/** Reads what {@link writeNum3} wrote at `slot`, mirroring its widths and offsets. */
	private readNum3(widths: ComponentWidths, slot: Slot): [ts.Expression, ts.Expression, ts.Expression] {
		let offset = 0;
		const component = (i: number) => {
			const read = this.readNumber(widths[i], slot.buf, this.at(slot, offset));
			offset += WIDTH_BYTES[widths[i]];
			return read;
		};
		return [component(0), component(1), component(2)];
	}

	private readColor3(out: ts.Statement[]): ts.Expression {
		const f = this.factory;
		const { buf, pos, statements } = this.destructureAlloc("readAlloc", 3);
		out.push(...statements);
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

	private readCFrame(position: ComponentWidths | undefined, out: ts.Statement[]): ts.Expression {
		const f = this.factory;
		const widths = this.componentsOf(position);
		const positionBytes = this.componentBytes(widths);
		// One reservation for both halves, mirroring `writeCFrame`.
		const { buf, pos, statements } = this.destructureAlloc("readAlloc", positionBytes + ROTATION_BYTES);
		out.push(...statements);
		const [px, py, pz] = this.readNum3(widths, { buf, pos, offset: 0 });
		const positionValue = this.fresh("pos");
		out.push(
			this.constStatement(
				positionValue,
				f.createNewExpression(f.createIdentifier("Vector3"), undefined, [px, py, pz]),
			),
		);
		const [rx, ry, rz] = this.readNum3(DEFAULT_COMPONENTS, { buf, pos, offset: positionBytes });
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
		return f.createCallExpression(f.createPropertyAccessExpression(rotation, "add"), undefined, [positionValue]);
	}

	private readSequence(kind: "ColorSequence" | "NumberSequence", out: ts.Statement[]): ts.Expression {
		const f = this.factory;
		const { buf, pos, statements } = this.destructureAlloc("readAlloc", 1);
		out.push(...statements);
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
		const i = this.fresh("_i");
		const body: ts.Statement[] = [];
		const { buf: tbuf, pos: tpos, statements: tstmt } = this.destructureAlloc("readAlloc", 4);
		body.push(...tstmt);
		const time = this.fresh("time");
		body.push(this.constStatement(time, this.bufferCall("readf32", [tbuf, tpos])));
		const keypointArgs: ts.Expression[] = [time];
		if (kind === "ColorSequence") {
			keypointArgs.push(this.readColor3(body));
		} else {
			const { buf: vbuf, pos: vpos, statements: vstmt } = this.destructureAlloc("readAlloc", 8);
			body.push(...vstmt);
			keypointArgs.push(this.bufferCall("readf32", [vbuf, vpos]));
			keypointArgs.push(this.bufferCall("readf32", [vbuf, this.offsetFrom(vpos, 4)]));
		}
		const keypoint = f.createNewExpression(f.createIdentifier(`${kind}Keypoint`), undefined, keypointArgs);
		body.push(
			f.createExpressionStatement(
				f.createCallExpression(f.createPropertyAccessExpression(keypoints, "push"), undefined, [keypoint]),
			),
		);
		out.push(this.countedLoop(i, count, body));
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
		const countWidth = this.lengthWidth(field.length);
		const { buf, pos, statements } = this.destructureAlloc("readAlloc", WIDTH_BYTES[countWidth]);
		out.push(...statements);
		const count = this.fresh("count");
		out.push(this.constStatement(count, this.readNumber(countWidth, buf, pos)));
		this.checkEntryCount(count, field, out);
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
		const i = this.fresh("_i");
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
		out.push(this.countedLoop(i, count, body));
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

	private readOptional(
		field: Extract<Field, { kind: "optional" }>,
		out: ts.Statement[],
		// The presence bit of the enclosing object's packed region, or `undefined` to read a flag byte.
		packedPresent: ts.Expression | undefined,
	): ts.Expression {
		const f = this.factory;
		let present = packedPresent;
		if (present === undefined) {
			const { buf, pos, statements } = this.destructureAlloc("readAlloc", 1);
			out.push(...statements);
			const flag = this.fresh("present");
			out.push(
				this.constStatement(
					flag,
					f.createBinaryExpression(
						this.bufferCall("readu8", [buf, pos]),
						this.ts_.SyntaxKind.ExclamationEqualsEqualsToken,
						this.num(0),
					),
				),
			);
			present = flag;
		}
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
			f.createExpressionStatement(f.createBinaryExpression(result, this.ts_.SyntaxKind.EqualsToken, innerExpr)),
		);
		out.push(f.createIfStatement(present, f.createBlock(innerStatements, true)));
		return result;
	}

	private readObjectInline(
		fields: ReadonlyArray<ObjectFieldEntry>,
		out: ts.Statement[],
		// A tagged union variant's discriminant, which belongs in the literal
		// this builds rather than being spread in afterwards: roblox-ts lowers
		// `{ ...obj, tag: "x" }` to `table.clone` plus `setmetatable(_, nil)`
		// plus one assignment, so a spread costs a table copy per read.
		tag?: { readonly key: FieldKey; readonly value: string | number | boolean },
	): ts.Expression {
		const f = this.factory;
		// The packed region is read first and outside the scoped items: every
		// item that follows, in any block, can need one of its bits.
		const bits = this.packedBits(fields);
		const bitExprs = new Map<
			ObjectFieldEntry,
			{ present?: ts.Expression; value?: ts.Expression; tag?: ts.Expression }
		>();
		if (bits.length > 0) {
			const { buf, pos, statements } = this.destructureAlloc("readAlloc", Math.ceil(bits.length / 8));
			out.push(...statements);
			bits.forEach(({ entry, role }, i) => {
				const exprs = bitExprs.get(entry) ?? {};
				exprs[role] = this.call("unpackBit", [buf, pos, this.num(i)]);
				bitExprs.set(entry, exprs);
			});
		}
		// Each item's expressions refer to the locals its statements declare.
		const items: Array<ScopedItem & { readonly props: Array<{ entry: ObjectFieldEntry; expr: ts.Expression }> }> =
			[];
		// An entry the packed region answers reads no bytes of its own, so it
		// cannot share a reservation; the others may, on the same terms as
		// the write side.
		const shareable = (entry: ObjectFieldEntry) =>
			!bitExprs.has(entry) && this.fixedBytes(entry.field) !== undefined;
		for (const group of this.allocRuns(fields, shareable)) {
			if (group.length > 1) {
				const total = group.reduce((sum, entry) => sum + this.fixedBytes(entry.field)!, 0);
				const props: Array<{ entry: ObjectFieldEntry; expr: ts.Expression }> = [];
				const item = this.measure((itemOut) => {
					this.withAllocRun("readAlloc", total, () => {
						for (const entry of group) {
							props.push({ entry, expr: this.readField(entry.field, itemOut) });
						}
					});
				});
				items.push({ ...item, props });
				continue;
			}
			const entry = group[0];
			const field = entry.field;
			const entryBits = bitExprs.get(entry);
			let expr!: ts.Expression;
			const item = this.measure((itemOut) => {
				if (entryBits?.tag && field.kind === "taggedUnion") {
					expr = this.readTaggedUnion(field, itemOut, entryBits.tag);
				} else if (entryBits?.present && entryBits.value) {
					expr = f.createConditionalExpression(
						entryBits.present,
						undefined,
						entryBits.value,
						undefined,
						f.createIdentifier("undefined"),
					);
				} else if (entryBits?.value) {
					expr = entryBits.value;
				} else if (entryBits?.present && field.kind === "optional") {
					expr = this.readOptional(field, itemOut, entryBits.present);
				} else {
					expr = this.readField(field, itemOut);
				}
			});
			items.push({ ...item, props: [{ entry, expr }] });
		}
		if (!this.needsBlocks()) {
			this.pushScoped(items, out);
			// The tag first, matching the variant order in `fieldToTypeNode`.
			const properties: ts.ObjectLiteralElementLike[] = tag
				? [f.createPropertyAssignment(this.propertyName(tag.key), this.literalValueExpr(tag.value))]
				: [];
			for (const item of items) {
				for (const { entry, expr } of item.props) {
					properties.push(f.createPropertyAssignment(this.propertyName(entry), expr));
				}
			}
			return f.createObjectLiteralExpression(properties, true);
		}
		// A block's locals end with the block, so an object literal after the
		// blocks can't refer to them: each block assigns its own fields into
		// `result` instead.
		const result = this.fresh("result");
		out.push(
			this.constStatement(
				result,
				this.castTo(f.createObjectLiteralExpression([]), this.objectShapeTypeNode(fields, tag)),
			),
		);
		if (tag) {
			out.push(
				f.createExpressionStatement(
					f.createBinaryExpression(
						this.propertyAccess(result, tag.key),
						this.ts_.SyntaxKind.EqualsToken,
						this.literalValueExpr(tag.value),
					),
				),
			);
		}
		for (const item of items) {
			for (const { entry, expr } of item.props) {
				item.statements.push(
					f.createExpressionStatement(
						f.createBinaryExpression(
							this.propertyAccess(result, entry),
							this.ts_.SyntaxKind.EqualsToken,
							expr,
						),
					),
				);
			}
		}
		this.pushScoped(items, out);
		return result;
	}

	private readTaggedUnion(
		field: Extract<Field, { kind: "taggedUnion" }>,
		out: ts.Statement[],
		// The tag bit of the enclosing object's packed region, or `undefined` to read an index.
		packedTag?: ts.Expression,
	): ts.Expression {
		const f = this.factory;
		let idx: ts.Identifier;
		if (packedTag) {
			idx = this.fresh("idx");
			out.push(
				this.constStatement(
					idx,
					f.createConditionalExpression(packedTag, undefined, this.num(1), undefined, this.num(0)),
				),
			);
		} else {
			const idxBytes = field.variants.length <= 256 ? 1 : 2;
			const { buf, pos, statements } = this.destructureAlloc("readAlloc", idxBytes);
			out.push(...statements);
			idx = this.fresh("idx");
			out.push(this.constStatement(idx, this.bufferCall(idxBytes === 1 ? "readu8" : "readu16", [buf, pos])));
		}
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
			const objExpr = this.readObjectInline(variant.fields, branch, {
				key: tagKeyOf(field),
				value: variant.tagValue,
			});
			branch.push(
				f.createExpressionStatement(f.createBinaryExpression(result, this.ts_.SyntaxKind.EqualsToken, objExpr)),
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
		const { buf, pos, statements } = this.destructureAlloc("readAlloc", idxBytes);
		out.push(...statements);
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

	/**
	 * A property that admits `undefined` is declared optional (`key?:`). The
	 * user's type is passed to a helper typed with this shape, and
	 * `{ key?: T }` is not assignable to `{ key: T | undefined }`.
	 */
	private propertySignature(entry: ObjectFieldEntry): ts.PropertySignature {
		const field = entry.field;
		// The walker appends `undefined` to the values of a literal union that admits it.
		const admitsUndefined =
			field.kind === "optional" ||
			(field.kind === "literal" && (field.values as ReadonlyArray<unknown>).includes(undefined));
		return this.factory.createPropertySignature(
			undefined,
			this.propertyName(entry),
			admitsUndefined ? this.factory.createToken(this.ts_.SyntaxKind.QuestionToken) : undefined,
			this.fieldToTypeNode(entry.field),
		);
	}

	private objectShapeTypeNode(
		fields: ReadonlyArray<ObjectFieldEntry>,
		tag?: { readonly key: FieldKey; readonly value: string | number | boolean },
	): ts.TypeNode {
		const f = this.factory;
		const members = fields.map((entry) => this.propertySignature(entry));
		if (tag) {
			members.unshift(
				f.createPropertySignature(
					undefined,
					this.propertyName(tag.key),
					undefined,
					f.createLiteralTypeNode(
						this.literalValueExpr(tag.value) as ts.LiteralExpression | ts.BooleanLiteral,
					),
				),
			);
		}
		return f.createTypeLiteralNode(members);
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
			case "vector2":
				return f.createTypeReferenceNode("Vector2");
			case "datatype":
				return f.createTypeReferenceNode(field.name);
			case "buffer":
				return f.createTypeReferenceNode("buffer");
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
				// A `Record` is not assignable to a `Map`, and `readDict` returns one for this source.
				if (field.source === "record" && field.value) {
					return f.createTypeReferenceNode("Record", [
						this.fieldToTypeNode(field.key),
						this.fieldToTypeNode(field.value),
					]);
				}
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
								this.propertyName(tagKeyOf(field)),
								undefined,
								f.createLiteralTypeNode(
									this.literalValueExpr(variant.tagValue) as ts.LiteralExpression | ts.BooleanLiteral,
								),
							),
							...variant.fields.map((entry) => this.propertySignature(entry)),
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

		// The helper's functions are emitted in the middle of whichever function
		// first refers to them, but their locals are their own.
		const callerLocals = this.liveLocals;

		const typeNode = field.kind === "object" ? this.objectShapeTypeNode(field.fields) : this.fieldToTypeNode(field);
		this.helperDecls.push(f.createTypeAliasDeclaration(undefined, `${name}_Type`, undefined, typeNode));
		const typeRef = f.createTypeReferenceNode(`${name}_Type`);

		const valueParam = f.createParameterDeclaration(undefined, undefined, "value", undefined, typeRef, undefined);
		this.beginFunction();
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

		this.beginFunction();
		const readBody: ts.Statement[] = [];
		const resultExpr =
			field.kind === "object" ? this.readObjectInline(field.fields, readBody) : this.readField(field, readBody);
		readBody.push(f.createReturnStatement(resultExpr));
		this.liveLocals = callerLocals;
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
