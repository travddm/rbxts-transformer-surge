/** The read side, mirroring `write.ts` function for function. */
import type ts from "typescript";

import { FIXED_DATATYPES } from "../datatypes";
import type { ComponentWidths, CountSpec, Field, FieldKey, ObjectFieldEntry } from "../field";
import {
	DEFAULT_COMPONENTS,
	QUANTIZED_COMPONENTS,
	QUANTIZED_ROTATION_SCALE,
	READ_BUFFER,
	READ_CURSOR,
	READ_LENGTH,
	WIDTH_BYTES,
	ZERO_SIZE_COUNT_CAP,
} from "./constants";
import type { EmitContext, ScopedItem, Slot } from "./context";
import {
	allocRuns,
	bitSetBytes,
	cframeBytes,
	componentBytes,
	componentsOf,
	exactCount,
	fixedBytes,
	lengthWidth,
	minBytes,
	packedBits,
	tagKeyOf,
} from "./layout";
import { fieldToTypeNode, objectShapeTypeNode } from "./types";

export function readField(ctx: EmitContext, field: Field, out: ts.Statement[]): ts.Expression {
	switch (field.kind) {
		case "num":
			return readNum(ctx, field, out);
		case "bool":
			return readBool(ctx, out);
		case "str":
			return readStr(ctx, field, out);
		case "vector2":
			return readVector2(ctx, out);
		case "datatype":
			return readDatatype(ctx, field.name, out);
		case "buffer":
			return readBuffer(ctx, field, out);
		case "vector3":
			return readVector3(ctx, field, out);
		case "color3":
			return readColor3(ctx, out);
		case "cframe":
			return field.packed ? readPackedCFrame(ctx, out) : readCFrame(ctx, field, out);
		case "colorSequence":
			return readSequence(ctx, "ColorSequence", out);
		case "numberSequence":
			return readSequence(ctx, "NumberSequence", out);
		case "enum":
			return readEnum(ctx, field, out);
		case "object":
			return readObject(ctx, field, out);
		case "recursiveRef":
			return readRecursiveRef(ctx, field, out);
		case "array":
			return readArray(ctx, field, out);
		case "tuple":
			return readTuple(ctx, field, out);
		case "dict":
			return readDict(ctx, field, out);
		case "bitSet":
			return readBitSet(ctx, field, out);
		case "optional":
			return readOptional(ctx, field, out, undefined);
		case "literalConst":
			return ctx.literalValueExpr(field.value);
		case "literal":
			return readLiteral(ctx, field, out);
		case "taggedUnion":
			return readTaggedUnion(ctx, field, out);
		case "guardedUnion":
			return readGuardedUnion(ctx, field, out);
		case "blob":
			return readBlob(ctx, out);
	}
}

function readNum(ctx: EmitContext, field: Extract<Field, { kind: "num" }>, out: ts.Statement[]): ts.Expression {
	const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", WIDTH_BYTES[field.width]);
	out.push(...statements);
	return ctx.readNumberAt(field.width, buf, pos);
}

function readBool(ctx: EmitContext, out: ts.Statement[]): ts.Expression {
	const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", 1);
	out.push(...statements);
	return ctx.factory.createBinaryExpression(
		ctx.bufferCall("readu8", [buf, pos]),
		ctx.ts_.SyntaxKind.ExclamationEqualsEqualsToken,
		ctx.num(0),
	);
}

function readStr(ctx: EmitContext, field: Extract<Field, { kind: "str" }>, out: ts.Statement[]): ts.Expression {
	const exact = exactCount(field.length);
	if (exact !== undefined) {
		const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", exact);
		out.push(...statements);
		return ctx.bufferCall("readstring", [buf, pos, ctx.num(exact)]);
	}
	const width = lengthWidth(field.length);
	const { buf: lbuf, pos: lpos, statements: lstmt } = ctx.destructureAlloc("readAlloc", WIDTH_BYTES[width]);
	out.push(...lstmt);
	const len = ctx.fresh("len");
	out.push(ctx.constStatement(len, ctx.readNumberAt(width, lbuf, lpos)));
	const { buf: sbuf, pos: spos, statements: sstmt } = ctx.destructureAlloc("readAlloc", len);
	out.push(...sstmt);
	return ctx.bufferCall("readstring", [sbuf, spos, len]);
}

function readVector2(ctx: EmitContext, out: ts.Statement[]): ts.Expression {
	const [x, y] = readNum2(ctx, "f32", out);
	return ctx.factory.createNewExpression(ctx.factory.createIdentifier("Vector2"), undefined, [x, y]);
}

