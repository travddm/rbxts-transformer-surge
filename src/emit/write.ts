/** The write side: one function per `Field` kind, each appending to the caller's statement list. */
import type ts from "typescript";

import { FIXED_DATATYPES } from "../datatypes";
import type { ComponentWidths, CountSpec, Field, ObjectFieldEntry } from "../field";
import { CURSOR, DEFAULT_COMPONENTS, PACKED_CFRAME_MAX_BYTES, ROTATION_BYTES, WIDTH_BYTES } from "./constants";
import type { EmitContext, ScopedItem, Slot } from "./context";
import type { PackedBit } from "./layout";
import {
	allocRuns,
	componentBytes,
	componentsOf,
	exactCount,
	fixedBytes,
	isAllPackedBits,
	lengthWidth,
	packedBits,
	tagKeyOf,
} from "./layout";
import { fieldToTypeNode, objectShapeTypeNode } from "./types";

export function writeField(ctx: EmitContext, field: Field, value: ts.Expression, out: ts.Statement[]): void {
	switch (field.kind) {
		case "num":
			return writeNum(ctx, field, value, out);
		case "bool":
			return writeBool(ctx, value, out);
		case "str":
			return writeStr(ctx, field, value, out);
		case "vector2":
			return writeNum2(ctx, value, "X", "Y", "f32", out);
		case "datatype":
			return writeDatatype(ctx, field.name, value, out);
		case "buffer":
			return writeBuffer(ctx, field, value, out);
		case "vector3":
			return writeVector3(ctx, field, value, out);
		case "color3":
			return writeColor3(ctx, value, out);
		case "cframe":
			return field.packed ? writePackedCFrame(ctx, value, out) : writeCFrame(ctx, value, field.position, out);
		case "colorSequence":
			return writeSequence(ctx, value, "ColorSequence", out);
		case "numberSequence":
			return writeSequence(ctx, value, "NumberSequence", out);
		case "enum":
			return writeEnum(ctx, field, value, out);
		case "object":
			return writeObject(ctx, field, value, out);
		case "recursiveRef":
			return writeRecursiveRef(ctx, field, value, out);
		case "array":
			return writeArray(ctx, field, value, out);
		case "tuple":
			return writeTuple(ctx, field, value, out);
		case "dict":
			return writeDict(ctx, field, value, out);
		case "optional":
			return writeOptional(ctx, field, value, out, true);
		case "literalConst":
			return; // zero bytes -- known on both ends at compile time.
		case "literal":
			return writeLiteral(ctx, field, value, out);
		case "taggedUnion":
			return writeTaggedUnion(ctx, field, value, out);
		case "guardedUnion":
			return writeGuardedUnion(ctx, field, value, out);
		case "blob":
			return writeBlob(ctx, value, out);
	}
}

function writeNum(
	ctx: EmitContext,
	field: Extract<Field, { kind: "num" }>,
	value: ts.Expression,
	out: ts.Statement[],
): void {
	const { buf, pos, statements } = ctx.destructureAlloc("alloc", WIDTH_BYTES[field.width]);
	out.push(...statements);
	out.push(...ctx.writeNumberAt(field.width, buf, pos, value));
}

function writeBool(ctx: EmitContext, value: ts.Expression, out: ts.Statement[]): void {
	const f = ctx.factory;
	const { buf, pos, statements } = ctx.destructureAlloc("alloc", 1);
	out.push(...statements);
	out.push(
		f.createExpressionStatement(
			ctx.bufferCall("writeu8", [
				buf,
				pos,
				f.createConditionalExpression(value, undefined, ctx.num(1), undefined, ctx.num(0)),
			]),
		),
	);
}

/** Reserves and writes the count a variable-length kind puts ahead of its contents. */
function writeCount(ctx: EmitContext, length: CountSpec | undefined, count: ts.Expression, out: ts.Statement[]): void {
	const width = lengthWidth(length);
	const { buf, pos, statements } = ctx.destructureAlloc("alloc", WIDTH_BYTES[width]);
	out.push(...statements);
	out.push(...ctx.writeNumberAt(width, buf, pos, count));
}

