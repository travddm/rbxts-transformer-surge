/**
 * The size of what `serialize` writes, for a shape it can size from its value
 * before writing it (Transformer 5.20 in docs/specs/transformer.md in the
 * surge repo). Such a shape's `serialize` creates its result at this size and
 * writes into it, with no scratch buffer, no capacity check and no copy.
 *
 * The size is an expression over the value, and, for an array of unions, a
 * loop over its elements that adds each one's bytes to a local ahead of that
 * expression. A union's size is its variants' sizes, chosen by the tests its
 * write makes, and a tagged union's tag is read once for those tests, as the
 * write reads it. The locals the write binds outside a loop or a branch, the
 * size binds ahead of the result instead, and reads the value through them;
 * the write then reads the same locals (`SizeBinding` in context.ts). What
 * the size reads inside a loop or a branch, the write reads again.
 */
import type ts from "typescript";

import type { CountSpec, Field, ObjectFieldEntry } from "../field";
import { LOCALS_PER_BLOCK, TERMS_PER_SUM, WIDTH_BYTES } from "./constants";
import type { EmitContext, SizeBinding } from "./context";
import { exactCount, fixedBytes, isAllPackedBits, lengthWidth, packedBits, tagKeyOf } from "./layout";
import { fieldToTypeNode, objectShapeTypeNode } from "./types";
import { guardFor, isLocal, literalCheck, severalEnums } from "./write";

/** A constant number of bytes, plus terms read from the value, plus loops that add to the total. */
interface Size {
	readonly constant: number;
	readonly terms: ReadonlyArray<ts.Expression>;
	/**
	 * Statements that run before the terms are added to the {@link Total}: the
	 * loops that add to it, and, inside a loop or a branch, the locals its terms
	 * read. Outside one, `exactSize` reads the terms ahead of these statements,
	 * so a term there reads only what the size's `Bindings` bind.
	 */
	readonly loops: ReadonlyArray<ts.Statement>;
}

const EMPTY: Size = { constant: 0, terms: [], loops: [] };

/** The local that the loops of one size add to, declared once a loop needs it. */
interface Total {
	id: ts.Identifier | undefined;
}

/**
 * The locals one size binds ahead of the result, and the statements that bind
 * them. Each stays live to the end of `serialize`, where the write's own
 * binding could have ended with a block (Transformer 5.8), so a size binds at
 * most `LOCALS_PER_BLOCK` and reads the value's path for the rest.
 */
interface Bindings {
	readonly statements: ts.Statement[];
	readonly byPath: Map<string, SizeBinding>;
	locals: number;
}

/**
 * The size `serialize` creates its result at, the statements that must run
 * before it is read, and the locals those statements bind for the write.
 */
export interface ExactSize {
	readonly statements: ReadonlyArray<ts.Statement>;
	readonly size: ts.Expression;
	readonly bindings: ReadonlyMap<string, SizeBinding>;
}

/** The bytes `field` writes from `value`, or `undefined` when the value cannot be sized ahead of the write. */
export function exactSize(ctx: EmitContext, field: Field, value: ts.Expression): ExactSize | undefined {
	const total: Total = { id: undefined };
	const bindings: Bindings = { statements: [], byPath: new Map(), locals: 0 };
	const size = ctx.tentatively(() => measure(ctx, field, value, total, bindings));
	if (size === undefined) {
		return undefined;
	}
	if (total.id === undefined) {
		return { statements: bindings.statements, size: sum(ctx, size), bindings: bindings.byPath };
	}
	const f = ctx.factory;
	const declaration = f.createVariableStatement(
		undefined,
		f.createVariableDeclarationList(
			[f.createVariableDeclaration(total.id, undefined, undefined, sum(ctx, size))],
			ctx.ts_.NodeFlags.Let,
		),
	);
	return {
		statements: [...bindings.statements, declaration, ...size.loops],
		size: total.id,
		bindings: bindings.byPath,
	};
}

