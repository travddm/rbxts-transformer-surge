/** The TypeScript types the generated code declares for the values it rebuilds. */
import type ts from "typescript";

import type { Field, FieldKey, ObjectFieldEntry } from "../field";
import type { EmitContext } from "./context";
import { tagKeyOf } from "./layout";

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
function helperTypeRef(ctx: EmitContext, name: string): ts.TypeNode {
	ctx.ensureHelper(name);
	return ctx.factory.createTypeReferenceNode(`${name}_Type`);
}

/**
 * A property that admits `undefined` is declared optional (`key?:`). The
 * user's type is passed to a helper typed with this shape, and
 * `{ key?: T }` is not assignable to `{ key: T | undefined }`.
 */
function propertySignature(ctx: EmitContext, entry: ObjectFieldEntry): ts.PropertySignature {
	const field = entry.field;
	// The walker appends `undefined` to the values of a literal union that admits it.
	const admitsUndefined =
		field.kind === "optional" ||
		(field.kind === "literal" && (field.values as ReadonlyArray<unknown>).includes(undefined));
	return ctx.factory.createPropertySignature(
		undefined,
		ctx.propertyName(entry),
		admitsUndefined ? ctx.factory.createToken(ctx.ts_.SyntaxKind.QuestionToken) : undefined,
		fieldToTypeNode(ctx, entry.field),
	);
}

export function objectShapeTypeNode(
	ctx: EmitContext,
	fields: ReadonlyArray<ObjectFieldEntry>,
	tag?: { readonly key: FieldKey; readonly value: string | number | boolean },
): ts.TypeNode {
	const f = ctx.factory;
	const members = fields.map((entry) => propertySignature(ctx, entry));
	if (tag) {
		members.unshift(
			f.createPropertySignature(
				undefined,
				ctx.propertyName(tag.key),
				undefined,
				f.createLiteralTypeNode(ctx.literalValueExpr(tag.value) as ts.LiteralExpression | ts.BooleanLiteral),
			),
		);
	}
	return f.createTypeLiteralNode(members);
}

/** The best-effort structural type of a `Field`, for internal declarations only (never shown to a caller). */
export function fieldToTypeNode(ctx: EmitContext, field: Field): ts.TypeNode {
	const f = ctx.factory;
	const kw = (k: ts.KeywordTypeSyntaxKind) => f.createKeywordTypeNode(k);
	switch (field.kind) {
		case "num":
			return kw(ctx.ts_.SyntaxKind.NumberKeyword);
		case "bool":
			return kw(ctx.ts_.SyntaxKind.BooleanKeyword);
		case "str":
			return kw(ctx.ts_.SyntaxKind.StringKeyword);
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
			return field.helperName ? helperTypeRef(ctx, field.helperName) : objectShapeTypeNode(ctx, field.fields);
		case "recursiveRef":
			return helperTypeRef(ctx, field.helperName);
		case "array":
			return f.createArrayTypeNode(fieldToTypeNode(ctx, field.element));
		case "tuple": {
			const members = field.fixed.map((el) => fieldToTypeNode(ctx, el));
			if (field.rest) {
				members.push(f.createRestTypeNode(f.createArrayTypeNode(fieldToTypeNode(ctx, field.rest))));
			}
			return f.createTupleTypeNode(members);
		}
		case "dict":
			// A `Record` is not assignable to a `Map`, and `readDict` returns one for this source.
			if (field.source === "record" && field.value) {
				return f.createTypeReferenceNode("Record", [
					fieldToTypeNode(ctx, field.key),
					fieldToTypeNode(ctx, field.value),
				]);
			}
			return field.value
				? f.createTypeReferenceNode("Map", [fieldToTypeNode(ctx, field.key), fieldToTypeNode(ctx, field.value)])
				: f.createTypeReferenceNode("Set", [fieldToTypeNode(ctx, field.key)]);
		case "optional":
			return f.createUnionTypeNode([fieldToTypeNode(ctx, field.inner), kw(ctx.ts_.SyntaxKind.UndefinedKeyword)]);
		case "literalConst":
			return field.value === undefined
				? kw(ctx.ts_.SyntaxKind.UndefinedKeyword)
				: f.createLiteralTypeNode(
						ctx.literalValueExpr(field.value) as ts.LiteralExpression | ts.BooleanLiteral,
					);
		case "literal":
			return f.createUnionTypeNode(
				field.values.map((v) =>
					v === undefined
						? kw(ctx.ts_.SyntaxKind.UndefinedKeyword)
						: f.createLiteralTypeNode(ctx.literalValueExpr(v) as ts.LiteralExpression | ts.BooleanLiteral),
				),
			);
		case "taggedUnion":
			return f.createUnionTypeNode(
				field.variants.map((variant) =>
					f.createTypeLiteralNode([
						f.createPropertySignature(
							undefined,
							ctx.propertyName(tagKeyOf(field)),
							undefined,
							f.createLiteralTypeNode(
								ctx.literalValueExpr(variant.tagValue) as ts.LiteralExpression | ts.BooleanLiteral,
							),
						),
						...variant.fields.map((entry) => propertySignature(ctx, entry)),
					]),
				),
			);
		case "guardedUnion":
			return f.createUnionTypeNode(field.variants.map((v) => fieldToTypeNode(ctx, v)));
		case "blob":
			return kw(ctx.ts_.SyntaxKind.UnknownKeyword);
	}
}

export function asMapOrSetTypeNode(ctx: EmitContext, field: Extract<Field, { kind: "dict" }>): ts.TypeNode {
	const f = ctx.factory;
	return field.value
		? f.createTypeReferenceNode("Map", [fieldToTypeNode(ctx, field.key), fieldToTypeNode(ctx, field.value)])
		: f.createTypeReferenceNode("Set", [fieldToTypeNode(ctx, field.key)]);
}