function writeStr(
	ctx: EmitContext,
	field: Extract<Field, { kind: "str" }>,
	value: ts.Expression,
	out: ts.Statement[],
): void {
	const f = ctx.factory;
	const s = ctx.fresh("s");
	out.push(ctx.constStatement(s, value));
	const lenExpr = f.createCallExpression(f.createPropertyAccessExpression(s, "size"), undefined, []);
	const exact = exactCount(field.length);
	if (exact !== undefined) {
		const { buf, pos, statements } = ctx.destructureAlloc("alloc", exact);
		out.push(...statements);
		// The fourth argument is a byte count, so a longer string is
		// truncated to it and a shorter one raises `string length overflow`.
		out.push(f.createExpressionStatement(ctx.bufferCall("writestring", [buf, pos, s, ctx.num(exact)])));
		return;
	}
	writeCount(ctx, field.length, lenExpr, out);
	const { buf, pos, statements } = ctx.destructureAlloc("alloc", lenExpr);
	out.push(...statements);
	out.push(f.createExpressionStatement(ctx.bufferCall("writestring", [buf, pos, s])));
}

function writeBuffer(
	ctx: EmitContext,
	field: Extract<Field, { kind: "buffer" }>,
	value: ts.Expression,
	out: ts.Statement[],
): void {
	const f = ctx.factory;
	const source = ctx.fresh("src");
	out.push(ctx.constStatement(source, value));
	const exact = exactCount(field.length);
	if (exact !== undefined) {
		const { buf, pos, statements } = ctx.destructureAlloc("alloc", exact);
		out.push(...statements);
		// `buffer.copy`'s count is what is read from the source, so a
		// shorter source is out of bounds and a longer one is truncated.
		out.push(f.createExpressionStatement(ctx.bufferCall("copy", [buf, pos, source, ctx.num(0), ctx.num(exact)])));
		return;
	}
	const len = ctx.fresh("len");
	out.push(ctx.constStatement(len, ctx.bufferCall("len", [source])));
	writeCount(ctx, field.length, len, out);
	const { buf, pos, statements } = ctx.destructureAlloc("alloc", len);
	out.push(...statements);
	out.push(f.createExpressionStatement(ctx.bufferCall("copy", [buf, pos, source, ctx.num(0), len])));
}

function writeVector3(
	ctx: EmitContext,
	field: Extract<Field, { kind: "vector3" }>,
	value: ts.Expression,
	out: ts.Statement[],
): void {
	const widths = componentsOf(field.components);
	const { buf, pos, statements } = ctx.destructureAlloc("alloc", componentBytes(widths));
	out.push(...statements);
	writeNum3(ctx, value, "X", "Y", "Z", widths, { buf, pos, offset: 0 }, out);
}

/**
 * The packed form branches on the value, so it is a runtime function
 * (cframe.ts in @rbxts/surge) and not inlined code. It writes 1, 13 or
 * 25 bytes: reserve the largest, then pull the cursor back to what it
 * actually used. Reserving first is what guarantees the room.
 */
function writePackedCFrame(ctx: EmitContext, value: ts.Expression, out: ts.Statement[]): void {
	const { buf, pos, statements } = ctx.destructureAlloc("alloc", PACKED_CFRAME_MAX_BYTES);
	out.push(...statements);
	out.push(
		ctx.assign(
			CURSOR,
			ctx.factory.createBinaryExpression(
				pos,
				ctx.ts_.SyntaxKind.PlusToken,
				ctx.call("writePackedCFrame", [buf, pos, value]),
			),
		),
	);
}

function writeEnum(
	ctx: EmitContext,
	field: Extract<Field, { kind: "enum" }>,
	value: ts.Expression,
	out: ts.Statement[],
): void {
	const bytes = field.members.length <= 256 ? 1 : 2;
	const { buf, pos, statements } = ctx.destructureAlloc("alloc", bytes);
	out.push(...statements);
	out.push(
		ctx.factory.createExpressionStatement(
			ctx.bufferCall(bytes === 1 ? "writeu8" : "writeu16", [
				buf,
				pos,
				enumIndexExpr(ctx, field.enumName, field.members, value),
			]),
		),
	);
}

function writeRecursiveRef(
	ctx: EmitContext,
	field: Extract<Field, { kind: "recursiveRef" }>,
	value: ts.Expression,
	out: ts.Statement[],
): void {
	// `ensureHelper` is idempotent (guarded by `generatedHelpers`):
	// calling it here matters when this `recursiveRef` is the root
	// field itself (a directly recursive union/alias, not one reached
	// through an `object`'s `helperName`, which already calls it from
	// `writeObject`) -- without it, this call site would reference a
	// helper function that's never declared.
	ctx.ensureHelper(field.helperName);
	out.push(ctx.factory.createExpressionStatement(ctx.callLocal(`${field.helperName}_write`, [value])));
}