/**
 * Binds `value` to a local ahead of the result, and, given `len`, its length
 * to a second one, as the write would bind them. `undefined` where the size
 * binds nothing: `bindings` is absent inside a loop or a branch, where the
 * write binds its own each time it runs.
 */
function bind(
	ctx: EmitContext,
	bindings: Bindings | undefined,
	base: string,
	value: ts.Expression,
	len?: (local: ts.Identifier) => ts.Expression,
): SizeBinding | undefined {
	const key = ctx.pathKey(value);
	const locals = len === undefined ? 1 : 2;
	if (bindings === undefined || key === undefined || bindings.locals + locals > LOCALS_PER_BLOCK) {
		return undefined;
	}
	const local = ctx.fresh(base);
	bindings.statements.push(ctx.constStatement(local, value));
	let length: ts.Identifier | undefined;
	if (len !== undefined) {
		length = ctx.fresh("len");
		bindings.statements.push(ctx.constStatement(length, len(local)));
	}
	bindings.locals += locals;
	const binding: SizeBinding = { value: local, len: length };
	bindings.byPath.set(key, binding);
	return binding;
}

function measure(
	ctx: EmitContext,
	field: Field,
	value: ts.Expression,
	total: Total,
	bindings: Bindings | undefined,
): Size | undefined {
	const fixed = fixedBytes(field);
	if (fixed !== undefined) {
		return constant(fixed);
	}
	switch (field.kind) {
		case "str":
			return counted(ctx, bindings, field.length, value, "s", (s) => ctx.sizeOf(s));
		case "buffer":
			return counted(ctx, bindings, field.length, value, "src", (src) => ctx.bufferCall("len", [src]));
		case "blob":
			return EMPTY;
		case "object":
			return field.helperName === undefined
				? measureObject(ctx, field.fields, value, total, bindings)
				: undefined;
		case "optional": {
			// A flag byte, and the value's own bytes when it is there.
			const present = whenPresent(ctx, field.inner, value, total);
			return present === undefined ? undefined : add(constant(1), present);
		}
		case "array":
			return measureArray(ctx, field, value, total, bindings);
		case "tuple": {
			const tup = bind(ctx, bindings, "tup", value)?.value ?? value;
			let size = EMPTY;
			for (const [i, element] of field.fixed.entries()) {
				const one = measure(
					ctx,
					element,
					ctx.factory.createElementAccessExpression(tup, ctx.num(i)),
					total,
					bindings,
				);
				if (one === undefined) {
					return undefined;
				}
				size = add(size, one);
			}
			if (field.rest === undefined) {
				return size;
			}
			const bytes = constantBytes(ctx, field.rest, total);
			if (bytes === undefined) {
				return undefined;
			}
			const count = ctx.factory.createBinaryExpression(
				ctx.sizeOf(tup),
				ctx.ts_.SyntaxKind.MinusToken,
				ctx.num(field.fixed.length),
			);
			return add(size, elements(ctx, field.length, count, bytes));
		}
		case "taggedUnion": {
			const sizes = field.variants.map((variant) =>
				measureObject(
					ctx,
					variant.fields,
					ctx.castTo(value, objectShapeTypeNode(ctx, variant.fields)),
					total,
					undefined,
				),
			);
			const tag = readTag(ctx, bindings, ctx.propertyAccess(value, tagKeyOf(field)), sizes);
			const union = measureUnion(
				ctx,
				field.variants.map((variant, i) => ({
					check: () => literalCheck(ctx, tag.value, variant.tagValue),
					size: sizes[i],
				})),
				total,
			);
			return union === undefined ? undefined : add(tag.size, union);
		}
		case "guardedUnion":
			return measureUnion(
				ctx,
				field.variants.map((variant) => ({
					check: () => guardFor(ctx, variant, value, severalEnums(field.variants)),
					size: measure(ctx, variant, ctx.castTo(value, fieldToTypeNode(ctx, variant)), total, undefined),
				})),
				total,
			);
		default:
			return undefined;
	}
}