function readBuffer(ctx: EmitContext, field: Extract<Field, { kind: "buffer" }>, out: ts.Statement[]): ts.Expression {
	const f = ctx.factory;
	const exact = exactCount(field.length);
	if (exact !== undefined) {
		const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", exact);
		out.push(...statements);
		const exactResult = ctx.fresh("bytes");
		out.push(ctx.constStatement(exactResult, ctx.bufferCall("create", [ctx.num(exact)])));
		out.push(
			f.createExpressionStatement(ctx.bufferCall("copy", [exactResult, ctx.num(0), buf, pos, ctx.num(exact)])),
		);
		return exactResult;
	}
	const width = lengthWidth(field.length);
	const { buf: lbuf, pos: lpos, statements: lstmt } = ctx.destructureAlloc("readAlloc", WIDTH_BYTES[width]);
	out.push(...lstmt);
	const len = ctx.fresh("len");
	out.push(ctx.constStatement(len, ctx.readNumberAt(width, lbuf, lpos)));
	const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", len);
	out.push(...statements);
	// A copy: the input buffer holds the whole payload, and the caller owns the result.
	const result = ctx.fresh("bytes");
	out.push(ctx.constStatement(result, ctx.bufferCall("create", [len])));
	out.push(f.createExpressionStatement(ctx.bufferCall("copy", [result, ctx.num(0), buf, pos, len])));
	return result;
}

function readVector3(ctx: EmitContext, field: Extract<Field, { kind: "vector3" }>, out: ts.Statement[]): ts.Expression {
	const widths = componentsOf(field.components);
	const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", componentBytes(widths));
	out.push(...statements);
	const [x, y, z] = readNum3(ctx, widths, { buf, pos, offset: 0 });
	return ctx.factory.createNewExpression(ctx.factory.createIdentifier("Vector3"), undefined, [x, y, z]);
}

function readEnum(ctx: EmitContext, field: Extract<Field, { kind: "enum" }>, out: ts.Statement[]): ts.Expression {
	const bytes = field.members.length <= 256 ? 1 : 2;
	const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", bytes);
	out.push(...statements);
	const idx = ctx.fresh("idx");
	out.push(ctx.constStatement(idx, ctx.bufferCall(bytes === 1 ? "readu8" : "readu16", [buf, pos])));
	if (ctx.readChecks) {
		// Past the items, the lookup would return `undefined` where the type
		// says an `EnumItem`, so the index is bounded like a count.
		out.push(
			ctx.throwIf(
				ctx.factory.createBinaryExpression(
					idx,
					ctx.ts_.SyntaxKind.GreaterThanEqualsToken,
					ctx.num(field.members.length),
				),
				"deserialize read an enum index past its items",
			),
		);
	}
	return enumFromIndexExpr(ctx, field.enumName, field.members, idx);
}

function readRecursiveRef(
	ctx: EmitContext,
	field: Extract<Field, { kind: "recursiveRef" }>,
	out: ts.Statement[],
): ts.Expression {
	ctx.ensureHelper(field.helperName);
	return ctx.bindSideEffect(ctx.callLocal(`${field.helperName}_read`, []), out);
}

/** Declares `const <base> = []` and returns its identifier, for a read that fills an array element by element. */
function arrayLocal(ctx: EmitContext, base: string, out: ts.Statement[]): ts.Identifier {
	const result = ctx.fresh(base);
	out.push(ctx.constStatement(result, ctx.factory.createArrayLiteralExpression([])));
	return result;
}

/** Appends `result.push(<element>)` to `body`. */
function pushElement(ctx: EmitContext, result: ts.Identifier, element: ts.Expression, body: ts.Statement[]): void {
	const f = ctx.factory;
	body.push(
		f.createExpressionStatement(
			f.createCallExpression(f.createPropertyAccessExpression(result, "push"), undefined, [element]),
		),
	);
}

/**
 * The count a variable-length read loops over: the literal the type
 * carries in the exact form, which writes no count, and otherwise a
 * local holding the count read back, bounded against what the rest of
 * the input could hold when `readChecks` is on.
 */
function readCount(
	ctx: EmitContext,
	length: CountSpec | undefined,
	element: Field,
	out: ts.Statement[],
): ts.Expression {
	const exact = exactCount(length);
	if (exact !== undefined) {
		return ctx.num(exact);
	}
	const width = lengthWidth(length);
	const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", WIDTH_BYTES[width]);
	out.push(...statements);
	const count = ctx.fresh("count");
	out.push(ctx.constStatement(count, ctx.readNumberAt(width, buf, pos)));
	checkCount(ctx, count, element, out);
	return count;
}

/**
 * Rejects a count the rest of the payload cannot hold. An element with a
 * minimum size gives a bound in bytes; one that costs nothing (a constant, a
 * blob) has no such bound, so the count itself is capped -- that case is the
 * denial of service, where a short payload declares billions of elements and
 * the loop runs every one.
 */
function checkCount(ctx: EmitContext, count: ts.Expression, element: Field, out: ts.Statement[]): void {
	checkCountOfBytes(ctx, count, minBytes(element), out);
}

