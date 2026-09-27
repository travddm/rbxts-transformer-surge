/**
 * The size of what `serialize` writes, for a shape it can size from its value
 * before writing it (Transformer 5.20 in docs/specs/transformer.md in the
 * surge repo). Such a shape's `serialize` creates its result at this size and
 * writes into it, with no scratch buffer, no capacity check and no copy.
 *
 * The size is an expression over the value, and, for an array whose elements
 * vary in size or a `dict`, a loop over its elements that adds each one's
 * bytes to a local ahead of that expression. A union's size is its variants'
 * sizes, chosen by the tests its write makes. The size reads the value, and
 * the writes read it again. Binding each string and array to a local first
 * would read it once, but every such local would stay live across the whole
 * function, against the budget of Transformer 5.8.
 */
import type ts from "typescript";

import type { CountSpec, Field, ObjectFieldEntry } from "../field";
import { WIDTH_BYTES } from "./constants";
import type { EmitContext } from "./context";
import { exactCount, fixedBytes, isAllPackedBits, lengthWidth, packedBits, tagKeyOf } from "./layout";
import { asMapOrSet, fieldToTypeNode, objectShapeTypeNode } from "./types";
import { guardFor, literalCheck } from "./write";

/** A constant number of bytes, plus terms read from the value, plus loops that add to the total. */
interface Size {
	readonly constant: number;
	readonly terms: ReadonlyArray<ts.Expression>;
	/** Statements that add to the {@link Total}, which run before it is read. */
	readonly loops: ReadonlyArray<ts.Statement>;
}

const EMPTY: Size = { constant: 0, terms: [], loops: [] };

/** The local that the loops of one size add to, declared once a loop needs it. */
interface Total {
	id: ts.Identifier | undefined;
}

/** The size `serialize` creates its result at, and the statements that must run before it is read. */
export interface ExactSize {
	readonly statements: ReadonlyArray<ts.Statement>;
	readonly size: ts.Expression;
}

/** The bytes `field` writes from `value`, or `undefined` when the value cannot be sized ahead of the write. */
export function exactSize(ctx: EmitContext, field: Field, value: ts.Expression): ExactSize | undefined {
	const total: Total = { id: undefined };
	const size = ctx.tentatively(() => measure(ctx, field, value, total));
	if (size === undefined) {
		return undefined;
	}
	if (total.id === undefined) {
		return { statements: [], size: sum(ctx, size) };
	}
	const f = ctx.factory;
	const declaration = f.createVariableStatement(
		undefined,
		f.createVariableDeclarationList(
			[f.createVariableDeclaration(total.id, undefined, undefined, sum(ctx, size))],
			ctx.ts_.NodeFlags.Let,
		),
	);
	return { statements: [declaration, ...size.loops], size: total.id };
}