function writeArray(
	ctx: EmitContext,
	field: Extract<Field, { kind: "array" }>,
	value: ts.Expression,
	out: ts.Statement[],
): void {
	const f = ctx.factory;
	const arr = ctx.fresh("arr");
	out.push(ctx.constStatement(arr, value));
	const exact = exactCount(field.length);
	if (exact !== undefined) {
		// Indexed rather than `for...of`, so exactly this many are
		// written however many the value holds. A longer one is
		// ignored past the bound. A shorter one writes `nil`
		// elements, which raises for every element kind but an
		// optional -- `nil` is what an absent optional writes, so
		// there it pads instead (pinned in collections.spec.ts).
		const i = ctx.fresh("i");
		const body: ts.Statement[] = [];
		writeField(ctx, field.element, f.createElementAccessExpression(arr, i), body);
		out.push(ctx.indexedLoop(i, 0, ctx.num(exact), body));
		return;
	}
	writeCount(ctx, field.length, ctx.sizeOf(arr), out);
	const item = ctx.fresh("item");
	const body: ts.Statement[] = [];
	writeField(ctx, field.element, item, body);
	out.push(
		f.createForOfStatement(
			undefined,
			f.createVariableDeclarationList([f.createVariableDeclaration(item)], ctx.ts_.NodeFlags.Const),
			arr,
			f.createBlock(body, true),
		),
	);
}

function writeTuple(
	ctx: EmitContext,
	field: Extract<Field, { kind: "tuple" }>,
	value: ts.Expression,
	out: ts.Statement[],
): void {
	const f = ctx.factory;
	const tup = ctx.fresh("tup");
	out.push(ctx.constStatement(tup, value));
	ctx.pushScoped(
		field.fixed.map((elementField, i) =>
			ctx.measure((itemOut) =>
				writeField(ctx, elementField, f.createElementAccessExpression(tup, ctx.num(i)), itemOut),
			),
		),
		out,
	);
	if (!field.rest) {
		return;
	}
	const rest = field.rest;
	const fixedCount = field.fixed.length;
	const exact = exactCount(field.length);
	// `tup[i]` has the union of every element type; the index is past
	// the fixed elements, so it is a rest element.
	const restElement = (i: ts.Identifier): ts.Expression =>
		ctx.castTo(f.createElementAccessExpression(tup, i), fieldToTypeNode(ctx, rest));
	if (exact !== undefined) {
		const i = ctx.fresh("i");
		const body: ts.Statement[] = [];
		writeField(ctx, rest, restElement(i), body);
		out.push(ctx.indexedLoop(i, fixedCount, ctx.num(fixedCount + exact), body));
		return;
	}
	writeCount(
		ctx,
		field.length,
		f.createBinaryExpression(ctx.sizeOf(tup), ctx.ts_.SyntaxKind.MinusToken, ctx.num(fixedCount)),
		out,
	);
	const i = ctx.fresh("i");
	const body: ts.Statement[] = [];
	writeField(ctx, rest, restElement(i), body);
	out.push(
		f.createForStatement(
			f.createVariableDeclarationList(
				[f.createVariableDeclaration(i, undefined, undefined, ctx.num(fixedCount))],
				ctx.ts_.NodeFlags.Let,
			),
			f.createBinaryExpression(i, ctx.ts_.SyntaxKind.LessThanToken, ctx.sizeOf(tup)),
			f.createPostfixIncrement(i),
			f.createBlock(body, true),
		),
	);
}

function writeLiteral(
	ctx: EmitContext,
	field: Extract<Field, { kind: "literal" }>,
	value: ts.Expression,
	out: ts.Statement[],
): void {
	const bytes = field.values.length <= 256 ? 1 : 2;
	const { buf, pos, statements } = ctx.destructureAlloc("alloc", bytes);
	out.push(...statements);
	out.push(
		ctx.factory.createExpressionStatement(
			ctx.bufferCall(bytes === 1 ? "writeu8" : "writeu16", [
				buf,
				pos,
				literalIndexExpr(ctx, field.values, value),
			]),
		),
	);
}