/** {@link checkCount} for a `dict`, whose entry is a key and, unless it is a set, a value. */
function checkEntryCount(
	ctx: EmitContext,
	count: ts.Expression,
	field: Extract<Field, { kind: "dict" }>,
	out: ts.Statement[],
): void {
	const value = field.value;
	checkCountOfBytes(ctx, count, minBytes(field.key) + (value === undefined ? 0 : minBytes(value)), out);
}

function checkCountOfBytes(ctx: EmitContext, count: ts.Expression, min: number, out: ts.Statement[]): void {
	if (!ctx.readChecks) {
		return;
	}
	const f = ctx.factory;
	if (min === 0) {
		out.push(
			ctx.throwIf(
				f.createBinaryExpression(count, ctx.ts_.SyntaxKind.GreaterThanToken, ctx.num(ZERO_SIZE_COUNT_CAP)),
				"deserialize found a count past the limit for an element that reads no bytes",
			),
		);
		return;
	}
	const needed = min === 1 ? count : f.createBinaryExpression(count, ctx.ts_.SyntaxKind.AsteriskToken, ctx.num(min));
	out.push(
		ctx.throwIf(
			f.createBinaryExpression(
				needed,
				ctx.ts_.SyntaxKind.GreaterThanToken,
				f.createBinaryExpression(
					f.createIdentifier(READ_LENGTH),
					ctx.ts_.SyntaxKind.MinusToken,
					f.createIdentifier(READ_CURSOR),
				),
			),
			"deserialize found a count larger than the input buffer can hold",
		),
	);
}

function readArray(ctx: EmitContext, field: Extract<Field, { kind: "array" }>, out: ts.Statement[]): ts.Expression {
	const count = readCount(ctx, field.length, field.element, out);
	const result = arrayLocal(ctx, "result", out);
	const i = ctx.fresh("_i");
	const body: ts.Statement[] = [];
	pushElement(ctx, result, readField(ctx, field.element, body), body);
	out.push(ctx.countedLoop(i, count, body));
	return result;
}

function readTuple(ctx: EmitContext, field: Extract<Field, { kind: "tuple" }>, out: ts.Statement[]): ts.Expression {
	const result = arrayLocal(ctx, "tup", out);
	ctx.pushScoped(
		field.fixed.map((elementField) =>
			ctx.measure((itemOut) => pushElement(ctx, result, readField(ctx, elementField, itemOut), itemOut)),
		),
		out,
	);
	if (field.rest) {
		const count = readCount(ctx, field.length, field.rest, out);
		const i = ctx.fresh("_i");
		const body: ts.Statement[] = [];
		pushElement(ctx, result, readField(ctx, field.rest, body), body);
		out.push(ctx.countedLoop(i, count, body));
	}
	// `result` is inferred as an array of the union of what was pushed,
	// which is not assignable to a tuple type.
	return ctx.castTo(result, fieldToTypeNode(ctx, field));
}

function readLiteral(ctx: EmitContext, field: Extract<Field, { kind: "literal" }>, out: ts.Statement[]): ts.Expression {
	const bytes = field.values.length <= 256 ? 1 : 2;
	const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", bytes);
	out.push(...statements);
	const idx = ctx.fresh("idx");
	out.push(ctx.constStatement(idx, ctx.bufferCall(bytes === 1 ? "readu8" : "readu16", [buf, pos])));
	return literalFromIndexExpr(ctx, field.values, idx);
}

function readBlob(ctx: EmitContext, out: ts.Statement[]): ts.Expression {
	return ctx.bindSideEffect(ctx.call("nextBlob", []), out);
}

function readNum2(ctx: EmitContext, width: "f32", out: ts.Statement[]): [ts.Expression, ts.Expression] {
	const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", 8);
	out.push(...statements);
	const x = ctx.bufferCall(`read${width}`, [buf, pos]);
	const y = ctx.bufferCall(`read${width}`, [
		buf,
		ctx.factory.createBinaryExpression(pos, ctx.ts_.SyntaxKind.PlusToken, ctx.num(4)),
	]);
	return [x, y];
}

/** Reads what {@link writeNum3} wrote at `slot`, mirroring its widths and offsets. */
function readNum3(
	ctx: EmitContext,
	widths: ComponentWidths,
	slot: Slot,
): [ts.Expression, ts.Expression, ts.Expression] {
	let offset = 0;
	const component = (i: number) => {
		const read = ctx.readNumberAt(widths[i], slot.buf, ctx.at(slot, offset));
		offset += WIDTH_BYTES[widths[i]];
		return read;
	};
	return [component(0), component(1), component(2)];
}