/**
 * A union's index, and the bytes of the variant the write picks: the write's
 * own tests, in its order, each choosing its variant's size, and the last
 * variant's size when none passes. The tests are a tag's comparisons or a
 * guarded union's guards, which the write evaluates again.
 */
function measureUnion(
	ctx: EmitContext,
	variants: ReadonlyArray<{ readonly check: () => ts.Expression; readonly size: Size | undefined }>,
	total: Total,
): Size | undefined {
	const f = ctx.factory;
	const sizes: Size[] = [];
	for (const variant of variants) {
		if (variant.size === undefined) {
			return undefined;
		}
		sizes.push(variant.size);
	}
	const index = constant(variants.length <= 256 ? 1 : 2);
	if (oneConstant(sizes)) {
		return add(index, constant(sizes[0].constant));
	}
	const last = sizes.length - 1;
	if (sizes.every((size) => size.loops.length === 0)) {
		let chosen = sum(ctx, sizes[last]);
		for (let i = last - 1; i >= 0; i--) {
			chosen = f.createConditionalExpression(
				variants[i].check(),
				undefined,
				sum(ctx, sizes[i]),
				undefined,
				chosen,
			);
		}
		return add(index, { constant: 0, terms: [f.createParenthesizedExpression(chosen)], loops: [] });
	}
	let chain: ts.Statement = f.createBlock(addTo(ctx, total, sizes[last]), true);
	for (let i = last - 1; i >= 0; i--) {
		chain = f.createIfStatement(variants[i].check(), f.createBlock(addTo(ctx, total, sizes[i]), true), chain);
	}
	return add(index, { constant: 0, terms: [], loops: [chain] });
}

/** Whether every one of `sizes` is the same constant, so a union of them tests nothing. */
function oneConstant(sizes: ReadonlyArray<Size>): boolean {
	return sizes.every((size) => !readsValue(size) && size.constant === sizes[0].constant);
}

/**
 * The tag a tagged union's size compares, read once into a local when the
 * size compares it more than once, as its write reads it (Transformer 5.25).
 * Outside a loop or a branch, the local is one of the size's `bindings`, which
 * the write reads instead of its own. Inside one, it is declared ahead of the
 * comparisons, and the write reads the tag again.
 */
function readTag(
	ctx: EmitContext,
	bindings: Bindings | undefined,
	tag: ts.Expression,
	sizes: ReadonlyArray<Size | undefined>,
): { readonly value: ts.Expression; readonly size: Size } {
	// The size compares the tag for each variant but the last, and not at all
	// when the variants are one constant size.
	const known = sizes.filter((size) => size !== undefined);
	if (sizes.length < 3 || known.length < sizes.length || oneConstant(known)) {
		return { value: tag, size: EMPTY };
	}
	if (bindings !== undefined) {
		return { value: bind(ctx, bindings, "tag", tag)?.value ?? tag, size: EMPTY };
	}
	const local = ctx.fresh("tag");
	return { value: local, size: { constant: 0, terms: [], loops: [ctx.constStatement(local, tag)] } };
}

/**
 * An array's count, and its elements: their count times their size when
 * that size is the same for each, and otherwise, for an element that is a
 * union or an object, a loop over them, as the write's own. A loop measured
 * slower than the scratch buffer for an array of strings (docs/research/
 * exact-sizing-with-loops.md in the surge repo), so an array of any other
 * element that varies in size is not sized, and neither is the exact form,
 * whose write reads by index up to its length rather than iterating.
 */