function writeBlob(ctx: EmitContext, value: ts.Expression, out: ts.Statement[]): void {
	// `pushBlob` takes `defined`, and the static type of a blob can be `unknown`.
	const asDefined = ctx.castTo(value, ctx.factory.createTypeReferenceNode("defined"));
	out.push(ctx.factory.createExpressionStatement(ctx.call("pushBlob", [asDefined])));
}

function writeDatatype(ctx: EmitContext, name: string, value: ts.Expression, out: ts.Statement[]): void {
	const f = ctx.factory;
	const { components } = FIXED_DATATYPES[name];
	const size = components.reduce((total, component) => total + WIDTH_BYTES[component.width], 0);
	const { buf, pos, statements } = ctx.destructureAlloc("alloc", size);
	out.push(...statements);
	let offset = 0;
	for (const component of components) {
		const read = component.path.reduce<ts.Expression>(
			(target, key) => f.createPropertyAccessExpression(target, key),
			value,
		);
		out.push(
			f.createExpressionStatement(
				ctx.bufferCall(`write${component.width}`, [buf, ctx.offsetFrom(pos, offset), read]),
			),
		);
		offset += WIDTH_BYTES[component.width];
	}
}

function writeNum2(
	ctx: EmitContext,
	value: ts.Expression,
	a: string,
	b: string,
	width: "f32",
	out: ts.Statement[],
): void {
	const f = ctx.factory;
	const { buf, pos, statements } = ctx.destructureAlloc("alloc", 8);
	out.push(...statements);
	out.push(
		f.createExpressionStatement(
			ctx.bufferCall(`write${width}`, [buf, pos, f.createPropertyAccessExpression(value, a)]),
		),
	);
	out.push(
		f.createExpressionStatement(
			ctx.bufferCall(`write${width}`, [
				buf,
				f.createBinaryExpression(pos, ctx.ts_.SyntaxKind.PlusToken, ctx.num(4)),
				f.createPropertyAccessExpression(value, b),
			]),
		),
	);
}

/**
 * Writes three components, each at its own width, into the bytes `slot`
 * starts at. The caller reserves `componentBytes(widths)` of them.
 */
function writeNum3(
	ctx: EmitContext,
	value: ts.Expression,
	a: string,
	b: string,
	c: string,
	widths: ComponentWidths,
	slot: Slot,
	out: ts.Statement[],
): void {
	const f = ctx.factory;
	let offset = 0;
	[a, b, c].forEach((component, i) => {
		out.push(
			...ctx.writeNumberAt(
				widths[i],
				slot.buf,
				ctx.at(slot, offset),
				f.createPropertyAccessExpression(value, component),
			),
		);
		offset += WIDTH_BYTES[widths[i]];
	});
}

function writeColor3(ctx: EmitContext, value: ts.Expression, out: ts.Statement[]): void {
	const f = ctx.factory;
	const { buf, pos, statements } = ctx.destructureAlloc("alloc", 3);
	out.push(...statements);
	(["R", "G", "B"] as const).forEach((channel, i) => {
		const byteExpr = f.createCallExpression(
			f.createPropertyAccessExpression(f.createIdentifier("math"), "floor"),
			undefined,
			[
				f.createBinaryExpression(
					f.createPropertyAccessExpression(value, channel),
					ctx.ts_.SyntaxKind.AsteriskToken,
					ctx.num(255),
				),
			],
		);
		out.push(
			f.createExpressionStatement(
				ctx.bufferCall("writeu8", [
					buf,
					i === 0 ? pos : f.createBinaryExpression(pos, ctx.ts_.SyntaxKind.PlusToken, ctx.num(i)),
					byteExpr,
				]),
			),
		);
	});
}

function writeCFrame(
	ctx: EmitContext,
	value: ts.Expression,
	position: ComponentWidths | undefined,
	out: ts.Statement[],
): void {
	const f = ctx.factory;
	const widths = componentsOf(position);
	const positionBytes = componentBytes(widths);
	// One reservation for both halves. `ToAxisAngle` and `Vector3.mul`
	// sit between the two writes, and neither can grow the scratch
	// buffer, so `buf` is still the buffer `alloc` handed back when the
	// rotation is written.
	const { buf, pos, statements } = ctx.destructureAlloc("alloc", positionBytes + ROTATION_BYTES);
	out.push(...statements);
	writeNum3(
		ctx,
		f.createPropertyAccessExpression(value, "Position"),
		"X",
		"Y",
		"Z",
		widths,
		{ buf, pos, offset: 0 },
		out,
	);
	const axis = ctx.fresh("axis");
	const angle = ctx.fresh("angle");
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
						f.createCallExpression(f.createPropertyAccessExpression(value, "ToAxisAngle"), undefined, []),
					),
				],
				ctx.ts_.NodeFlags.Const,
			),
		),
	);
	const rv = ctx.fresh("rv");
	out.push(
		ctx.constStatement(
			rv,
			f.createCallExpression(f.createPropertyAccessExpression(axis, "mul"), undefined, [angle]),
		),
	);
	writeNum3(ctx, rv, "X", "Y", "Z", DEFAULT_COMPONENTS, { buf, pos, offset: positionBytes }, out);
}