function readColor3(ctx: EmitContext, out: ts.Statement[]): ts.Expression {
	const f = ctx.factory;
	const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", 3);
	out.push(...statements);
	const channel = (i: number) =>
		f.createBinaryExpression(
			ctx.bufferCall("readu8", [
				buf,
				i === 0 ? pos : f.createBinaryExpression(pos, ctx.ts_.SyntaxKind.PlusToken, ctx.num(i)),
			]),
			ctx.ts_.SyntaxKind.SlashToken,
			ctx.num(255),
		);
	return f.createNewExpression(f.createIdentifier("Color3"), undefined, [channel(0), channel(1), channel(2)]);
}

function readCFrame(ctx: EmitContext, field: Extract<Field, { kind: "cframe" }>, out: ts.Statement[]): ts.Expression {
	const f = ctx.factory;
	const widths = componentsOf(field.position);
	const positionBytes = componentBytes(widths);
	// One reservation for both halves, mirroring `writeCFrame`.
	const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", cframeBytes(field));
	out.push(...statements);
	const [px, py, pz] = readNum3(ctx, widths, { buf, pos, offset: 0 });
	const positionValue = ctx.fresh("pos");
	out.push(
		ctx.constStatement(
			positionValue,
			f.createNewExpression(f.createIdentifier("Vector3"), undefined, [px, py, pz]),
		),
	);
	const rotationSlot = { buf, pos, offset: positionBytes };
	const rotationWidths: ComponentWidths = field.quantized ? QUANTIZED_COMPONENTS : DEFAULT_COMPONENTS;
	let [rx, ry, rz] = readNum3(ctx, rotationWidths, rotationSlot);
	if (field.quantized) {
		[rx, ry, rz] = [rx, ry, rz].map((component) =>
			f.createBinaryExpression(
				component,
				ctx.ts_.SyntaxKind.AsteriskToken,
				ctx.num(1 / QUANTIZED_ROTATION_SCALE),
			),
		);
	}
	const rv = ctx.fresh("rv");
	out.push(ctx.constStatement(rv, f.createNewExpression(f.createIdentifier("Vector3"), undefined, [rx, ry, rz])));
	const angle = ctx.fresh("angle");
	out.push(ctx.constStatement(angle, f.createPropertyAccessExpression(rv, "Magnitude")));
	const rotation = ctx.fresh("rotation");
	const axisExpr = f.createConditionalExpression(
		f.createBinaryExpression(angle, ctx.ts_.SyntaxKind.GreaterThanToken, f.createNumericLiteral("1e-6")),
		undefined,
		f.createPropertyAccessExpression(rv, "Unit"),
		undefined,
		f.createPropertyAccessExpression(f.createIdentifier("Vector3"), "zAxis"),
	);
	out.push(
		ctx.constStatement(
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

/**
 * Reads a packed `CFrame`, whose size is in its own header, so the read
 * cursor can only be advanced by what the call reports back.
 */
function readPackedCFrame(ctx: EmitContext, out: ts.Statement[]): ts.Expression {
	const f = ctx.factory;
	ctx.usesReadBytes = true;
	if (ctx.readChecks) {
		out.push(...packedCFrameChecks(ctx));
	}
	const value = ctx.fresh("val");
	const used = ctx.fresh("size");
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
						ctx.call("readPackedCFrame", [
							f.createIdentifier(READ_BUFFER),
							f.createIdentifier(READ_CURSOR),
						]),
					),
				],
				ctx.ts_.NodeFlags.Const,
			),
		),
	);
	out.push(
		ctx.assign(
			READ_CURSOR,
			f.createBinaryExpression(f.createIdentifier(READ_CURSOR), ctx.ts_.SyntaxKind.PlusToken, used),
		),
	);
	return value;
}

// The header of Wire format 8.6: bits 0-4 the rotation code, 0 to 23 for an
// axis-aligned rotation and 31 for any other; bits 5-6 the position code, 0
// when the position follows. Each part the header does not give is 3 f32s.
const PACKED_GENERAL_ROTATION = 31;
const PACKED_LAST_ALIGNED_ROTATION = 23;
const PACKED_PART_BYTES = 12;

/**
 * The bound on a packed `CFrame` under `readChecks`. Its size is in its own
 * header, so the header byte is bounded first, and then the bytes it says
 * follow, before the runtime reads any of them. A rotation code that names no
 * rotation is rejected here too: the runtime would otherwise raise an error
 * that does not carry the prefix.
 */