function measureArray(
	ctx: EmitContext,
	field: Extract<Field, { kind: "array" }>,
	value: ts.Expression,
	total: Total,
	bindings: Bindings | undefined,
): Size | undefined {
	if (exactCount(field.length) !== undefined) {
		const bytes = constantBytes(ctx, field.element, total);
		return bytes === undefined ? undefined : elements(ctx, field.length, ctx.sizeOf(value), bytes);
	}
	const arr = bind(ctx, bindings, "arr", value)?.value ?? value;
	const bytes = fixedBytes(field.element);
	if (bytes !== undefined) {
		return elements(ctx, field.length, ctx.sizeOf(arr), bytes);
	}
	const item = ctx.fresh("item");
	const element = measure(ctx, field.element, item, total, undefined);
	if (element === undefined) {
		return undefined;
	}
	if (!readsValue(element)) {
		return elements(ctx, field.length, ctx.sizeOf(arr), element.constant);
	}
	if (
		field.element.kind !== "taggedUnion" &&
		field.element.kind !== "guardedUnion" &&
		field.element.kind !== "object"
	) {
		return undefined;
	}
	return {
		constant: WIDTH_BYTES[lengthWidth(field.length)],
		terms: [],
		loops: [loopOver(ctx, total, item, arr, element)],
	};
}

/**
 * An object's packed region, then each property that writes bytes of its own.
 * A packed optional's presence is a bit of the region, so its value adds no
 * flag byte. A packed tagged union is not sized: its variants differ. The
 * object is read through the local its write binds (Transformer 5.23), under
 * the write's own condition.
 */
function measureObject(
	ctx: EmitContext,
	fields: ReadonlyArray<ObjectFieldEntry>,
	value: ts.Expression,
	total: Total,
	bindings: Bindings | undefined,
): Size | undefined {
	if (!isLocal(ctx, value) && fields.length > 1) {
		value = bind(ctx, bindings, "obj", value)?.value ?? value;
	}
	const bits = packedBits(fields);
	let size = constant(Math.ceil(bits.length / 8));
	for (const entry of fields) {
		if (isAllPackedBits(entry.field)) {
			continue;
		}
		const property = ctx.propertyAccess(value, entry);
		const roles = bits.filter((bit) => bit.entry === entry).map((bit) => bit.role);
		let one: Size | undefined;
		if (roles.includes("tag")) {
			return undefined;
		} else if (roles.includes("present") && entry.field.kind === "optional") {
			one = whenPresent(ctx, entry.field.inner, property, total);
		} else {
			one = measure(ctx, entry.field, property, total, bindings);
		}
		if (one === undefined) {
			return undefined;
		}
		size = add(size, one);
	}
	return size;
}

/**
 * An optional's value: `value !== undefined ? <inner's bytes> : 0`, or,
 * where its bytes take a loop, that loop inside `if (value !== undefined)`.
 */
function whenPresent(ctx: EmitContext, inner: Field, value: ts.Expression, total: Total): Size | undefined {
	const f = ctx.factory;
	const size = measure(ctx, inner, f.createNonNullExpression(value), total, undefined);
	if (size === undefined) {
		return undefined;
	}
	if (size.constant === 0 && !readsValue(size)) {
		return EMPTY;
	}
	const isPresent = f.createBinaryExpression(
		value,
		ctx.ts_.SyntaxKind.ExclamationEqualsEqualsToken,
		f.createIdentifier("undefined"),
	);
	if (size.loops.length > 0) {
		return {
			constant: 0,
			terms: [],
			loops: [f.createIfStatement(isPresent, f.createBlock(addTo(ctx, total, size), true))],
		};
	}
	return {
		constant: 0,
		terms: [f.createConditionalExpression(isPresent, undefined, sum(ctx, size), undefined, ctx.num(0))],
		loops: [],
	};
}

/** `for (const <binding> of <iterable>) { <total> += <each> }`, where `each` is one element's size. */
function loopOver(
	ctx: EmitContext,
	total: Total,
	binding: ts.BindingName,
	iterable: ts.Expression,
	each: Size,
): ts.Statement {
	const f = ctx.factory;
	return f.createForOfStatement(
		undefined,
		f.createVariableDeclarationList([f.createVariableDeclaration(binding)], ctx.ts_.NodeFlags.Const),
		iterable,
		f.createBlock(addTo(ctx, total, each), true),
	);
}