function writeSequence(
	ctx: EmitContext,
	value: ts.Expression,
	kind: "ColorSequence" | "NumberSequence",
	out: ts.Statement[],
): void {
	const f = ctx.factory;
	const keypoints = ctx.fresh("keypoints");
	out.push(ctx.constStatement(keypoints, f.createPropertyAccessExpression(value, "Keypoints")));
	const { buf, pos, statements } = ctx.destructureAlloc("alloc", 1);
	out.push(...statements);
	out.push(f.createExpressionStatement(ctx.bufferCall("writeu8", [buf, pos, ctx.sizeOf(keypoints)])));
	const kp = ctx.fresh("kp");
	const body: ts.Statement[] = [];
	const { buf: kbuf, pos: kpos, statements: kstmt } = ctx.destructureAlloc("alloc", 4);
	body.push(...kstmt);
	body.push(
		f.createExpressionStatement(
			ctx.bufferCall("writef32", [kbuf, kpos, f.createPropertyAccessExpression(kp, "Time")]),
		),
	);
	if (kind === "ColorSequence") {
		const colorBody: ts.Statement[] = [];
		writeColor3(ctx, f.createPropertyAccessExpression(kp, "Value"), colorBody);
		body.push(...colorBody);
	} else {
		const { buf: vbuf, pos: vpos, statements: vstmt } = ctx.destructureAlloc("alloc", 8);
		body.push(...vstmt);
		body.push(
			f.createExpressionStatement(
				ctx.bufferCall("writef32", [vbuf, vpos, f.createPropertyAccessExpression(kp, "Value")]),
			),
		);
		// fbs drops the envelope. It is part of the value, so it is kept here.
		body.push(
			f.createExpressionStatement(
				ctx.bufferCall("writef32", [
					vbuf,
					ctx.offsetFrom(vpos, 4),
					f.createPropertyAccessExpression(kp, "Envelope"),
				]),
			),
		);
	}
	out.push(
		f.createForOfStatement(
			undefined,
			f.createVariableDeclarationList([f.createVariableDeclaration(kp)], ctx.ts_.NodeFlags.Const),
			keypoints,
			f.createBlock(body, true),
		),
	);
}

function enumIndexExpr(
	ctx: EmitContext,
	enumName: string,
	members: ReadonlyArray<string>,
	value: ts.Expression,
): ts.Expression {
	const { indexName } = ctx.ensureEnumTable(enumName, members);
	const f = ctx.factory;
	return f.createNonNullExpression(
		f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier(indexName), "get"), undefined, [
			f.createPropertyAccessExpression(value, "Name"),
		]),
	);
}