function packedCFrameChecks(ctx: EmitContext): ts.Statement[] {
	const f = ctx.factory;
	const syntax = ctx.ts_.SyntaxKind;
	const cursor = f.createIdentifier(READ_CURSOR);
	const length = f.createIdentifier(READ_LENGTH);
	const pastEnd = (size: ts.Expression) =>
		ctx.throwIf(
			f.createBinaryExpression(
				f.createBinaryExpression(cursor, syntax.PlusToken, size),
				syntax.GreaterThanToken,
				length,
			),
			"deserialize read past the end of the input buffer",
		);
	const header = ctx.fresh("header");
	const rotation = ctx.fresh("rotation");
	const size = ctx.fresh("size");
	const extra = (condition: ts.Expression) =>
		f.createParenthesizedExpression(
			f.createConditionalExpression(condition, undefined, ctx.num(PACKED_PART_BYTES), undefined, ctx.num(0)),
		);
	return [
		pastEnd(ctx.num(1)),
		ctx.constStatement(header, ctx.bufferCall("readu8", [f.createIdentifier(READ_BUFFER), cursor])),
		ctx.constStatement(rotation, f.createBinaryExpression(header, syntax.PercentToken, ctx.num(32))),
		ctx.throwIf(
			f.createBinaryExpression(
				f.createBinaryExpression(rotation, syntax.GreaterThanToken, ctx.num(PACKED_LAST_ALIGNED_ROTATION)),
				syntax.AmpersandAmpersandToken,
				f.createBinaryExpression(
					rotation,
					syntax.ExclamationEqualsEqualsToken,
					ctx.num(PACKED_GENERAL_ROTATION),
				),
			),
			"deserialize read a packed CFrame rotation code that names no rotation",
		),
		ctx.constStatement(
			size,
			f.createBinaryExpression(
				f.createBinaryExpression(
					ctx.num(1),
					syntax.PlusToken,
					extra(
						f.createBinaryExpression(
							rotation,
							syntax.EqualsEqualsEqualsToken,
							ctx.num(PACKED_GENERAL_ROTATION),
						),
					),
				),
				syntax.PlusToken,
				extra(f.createBinaryExpression(header, syntax.LessThanToken, ctx.num(32))),
			),
		),
		pastEnd(size),
	];
}

function readSequence(ctx: EmitContext, kind: "ColorSequence" | "NumberSequence", out: ts.Statement[]): ts.Expression {
	const f = ctx.factory;
	const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", 1);
	out.push(...statements);
	const count = ctx.fresh("count");
	out.push(ctx.constStatement(count, ctx.bufferCall("readu8", [buf, pos])));
	const keypoints = ctx.fresh("keypoints");
	out.push(
		f.createVariableStatement(
			undefined,
			f.createVariableDeclarationList(
				[f.createVariableDeclaration(keypoints, undefined, undefined, f.createArrayLiteralExpression([]))],
				ctx.ts_.NodeFlags.Const,
			),
		),
	);
	const i = ctx.fresh("_i");
	const body: ts.Statement[] = [];
	const { buf: tbuf, pos: tpos, statements: tstmt } = ctx.destructureAlloc("readAlloc", 4);
	body.push(...tstmt);
	const time = ctx.fresh("time");
	body.push(ctx.constStatement(time, ctx.bufferCall("readf32", [tbuf, tpos])));
	const keypointArgs: ts.Expression[] = [time];
	if (kind === "ColorSequence") {
		keypointArgs.push(readColor3(ctx, body));
	} else {
		const { buf: vbuf, pos: vpos, statements: vstmt } = ctx.destructureAlloc("readAlloc", 8);
		body.push(...vstmt);
		keypointArgs.push(ctx.bufferCall("readf32", [vbuf, vpos]));
		keypointArgs.push(ctx.bufferCall("readf32", [vbuf, ctx.offsetFrom(vpos, 4)]));
	}
	const keypoint = f.createNewExpression(f.createIdentifier(`${kind}Keypoint`), undefined, keypointArgs);
	body.push(
		f.createExpressionStatement(
			f.createCallExpression(f.createPropertyAccessExpression(keypoints, "push"), undefined, [keypoint]),
		),
	);
	out.push(ctx.countedLoop(i, count, body));
	return f.createNewExpression(f.createIdentifier(kind), undefined, [keypoints]);
}

/**
 * Reads each byte of a bit set once and adds the member each set bit stands
 * for. Bits past the last member are not read.
 */
function readBitSet(ctx: EmitContext, field: Extract<Field, { kind: "bitSet" }>, out: ts.Statement[]): ts.Expression {
	const f = ctx.factory;
	const syntax = ctx.ts_.SyntaxKind;
	const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", bitSetBytes(field));
	out.push(...statements);
	const typeNode = fieldToTypeNode(ctx, field) as ts.TypeReferenceNode;
	const result = ctx.fresh("result");
	out.push(ctx.constStatement(result, f.createNewExpression(f.createIdentifier("Set"), typeNode.typeArguments, [])));
	for (let byteIndex = 0; byteIndex * 8 < field.members.length; byteIndex++) {
		const bits = ctx.fresh("bits");
		out.push(ctx.constStatement(bits, ctx.bufferCall("readu8", [buf, ctx.offsetFrom(pos, byteIndex)])));
		field.members.slice(byteIndex * 8, byteIndex * 8 + 8).forEach((member, bitIndex) => {
			out.push(
				f.createIfStatement(
					f.createBinaryExpression(
						f.createParenthesizedExpression(
							f.createBinaryExpression(bits, syntax.AmpersandToken, ctx.num(1 << bitIndex)),
						),
						syntax.ExclamationEqualsEqualsToken,
						ctx.num(0),
					),
					f.createExpressionStatement(
						f.createCallExpression(f.createPropertyAccessExpression(result, "add"), undefined, [
							ctx.literalValueExpr(member),
						]),
					),
				),
			);
		});
	}
	return result;
}

