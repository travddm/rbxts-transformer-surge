/**
 * The size of what `serialize` writes, as an expression over the value, for a
 * shape that can be sized without a loop over elements of varying size
 * (Transformer 5.20 in docs/specs/transformer.md in the surge repo). Such a
 * shape's `serialize` creates its result at this size and writes into it,
 * with no scratch buffer, no capacity check and no copy.
 *
 * The expression reads the value, and the writes read it again. Binding each
 * string and array to a local first would read it once, but every such local
 * would stay live across the whole function, against the budget of
 * Transformer 5.8.
 */
import type ts from "typescript";

import type { CountSpec, Field, ObjectFieldEntry } from "../field";
import { WIDTH_BYTES } from "./constants";
import type { EmitContext } from "./context";
import { exactCount, fixedBytes, isAllPackedBits, lengthWidth, packedBits } from "./layout";

/** A constant number of bytes, plus terms read from the value. */
interface Size {
	readonly constant: number;
	readonly terms: ReadonlyArray<ts.Expression>;
}

const EMPTY: Size = { constant: 0, terms: [] };

/** The bytes `field` writes from `value`, or `undefined` when only a loop over the value could say. */
export function exactSize(ctx: EmitContext, field: Field, value: ts.Expression): ts.Expression | undefined {
	const size = measure(ctx, field, value);
	return size === undefined ? undefined : sum(ctx, size);
}

function measure(ctx: EmitContext, field: Field, value: ts.Expression): Size | undefined {
	const fixed = fixedBytes(field);
	if (fixed !== undefined) {
		return { constant: fixed, terms: [] };
	}
	switch (field.kind) {
		case "str":
			return counted(field.length, ctx.sizeOf(value));
		case "buffer":
			return counted(field.length, ctx.bufferCall("len", [value]));
		case "blob":
			return EMPTY;
		case "object":
			return field.helperName === undefined ? measureObject(ctx, field.fields, value) : undefined;
		case "optional": {
			// A flag byte, and the value's own bytes when it is there.
			const present = whenPresent(ctx, field.inner, value);
			return present === undefined ? undefined : add({ constant: 1, terms: [] }, present);
		}
		case "array": {
			const bytes = fixedBytes(field.element);
			return bytes === undefined ? undefined : elements(ctx, field.length, ctx.sizeOf(value), bytes);
		}
		case "tuple": {
			let size = EMPTY;
			for (const [i, element] of field.fixed.entries()) {
				const one = measure(ctx, element, ctx.factory.createElementAccessExpression(value, ctx.num(i)));
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
		default:
			return undefined;
	}
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
): Size | undefined {
	const bits = packedBits(fields);
	let size: Size = { constant: Math.ceil(bits.length / 8), terms: [] };
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
			one = whenPresent(ctx, entry.field.inner, property);
		} else {
			one = measure(ctx, entry.field, property);
		}
		if (one === undefined) {
			return undefined;
		}
		size = add(size, one);
	}
	return size;
}

/** `value !== undefined ? <inner's bytes> : 0`, for an optional's value. */
function whenPresent(ctx: EmitContext, inner: Field, value: ts.Expression): Size | undefined {
	const f = ctx.factory;
	const size = measure(ctx, inner, f.createNonNullExpression(value));
	if (size === undefined) {
		return undefined;
	}
	if (size.constant === 0 && size.terms.length === 0) {
		return EMPTY;
	}
	const isPresent = f.createBinaryExpression(
		value,
		ctx.ts_.SyntaxKind.ExclamationEqualsEqualsToken,
		f.createIdentifier("undefined"),
	);
	return {
		constant: 0,
		terms: [f.createConditionalExpression(isPresent, undefined, sum(ctx, size), undefined, ctx.num(0))],
	};
}

/** A `str`'s or a `buffer`'s bytes: its count's width and its length, or its exact length alone. */
function counted(length: CountSpec | undefined, len: ts.Expression): Size {
	const exact = exactCount(length);
	return exact !== undefined
		? { constant: exact, terms: [] }
		: { constant: WIDTH_BYTES[lengthWidth(length)], terms: [len] };
}

/** `count` elements of `bytes` each, after the count itself unless the count is exact. */
function elements(ctx: EmitContext, length: CountSpec | undefined, count: ts.Expression, bytes: number): Size {
	const exact = exactCount(length);
	if (exact !== undefined) {
		return { constant: exact * bytes, terms: [] };
	}
	const width = WIDTH_BYTES[lengthWidth(length)];
	if (bytes === 0) {
		return { constant: width, terms: [] };
	}
	const term =
		bytes === 1
			? count
			: ctx.factory.createBinaryExpression(count, ctx.ts_.SyntaxKind.AsteriskToken, ctx.num(bytes));
	return { constant: width, terms: [term] };
}

function add(left: Size, right: Size): Size {
	return { constant: left.constant + right.constant, terms: [...left.terms, ...right.terms] };
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