function literalIndexExpr(
	ctx: EmitContext,
	values: ReadonlyArray<string | number | boolean | undefined>,
	value: ts.Expression,
): ts.Expression {
	const f = ctx.factory;
	let expr: ts.Expression = ctx.num(values.length - 1);
	for (let i = values.length - 2; i >= 0; i--) {
		const v = values[i];
		const check =
			v === undefined
				? f.createBinaryExpression(
						value,
						ctx.ts_.SyntaxKind.EqualsEqualsEqualsToken,
						f.createIdentifier("undefined"),
					)
				: f.createBinaryExpression(value, ctx.ts_.SyntaxKind.EqualsEqualsEqualsToken, ctx.literalValueExpr(v));
		expr = f.createConditionalExpression(check, undefined, ctx.num(i), undefined, expr);
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
 * representation is already an indistinguishable plain table (behavior 2 in
 * docs/research/compile-time-specialization.md in the surge repo), so the
 * cast is lossless either way.
 */
function asMapOrSet(
	ctx: EmitContext,
	value: ts.Expression,
	keyField: Field,
	valueField: Field | undefined,
): ts.Expression {
	const f = ctx.factory;
	const typeNode = valueField
		? f.createTypeReferenceNode("Map", [fieldToTypeNode(ctx, keyField), fieldToTypeNode(ctx, valueField)])
		: f.createTypeReferenceNode("Set", [fieldToTypeNode(ctx, keyField)]);
	return f.createAsExpression(
		f.createAsExpression(value, f.createKeywordTypeNode(ctx.ts_.SyntaxKind.UnknownKeyword)),
		typeNode,
	);
}

function writeDict(
	ctx: EmitContext,
	field: Extract<Field, { kind: "dict" }>,
	value: ts.Expression,
	out: ts.Statement[],
): void {
	const f = ctx.factory;
	const isSet = field.value === undefined;
	const dictTmp = ctx.fresh("dict");
	out.push(ctx.constStatement(dictTmp, value));
	const countWidth = lengthWidth(field.length);
	const { buf: cbuf, pos: cpos, statements: cstmt } = ctx.destructureAlloc("alloc", WIDTH_BYTES[countWidth]);
	out.push(...cstmt);
	const count = ctx.fresh("count");
	out.push(
		f.createVariableStatement(
			undefined,
			f.createVariableDeclarationList(
				[f.createVariableDeclaration(count, undefined, undefined, ctx.num(0))],
				ctx.ts_.NodeFlags.Let,
			),
		),
	);
	const k = ctx.fresh("k");
	const body: ts.Statement[] = [];
	writeField(ctx, field.key, k, body);
	if (!isSet) {
		const v = ctx.fresh("v");
		writeField(ctx, field.value!, v, body);
		body.push(f.createExpressionStatement(f.createPostfixUnaryExpression(count, ctx.ts_.SyntaxKind.PlusPlusToken)));
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
					ctx.ts_.NodeFlags.Const,
				),
				asMapOrSet(ctx, dictTmp, field.key, field.value),
				f.createBlock(body, true),
			),
		);
	} else {
		body.push(f.createExpressionStatement(f.createPostfixUnaryExpression(count, ctx.ts_.SyntaxKind.PlusPlusToken)));
		out.push(
			f.createForOfStatement(
				undefined,
				f.createVariableDeclarationList([f.createVariableDeclaration(k)], ctx.ts_.NodeFlags.Const),
				asMapOrSet(ctx, dictTmp, field.key, undefined),
				f.createBlock(body, true),
			),
		);
	}
	out.push(...ctx.writeNumberAt(countWidth, cbuf, cpos, count));
}

function writeObject(
	ctx: EmitContext,
	field: Extract<Field, { kind: "object" }>,
	value: ts.Expression,
	out: ts.Statement[],
): void {
	if (field.helperName) {
		ctx.ensureHelper(field.helperName);
		out.push(ctx.factory.createExpressionStatement(ctx.callLocal(`${field.helperName}_write`, [value])));
		return;
	}
	writeObjectInline(ctx, field.fields, value, out);
}

export function writeObjectInline(
	ctx: EmitContext,
	fields: ReadonlyArray<ObjectFieldEntry>,
	value: ts.Expression,
	out: ts.Statement[],
): void {
	// The packed region comes first: the read side needs an optional's
	// presence bit before it reaches that optional's value.
	const bits = packedBits(fields);
	const items: ScopedItem[] = [];
	if (bits.length > 0) {
		items.push(ctx.measure((itemOut) => writePackedBits(ctx, bits, value, itemOut)));
	}
	// A field whose bytes the packed region already holds writes nothing
	// here; one whose presence or tag is a bit writes the rest of itself
	// through its own path, so neither can share a reservation.
	const written = fields.filter((entry) => !isAllPackedBits(entry.field));
	const shareable = (entry: ObjectFieldEntry) =>
		!bits.some((bit) => bit.entry === entry) && fixedBytes(entry.field) !== undefined;
	for (const group of allocRuns(written, shareable)) {
		if (group.length > 1) {
			const total = group.reduce((sum, entry) => sum + fixedBytes(entry.field)!, 0);
			items.push(
				ctx.measure((itemOut) => {
					ctx.withAllocRun("alloc", total, () => {
						for (const entry of group) {
							writeField(ctx, entry.field, ctx.propertyAccess(value, entry), itemOut);
						}
					});
				}),
			);
			continue;
		}
		const entry = group[0];
		const field = entry.field;
		items.push(
			ctx.measure((itemOut) => {
				const property = ctx.propertyAccess(value, entry);
				if (field.kind === "optional" && field.packed) {
					writeOptional(ctx, field, property, itemOut, false);
				} else if (bits.some((bit) => bit.entry === entry && bit.role === "tag")) {
					writeTaggedUnion(ctx, field as Extract<Field, { kind: "taggedUnion" }>, property, itemOut, false);
				} else {
					writeField(ctx, field, property, itemOut);
				}
			}),
		);
	}
	ctx.pushScoped(items, out);
}