function readDatatype(ctx: EmitContext, name: string, out: ts.Statement[]): ts.Expression {
	const f = ctx.factory;
	const { components, factoryMethod } = FIXED_DATATYPES[name];
	const size = components.reduce((total, component) => total + WIDTH_BYTES[component.width], 0);
	const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", size);
	out.push(...statements);
	let offset = 0;
	const args = components.map((component) => {
		const read = ctx.bufferCall(`read${component.width}`, [buf, ctx.offsetFrom(pos, offset)]);
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

function enumFromIndexExpr(
	ctx: EmitContext,
	enumName: string,
	members: ReadonlyArray<string>,
	idx: ts.Expression,
): ts.Expression {
	const { itemsName } = ctx.ensureEnumTable(enumName, members);
	return ctx.factory.createElementAccessExpression(ctx.factory.createIdentifier(itemsName), idx);
}

function literalFromIndexExpr(
	ctx: EmitContext,
	values: ReadonlyArray<string | number | boolean | undefined>,
	idx: ts.Expression,
): ts.Expression {
	const f = ctx.factory;
	const last = values[values.length - 1];
	let expr: ts.Expression = last === undefined ? f.createIdentifier("undefined") : ctx.literalValueExpr(last);
	for (let i = values.length - 2; i >= 0; i--) {
		const v = values[i];
		const branchExpr = v === undefined ? f.createIdentifier("undefined") : ctx.literalValueExpr(v);
		expr = f.createConditionalExpression(
			f.createBinaryExpression(idx, ctx.ts_.SyntaxKind.EqualsEqualsEqualsToken, ctx.num(i)),
			undefined,
			branchExpr,
			undefined,
			expr,
		);
	}
	return expr;
}

function readDict(ctx: EmitContext, field: Extract<Field, { kind: "dict" }>, out: ts.Statement[]): ts.Expression {
	const f = ctx.factory;
	const isSet = field.value === undefined;
	const countWidth = lengthWidth(field.length);
	const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", WIDTH_BYTES[countWidth]);
	out.push(...statements);
	const count = ctx.fresh("count");
	out.push(ctx.constStatement(count, ctx.readNumberAt(countWidth, buf, pos)));
	checkEntryCount(ctx, count, field, out);
	const result = ctx.fresh("result");
	// Reconstructed as a `Map` or `Set` whatever `field.source` is, because
	// neither constrains its key: a `Record` rejects a datatype, enum or object
	// key, and a `Record` of a literal union rejects the empty table it would
	// start from. roblox-ts compiles `new Map()` to `{}` and a `set` or `add`
	// statement to one assignment, so the Luau is the same plain table. A
	// `Record` is cast to at the end, once the entries are in.
	const keyType = fieldToTypeNode(ctx, field.key);
	out.push(
		ctx.constStatement(
			result,
			f.createNewExpression(
				f.createIdentifier(isSet ? "Set" : "Map"),
				isSet ? [keyType] : [keyType, fieldToTypeNode(ctx, field.value!)],
				[],
			),
		),
	);
	const i = ctx.fresh("_i");
	const body: ts.Statement[] = [];
	const keyExpr = readField(ctx, field.key, body);
	const entry = isSet ? [keyExpr] : [keyExpr, readField(ctx, field.value!, body)];
	body.push(
		f.createExpressionStatement(
			f.createCallExpression(f.createPropertyAccessExpression(result, isSet ? "add" : "set"), undefined, entry),
		),
	);
	out.push(ctx.countedLoop(i, count, body));
	if (field.source !== "record") {
		return result;
	}
	return f.createAsExpression(
		f.createAsExpression(result, f.createKeywordTypeNode(ctx.ts_.SyntaxKind.UnknownKeyword)),
		fieldToTypeNode(ctx, field),
	);
}

function readObject(ctx: EmitContext, field: Extract<Field, { kind: "object" }>, out: ts.Statement[]): ts.Expression {
	if (field.helperName) {
		ctx.ensureHelper(field.helperName);
		return ctx.bindSideEffect(ctx.callLocal(`${field.helperName}_read`, []), out);
	}
	return readObjectInline(ctx, field.fields, out);
}

function readOptional(
	ctx: EmitContext,
	field: Extract<Field, { kind: "optional" }>,
	out: ts.Statement[],
	// The presence bit of the enclosing object's packed region, or `undefined` to read a flag byte.
	packedPresent: ts.Expression | undefined,
): ts.Expression {
	const f = ctx.factory;
	let present = packedPresent;
	if (present === undefined) {
		const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", 1);
		out.push(...statements);
		const flag = ctx.fresh("present");
		out.push(
			ctx.constStatement(
				flag,
				f.createBinaryExpression(
					ctx.bufferCall("readu8", [buf, pos]),
					ctx.ts_.SyntaxKind.ExclamationEqualsEqualsToken,
					ctx.num(0),
				),
			),
		);
		present = flag;
	}
	const result = ctx.fresh("opt");
	out.push(
		f.createVariableStatement(
			undefined,
			f.createVariableDeclarationList([f.createVariableDeclaration(result)], ctx.ts_.NodeFlags.Let),
		),
	);
	const innerStatements: ts.Statement[] = [];
	const innerExpr = readField(ctx, field.inner, innerStatements);
	innerStatements.push(
		f.createExpressionStatement(f.createBinaryExpression(result, ctx.ts_.SyntaxKind.EqualsToken, innerExpr)),
	);
	out.push(f.createIfStatement(present, f.createBlock(innerStatements, true)));
	return result;
}

export function readObjectInline(
	ctx: EmitContext,
	fields: ReadonlyArray<ObjectFieldEntry>,
	out: ts.Statement[],
	// A tagged union variant's discriminant, which belongs in the literal
	// this builds rather than being spread in afterwards: roblox-ts lowers
	// `{ ...obj, tag: "x" }` to `table.clone` plus `setmetatable(_, nil)`
	// plus one assignment, so a spread costs a table copy per read.
	tag?: { readonly key: FieldKey; readonly value: string | number | boolean },
): ts.Expression {
	const f = ctx.factory;
	// The packed region is read first and outside the scoped items: every
	// item that follows, in any block, can need one of its bits.
	const bits = packedBits(fields);
	const bitExprs = new Map<
		ObjectFieldEntry,
		{ present?: ts.Expression; value?: ts.Expression; tag?: ts.Expression }
	>();
	if (bits.length > 0) {
		const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", Math.ceil(bits.length / 8));
		out.push(...statements);
		bits.forEach(({ entry, role }, i) => {
			const exprs = bitExprs.get(entry) ?? {};
			exprs[role] = ctx.call("unpackBit", [buf, pos, ctx.num(i)]);
			bitExprs.set(entry, exprs);
		});
	}
	// Each item's expressions refer to the locals its statements declare.
	const items: Array<ScopedItem & { readonly props: Array<{ entry: ObjectFieldEntry; expr: ts.Expression }> }> = [];
	// An entry the packed region answers reads no bytes of its own, so it
	// cannot share a reservation; the others may, on the same terms as
	// the write side.
	const shareable = (entry: ObjectFieldEntry) => !bitExprs.has(entry) && fixedBytes(entry.field) !== undefined;
	for (const group of allocRuns(fields, shareable)) {
		if (group.length > 1) {
			const total = group.reduce((sum, entry) => sum + fixedBytes(entry.field)!, 0);
			const props: Array<{ entry: ObjectFieldEntry; expr: ts.Expression }> = [];
			const item = ctx.measure((itemOut) => {
				ctx.withAllocRun("readAlloc", total, () => {
					for (const entry of group) {
						props.push({ entry, expr: readField(ctx, entry.field, itemOut) });
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
		const item = ctx.measure((itemOut) => {
			if (entryBits?.tag && field.kind === "taggedUnion") {
				expr = readTaggedUnion(ctx, field, itemOut, entryBits.tag);
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
				expr = readOptional(ctx, field, itemOut, entryBits.present);
			} else {
				expr = readField(ctx, field, itemOut);
			}
		});
		items.push({ ...item, props: [{ entry, expr }] });
	}
	if (!ctx.needsBlocks()) {
		ctx.pushScoped(items, out);
		// The tag first, matching the variant order in `fieldToTypeNode`.
		const properties: ts.ObjectLiteralElementLike[] = tag
			? [f.createPropertyAssignment(ctx.propertyName(tag.key), ctx.literalValueExpr(tag.value))]
			: [];
		for (const item of items) {
			for (const { entry, expr } of item.props) {
				properties.push(f.createPropertyAssignment(ctx.propertyName(entry), expr));
			}
		}
		return f.createObjectLiteralExpression(properties, true);
	}
	// A block's locals end with the block, so an object literal after the
	// blocks can't refer to them: each block assigns its own fields into
	// `result` instead.
	const result = ctx.fresh("result");
	out.push(
		ctx.constStatement(
			result,
			ctx.castTo(f.createObjectLiteralExpression([]), objectShapeTypeNode(ctx, fields, tag)),
		),
	);
	if (tag) {
		out.push(
			f.createExpressionStatement(
				f.createBinaryExpression(
					ctx.propertyAccess(result, tag.key),
					ctx.ts_.SyntaxKind.EqualsToken,
					ctx.literalValueExpr(tag.value),
				),
			),
		);
	}
	for (const item of items) {
		for (const { entry, expr } of item.props) {
			item.statements.push(
				f.createExpressionStatement(
					f.createBinaryExpression(ctx.propertyAccess(result, entry), ctx.ts_.SyntaxKind.EqualsToken, expr),
				),
			);
		}
	}
	ctx.pushScoped(items, out);
	return result;
}

function readTaggedUnion(
	ctx: EmitContext,
	field: Extract<Field, { kind: "taggedUnion" }>,
	out: ts.Statement[],
	// The tag bit of the enclosing object's packed region, or `undefined` to read an index.
	packedTag?: ts.Expression,
): ts.Expression {
	const f = ctx.factory;
	let idx: ts.Identifier;
	if (packedTag) {
		idx = ctx.fresh("idx");
		out.push(
			ctx.constStatement(
				idx,
				f.createConditionalExpression(packedTag, undefined, ctx.num(1), undefined, ctx.num(0)),
			),
		);
	} else {
		const idxBytes = field.variants.length <= 256 ? 1 : 2;
		const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", idxBytes);
		out.push(...statements);
		idx = ctx.fresh("idx");
		out.push(ctx.constStatement(idx, ctx.bufferCall(idxBytes === 1 ? "readu8" : "readu16", [buf, pos])));
	}
	const result = ctx.fresh("result");
	out.push(
		f.createVariableStatement(
			undefined,
			f.createVariableDeclarationList(
				[f.createVariableDeclaration(result, undefined, fieldToTypeNode(ctx, field))],
				ctx.ts_.NodeFlags.Let,
			),
		),
	);

	const branchFor = (i: number): ts.Statement[] => {
		const variant = field.variants[i];
		const branch: ts.Statement[] = [];
		const objExpr = readObjectInline(ctx, variant.fields, branch, {
			key: tagKeyOf(field),
			value: variant.tagValue,
		});
		branch.push(
			f.createExpressionStatement(f.createBinaryExpression(result, ctx.ts_.SyntaxKind.EqualsToken, objExpr)),
		);
		return branch;
	};
	// Built with variant 0 as an unconditional `else` (not `else if (idx
	// === 0)`), so TypeScript's definite-assignment analysis sees `result`
	// as assigned on every path -- it has no way to know our own index
	// values are exhaustive otherwise.
	let chain: ts.Statement = f.createBlock(branchFor(0), true);
	for (let i = 1; i < field.variants.length; i++) {
		const cond = f.createBinaryExpression(idx, ctx.ts_.SyntaxKind.EqualsEqualsEqualsToken, ctx.num(i));
		chain = f.createIfStatement(cond, f.createBlock(branchFor(i), true), chain);
	}
	out.push(chain);
	return result;
}

function readGuardedUnion(
	ctx: EmitContext,
	field: Extract<Field, { kind: "guardedUnion" }>,
	out: ts.Statement[],
): ts.Expression {
	const f = ctx.factory;
	const idxBytes = field.variants.length <= 256 ? 1 : 2;
	const { buf, pos, statements } = ctx.destructureAlloc("readAlloc", idxBytes);
	out.push(...statements);
	const idx = ctx.fresh("idx");
	out.push(ctx.constStatement(idx, ctx.bufferCall(idxBytes === 1 ? "readu8" : "readu16", [buf, pos])));
	const result = ctx.fresh("result");
	out.push(
		f.createVariableStatement(
			undefined,
			f.createVariableDeclarationList(
				[f.createVariableDeclaration(result, undefined, fieldToTypeNode(ctx, field))],
				ctx.ts_.NodeFlags.Let,
			),
		),
	);

	const branchFor = (i: number): ts.Statement[] => {
		const branch: ts.Statement[] = [];
		const expr = readField(ctx, field.variants[i], branch);
		branch.push(
			f.createExpressionStatement(f.createBinaryExpression(result, ctx.ts_.SyntaxKind.EqualsToken, expr)),
		);
		return branch;
	};
	let chain: ts.Statement = f.createBlock(branchFor(0), true);
	for (let i = 1; i < field.variants.length; i++) {
		const cond = f.createBinaryExpression(idx, ctx.ts_.SyntaxKind.EqualsEqualsEqualsToken, ctx.num(i));
		chain = f.createIfStatement(cond, f.createBlock(branchFor(i), true), chain);
	}
	out.push(chain);
	return result;
}