function measure(ctx: EmitContext, field: Field, value: ts.Expression, total: Total): Size | undefined {
	const fixed = fixedBytes(field);
	if (fixed !== undefined) {
		return constant(fixed);
	}
	switch (field.kind) {
		case "str":
			return counted(field.length, ctx.sizeOf(value));
		case "buffer":
			return counted(field.length, ctx.bufferCall("len", [value]));
		case "blob":
			return EMPTY;
		case "object":
			return field.helperName === undefined ? measureObject(ctx, field.fields, value, total) : undefined;
		case "optional": {
			// A flag byte, and the value's own bytes when it is there.
			const present = whenPresent(ctx, field.inner, value, total);
			return present === undefined ? undefined : add(constant(1), present);
		}
		case "array":
			return measureArray(ctx, field, value, total);
		case "tuple": {
			let size = EMPTY;
			for (const [i, element] of field.fixed.entries()) {
				const one = measure(ctx, element, ctx.factory.createElementAccessExpression(value, ctx.num(i)), total);
				if (one === undefined) {
					return undefined;
				}
				size = add(size, one);
			}
			if (field.rest === undefined) {
				return size;
			}
			const bytes = fixedBytes(field.rest);
			if (bytes === undefined) {
				return undefined;
			}
			const count = ctx.factory.createBinaryExpression(
				ctx.sizeOf(value),
				ctx.ts_.SyntaxKind.MinusToken,
				ctx.num(field.fixed.length),
			);
			return add(size, elements(ctx, field.length, count, bytes));
		}
		case "dict":
			return measureDict(ctx, field, value, total);
		case "taggedUnion": {
			const tag = ctx.propertyAccess(value, tagKeyOf(field));
			return measureUnion(
				ctx,
				field.variants.map((variant) => ({
					check: literalCheck(ctx, tag, variant.tagValue),
					size: measureObject(
						ctx,
						variant.fields,
						ctx.castTo(value, objectShapeTypeNode(ctx, variant.fields)),
						total,
					),
				})),
				total,
			);
		}
		case "guardedUnion":
			return measureUnion(
				ctx,
				field.variants.map((variant) => ({
					check: guardFor(ctx, variant, value),
					size: measure(ctx, variant, ctx.castTo(value, fieldToTypeNode(ctx, variant)), total),
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
	variants: ReadonlyArray<{ readonly check: ts.Expression; readonly size: Size | undefined }>,
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
	const first = sizes[0];
	if (sizes.every((size) => !readsValue(size) && size.constant === first.constant)) {
		return add(index, constant(first.constant));
	}
	const last = sizes.length - 1;
	if (sizes.every((size) => size.loops.length === 0)) {
		let chosen = sum(ctx, sizes[last]);
		for (let i = last - 1; i >= 0; i--) {
			chosen = f.createConditionalExpression(variants[i].check, undefined, sum(ctx, sizes[i]), undefined, chosen);
		}
		return add(index, { constant: 0, terms: [f.createParenthesizedExpression(chosen)], loops: [] });
	}
	let chain: ts.Statement = f.createBlock(addTo(ctx, total, sizes[last]), true);
	for (let i = last - 1; i >= 0; i--) {
		chain = f.createIfStatement(variants[i].check, f.createBlock(addTo(ctx, total, sizes[i]), true), chain);
	}
	return add(index, { constant: 0, terms: [], loops: [chain] });
}

/**
 * An array's count, and its elements: their count times their size when
 * that size is the same for each, and otherwise a loop over them, as the
 * write's own. The exact form of an array whose elements vary is not sized,
 * since its write reads by index up to its length rather than iterating.
 */
function measureArray(
	ctx: EmitContext,
	field: Extract<Field, { kind: "array" }>,
	value: ts.Expression,
	total: Total,
): Size | undefined {
	const bytes = fixedBytes(field.element);
	if (bytes !== undefined) {
		return elements(ctx, field.length, ctx.sizeOf(value), bytes);
	}
	if (exactCount(field.length) !== undefined) {
		return undefined;
	}
	const item = ctx.fresh("item");
	const element = measure(ctx, field.element, item, total);
	if (element === undefined) {
		return undefined;
	}
	if (!readsValue(element)) {
		return elements(ctx, field.length, ctx.sizeOf(value), element.constant);
	}
	return {
		constant: WIDTH_BYTES[lengthWidth(field.length)],
		terms: [],
		loops: [loopOver(ctx, total, item, value, element)],
	};
}

/** A `dict`'s count, and a loop over its entries, as its write's own, adding each key's and value's bytes. */
function measureDict(
	ctx: EmitContext,
	field: Extract<Field, { kind: "dict" }>,
	value: ts.Expression,
	total: Total,
): Size | undefined {
	const f = ctx.factory;
	const k = ctx.fresh("k");
	const key = measure(ctx, field.key, k, total);
	if (key === undefined) {
		return undefined;
	}
	const v = field.value === undefined ? undefined : ctx.fresh("v");
	const entryValue = field.value === undefined ? EMPTY : measure(ctx, field.value, v!, total);
	if (entryValue === undefined) {
		return undefined;
	}
	// A key or a value whose size does not depend on it is not bound: an
	// unused `for`-`of` variable fails a consumer's `noUnusedLocals`.
	const keyName = readsValue(key) ? k : ctx.fresh("_k");
	let binding: ts.BindingName = keyName;
	if (v !== undefined) {
		binding = f.createArrayBindingPattern(
			readsValue(entryValue)
				? [
						readsValue(key) ? f.createBindingElement(undefined, undefined, k) : f.createOmittedExpression(),
						f.createBindingElement(undefined, undefined, v),
					]
				: [f.createBindingElement(undefined, undefined, keyName)],
		);
	}
	const iterable = asMapOrSet(ctx, value, field.key, field.value);
	return {
		constant: WIDTH_BYTES[lengthWidth(field.length)],
		terms: [],
		loops: [loopOver(ctx, total, binding, iterable, add(key, entryValue))],
	};
}

/**
 * An object's packed region, then each property that writes bytes of its own.
 * A packed optional's presence is a bit of the region, so its value adds no
 * flag byte. A packed tagged union is not sized: its variants differ.
 */
function measureObject(
	ctx: EmitContext,
	fields: ReadonlyArray<ObjectFieldEntry>,
	value: ts.Expression,
	total: Total,
): Size | undefined {
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
			one = measure(ctx, entry.field, property, total);
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
	const size = measure(ctx, inner, f.createNonNullExpression(value), total);
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

/** Whether `size` reads anything from the value, rather than being a constant. */
function readsValue(size: Size): boolean {
	return size.terms.length > 0 || size.loops.length > 0;
}

function constant(bytes: number): Size {
	return { constant: bytes, terms: [], loops: [] };
}

/** A `str`'s or a `buffer`'s bytes: its count's width and its length, or its exact length alone. */
function counted(length: CountSpec | undefined, len: ts.Expression): Size {
	const exact = exactCount(length);
	return exact !== undefined
		? constant(exact)
		: { constant: WIDTH_BYTES[lengthWidth(length)], terms: [len], loops: [] };
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

/** The terms in the order the value holds them, then the constant, folded into one number. */
function sum(ctx: EmitContext, size: Size): ts.Expression {
	let expr: ts.Expression | undefined;
	for (const term of size.terms) {
		expr = expr === undefined ? term : ctx.factory.createBinaryExpression(expr, ctx.ts_.SyntaxKind.PlusToken, term);
	}
	if (expr === undefined) {
		return ctx.num(size.constant);
	}
	return size.constant === 0
		? expr
		: ctx.factory.createBinaryExpression(expr, ctx.ts_.SyntaxKind.PlusToken, ctx.num(size.constant));
}