function writeOptional(
	ctx: EmitContext,
	field: Extract<Field, { kind: "optional" }>,
	value: ts.Expression,
	out: ts.Statement[],
	writeFlag: boolean,
): void {
	const f = ctx.factory;
	// Bound to a local first, and narrowed via a direct `!== undefined`
	// check on that local (not a separately-computed boolean), which is
	// what lets TS narrow it to non-optional for the inner write below --
	// narrowing a repeated property-access expression like `value.x`
	// doesn't survive being routed through an intermediate variable.
	const tmp = ctx.fresh("opt");
	out.push(ctx.constStatement(tmp, value));
	const isPresent = (expr: ts.Expression) =>
		f.createBinaryExpression(
			expr,
			ctx.ts_.SyntaxKind.ExclamationEqualsEqualsToken,
			f.createIdentifier("undefined"),
		);
	// Without the flag, the presence bit is in the enclosing object's packed region.
	if (writeFlag) {
		const { buf, pos, statements } = ctx.destructureAlloc("alloc", 1);
		out.push(...statements);
		out.push(
			f.createExpressionStatement(
				ctx.bufferCall("writeu8", [
					buf,
					pos,
					f.createConditionalExpression(isPresent(tmp), undefined, ctx.num(1), undefined, ctx.num(0)),
				]),
			),
		);
	}
	const innerStatements: ts.Statement[] = [];
	writeField(ctx, field.inner, tmp, innerStatements);
	out.push(f.createIfStatement(isPresent(tmp), f.createBlock(innerStatements, true)));
}

function writePackedBits(
	ctx: EmitContext,
	bits: ReadonlyArray<PackedBit>,
	value: ts.Expression,
	out: ts.Statement[],
): void {
	const f = ctx.factory;
	const byteCount = Math.ceil(bits.length / 8);
	const { buf, pos, statements } = ctx.destructureAlloc("alloc", byteCount);
	out.push(...statements);
	// One `writeu8` per byte, computed from all its bits at once, rather
	// than one `packBit` call per bit into the reused scratch region:
	// `alloc()` doesn't zero a region it didn't just grow into, so a
	// bit-at-a-time write would leave any bit past `bits.length`
	// holding whatever an earlier `serialize()` call left there (the
	// wire-format-determinism finding in
	// docs/research/september-2026-review.md in the surge repo). Computing the
	// whole byte writes every bit, including the unused high ones (implicitly
	// zero), so the result is deterministic by construction.
	for (let byteIndex = 0; byteIndex < byteCount; byteIndex++) {
		const chunk = bits.slice(byteIndex * 8, byteIndex * 8 + 8);
		const byteExpr = packedByteExpr(ctx, chunk, value);
		out.push(
			f.createExpressionStatement(ctx.bufferCall("writeu8", [buf, ctx.offsetFrom(pos, byteIndex), byteExpr])),
		);
	}
}

/** Sums `1 << bitIndex` for each set bit in `bits` (bit 0 = the byte's least-significant bit, matching `unpackBit`'s `buffer.readbits`). */
function packedByteExpr(ctx: EmitContext, bits: ReadonlyArray<PackedBit>, value: ts.Expression): ts.Expression {
	const f = ctx.factory;
	let expr: ts.Expression | undefined;
	bits.forEach(({ entry, role }, bitIndex) => {
		const property = ctx.propertyAccess(value, entry);
		let condition: ts.Expression = property;
		if (role === "tag" && entry.field.kind === "taggedUnion") {
			condition = f.createBinaryExpression(
				ctx.propertyAccess(property, tagKeyOf(entry.field)),
				ctx.ts_.SyntaxKind.EqualsEqualsEqualsToken,
				ctx.literalValueExpr(entry.field.variants[1].tagValue),
			);
		} else if (role === "present") {
			condition = f.createBinaryExpression(
				property,
				ctx.ts_.SyntaxKind.ExclamationEqualsEqualsToken,
				f.createIdentifier("undefined"),
			);
		} else if (entry.field.kind === "optional") {
			// The value bit of an optional boolean: `undefined` is not a condition TypeScript accepts.
			condition = f.createBinaryExpression(property, ctx.ts_.SyntaxKind.EqualsEqualsEqualsToken, f.createTrue());
		}
		const term = f.createConditionalExpression(condition, undefined, ctx.num(1 << bitIndex), undefined, ctx.num(0));
		expr = expr ? f.createBinaryExpression(expr, ctx.ts_.SyntaxKind.PlusToken, term) : term;
	});
	return expr!;
}