/** `size`'s loops, then `<total> += <the rest of size>`. */
function addTo(ctx: EmitContext, total: Total, size: Size): ts.Statement[] {
	total.id ??= ctx.fresh("size");
	const statements = [...size.loops];
	if (size.constant !== 0 || size.terms.length > 0) {
		statements.push(
			ctx.factory.createExpressionStatement(
				ctx.factory.createBinaryExpression(total.id, ctx.ts_.SyntaxKind.PlusEqualsToken, sum(ctx, size)),
			),
		);
	}
	return statements;
}

/**
 * The bytes `field` writes for every value: its fixed bytes, or a size that
 * reads nothing from the value. An object that holds a blob has the second
 * and not the first, because `fixedBytes` admits no blob into a run.
 */
function constantBytes(ctx: EmitContext, field: Field, total: Total): number | undefined {
	const bytes = fixedBytes(field);
	if (bytes !== undefined) {
		return bytes;
	}
	const size = measure(ctx, field, ctx.fresh("item"), total, undefined);
	return size === undefined || readsValue(size) ? undefined : size.constant;
}

/** Whether `size` reads anything from the value, rather than being a constant. */
function readsValue(size: Size): boolean {
	return size.terms.length > 0 || size.loops.length > 0;
}

function constant(bytes: number): Size {
	return { constant: bytes, terms: [], loops: [] };
}

/**
 * A `str`'s or a `buffer`'s bytes: its count's width and its length, which
 * `len` takes from its value, or its exact length alone.
 */
function counted(
	ctx: EmitContext,
	bindings: Bindings | undefined,
	length: CountSpec | undefined,
	value: ts.Expression,
	base: string,
	len: (value: ts.Expression) => ts.Expression,
): Size {
	const exact = exactCount(length);
	if (exact !== undefined) {
		return constant(exact);
	}
	const bound = bind(ctx, bindings, base, value, len);
	return { constant: WIDTH_BYTES[lengthWidth(length)], terms: [bound?.len ?? len(value)], loops: [] };
}

/** `count` elements of `bytes` each, after the count itself unless the count is exact. */
function elements(ctx: EmitContext, length: CountSpec | undefined, count: ts.Expression, bytes: number): Size {
	const exact = exactCount(length);
	if (exact !== undefined) {
		return constant(exact * bytes);
	}
	const width = WIDTH_BYTES[lengthWidth(length)];
	if (bytes === 0) {
		return constant(width);
	}
	const term =
		bytes === 1
			? count
			: ctx.factory.createBinaryExpression(count, ctx.ts_.SyntaxKind.AsteriskToken, ctx.num(bytes));
	return { constant: width, terms: [term], loops: [] };
}

function add(left: Size, right: Size): Size {
	return {
		constant: left.constant + right.constant,
		terms: [...left.terms, ...right.terms],
		loops: [...left.loops, ...right.loops],
	};
}

/**
 * The terms in the order the value holds them, then the constant, folded into
 * one number. Up to `TERMS_PER_SUM` of them are one chain. Past that, each run
 * of that many is a chain, and the chains are added in pairs, so the nesting
 * Luau compiles grows with the logarithm of the count.
 */
function sum(ctx: EmitContext, size: Size): ts.Expression {
	const terms = size.constant === 0 ? [...size.terms] : [...size.terms, ctx.num(size.constant)];
	if (terms.length === 0) {
		return ctx.num(0);
	}
	const chains: ts.Expression[] = [];
	for (let start = 0; start < terms.length; start += TERMS_PER_SUM) {
		chains.push(terms.slice(start, start + TERMS_PER_SUM).reduce((left, term) => plus(ctx, left, term)));
	}
	while (chains.length > 1) {
		const paired: ts.Expression[] = [];
		for (let i = 0; i < chains.length; i += 2) {
			paired.push(i + 1 < chains.length ? plus(ctx, chains[i], chains[i + 1]) : chains[i]);
		}
		chains.splice(0, chains.length, ...paired);
	}
	return chains[0];
}

function plus(ctx: EmitContext, left: ts.Expression, right: ts.Expression): ts.Expression {
	return ctx.factory.createBinaryExpression(left, ctx.ts_.SyntaxKind.PlusToken, right);
}