function writeTaggedUnion(
	ctx: EmitContext,
	field: Extract<Field, { kind: "taggedUnion" }>,
	value: ts.Expression,
	out: ts.Statement[],
	// `false` when the enclosing object's packed region holds the tag as one bit.
	writeIndex = true,
): void {
	const f = ctx.factory;
	const tagExpr = ctx.propertyAccess(value, tagKeyOf(field));
	const idxBytes = field.variants.length <= 256 ? 1 : 2;
	const idx = ctx.fresh("idx");
	out.push(
		ctx.constStatement(
			idx,
			literalIndexExpr(
				ctx,
				field.variants.map((v) => v.tagValue),
				tagExpr,
			),
		),
	);
	if (writeIndex) {
		const { buf, pos, statements } = ctx.destructureAlloc("alloc", idxBytes);
		out.push(...statements);
		out.push(f.createExpressionStatement(ctx.bufferCall(idxBytes === 1 ? "writeu8" : "writeu16", [buf, pos, idx])));
	}

	let chain: ts.Statement | undefined;
	for (let i = field.variants.length - 1; i >= 0; i--) {
		const branch: ts.Statement[] = [];
		const variantType = objectShapeTypeNode(ctx, field.variants[i].fields);
		writeObjectInline(ctx, field.variants[i].fields, ctx.castTo(value, variantType), branch);
		const cond = f.createBinaryExpression(idx, ctx.ts_.SyntaxKind.EqualsEqualsEqualsToken, ctx.num(i));
		chain = f.createIfStatement(cond, f.createBlock(branch, true), chain);
	}
	if (chain) out.push(chain);
}

function writeGuardedUnion(
	ctx: EmitContext,
	field: Extract<Field, { kind: "guardedUnion" }>,
	value: ts.Expression,
	out: ts.Statement[],
): void {
	const f = ctx.factory;
	const idxBytes = field.variants.length <= 256 ? 1 : 2;
	const idx = ctx.fresh("idx");
	let idxExpr: ts.Expression = ctx.num(field.variants.length - 1);
	for (let i = field.variants.length - 2; i >= 0; i--) {
		idxExpr = f.createConditionalExpression(
			guardFor(ctx, field.variants[i], value),
			undefined,
			ctx.num(i),
			undefined,
			idxExpr,
		);
	}
	out.push(ctx.constStatement(idx, idxExpr));
	const { buf, pos, statements } = ctx.destructureAlloc("alloc", idxBytes);
	out.push(...statements);
	out.push(f.createExpressionStatement(ctx.bufferCall(idxBytes === 1 ? "writeu8" : "writeu16", [buf, pos, idx])));

	let chain: ts.Statement | undefined;
	for (let i = field.variants.length - 1; i >= 0; i--) {
		const branch: ts.Statement[] = [];
		writeField(ctx, field.variants[i], ctx.castTo(value, fieldToTypeNode(ctx, field.variants[i])), branch);
		const cond = f.createBinaryExpression(idx, ctx.ts_.SyntaxKind.EqualsEqualsEqualsToken, ctx.num(i));
		chain = f.createIfStatement(cond, f.createBlock(branch, true), chain);
	}
	if (chain) out.push(chain);
}

function guardFor(ctx: EmitContext, field: Field, value: ts.Expression): ts.Expression {
	const f = ctx.factory;
	const typeIs = (tag: string) => ctx.callLocal("typeIs", [value, f.createStringLiteral(tag)]);
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
				ctx.ts_.SyntaxKind.EqualsEqualsEqualsToken,
				ctx.literalValueExpr(field.value),
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
