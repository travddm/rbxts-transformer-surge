/**
 * The internal IR every `createSerializer`/`createDeserializer`/
 * `createBinarySerializer` call site is walked into (see section 4 of
 * docs/specs/transformer.md in the surge repo), and the only input the emitter
 * (`emit/`) consumes. Producing this from a `ts.Type` is `walk.ts`'s job; turning it
 * into statements is the emitter's.
 */
export type NumWidth = "f32" | "f64" | "u8" | "u16" | "u24" | "u32" | "i8" | "i16" | "i24" | "i32";

/**
 * The width of the count a variable-length kind writes ahead of its contents,
 * set by `DataType.Length<T, L>` (see data-type-surface.md). Unsigned only: a
 * count is never negative and never fractional.
 *
 * Absent on a field means `u32`, which is what every one of these kinds wrote
 * before the brand existed, so an unbranded shape's bytes do not move.
 */
export type LengthWidth = "u8" | "u16" | "u24" | "u32";
export const LENGTH_WIDTHS: ReadonlySet<string> = new Set<LengthWidth>(["u8", "u16", "u24", "u32"]);
export const DEFAULT_LENGTH_WIDTH: LengthWidth = "u32";

/**
 * How a variable-length kind says how much follows. A `LengthWidth` writes a
 * count of that width ahead of the contents; a number writes no count at all
 * and both sides use exactly that many elements or bytes, which is Blink's
 * and Zap's exact form. Absent is the default width.
 */
export type CountSpec = LengthWidth | number;

/**
 * The widths a `Vector3`'s three components, or a `CFrame`'s position, are
 * stored at, set by `DataType.Vector<X, Y, Z>` and `DataType.Transform<X, Y,
 * Z>` (see data-type-surface.md).
 *
 * Absent on a field means three `f32`s, which is what both wrote before the
 * brands existed, so an unbranded shape's bytes do not move.
 */
export type ComponentWidths = readonly [NumWidth, NumWidth, NumWidth];
export const DEFAULT_COMPONENT_WIDTH: NumWidth = "f32";

export interface FieldKey {
	readonly name: string;
	// `{ 0: T }` and `{ "0": T }` are one property to TypeScript but two
	// different table keys in Luau (`[0]` and `["0"]`), so the emitter must
	// know which form the type declares.
	readonly numericKey?: boolean;
}

export interface ObjectFieldEntry extends FieldKey {
	readonly field: Field;
}

export type Field =
	| { readonly kind: "num"; readonly width: NumWidth }
	| { readonly kind: "bool"; readonly packed: boolean }
	| { readonly kind: "str"; readonly length?: CountSpec }
	| { readonly kind: "vector2" }
	// A Luau `buffer` value: a length, then its bytes.
	| { readonly kind: "buffer"; readonly length?: CountSpec }
	// A row of `FIXED_DATATYPES` in datatypes.ts.
	| { readonly kind: "datatype"; readonly name: string }
	| { readonly kind: "vector3"; readonly components?: ComponentWidths }
	// `packed`: inside `Packed<T>`, where a header byte replaces an axis-aligned
	// rotation and a zero or one position. Absent, not `false`, outside it.
	// `position` is the position's component widths; the rotation is always an
	// f32 axis-angle triple, and the packed form takes no widths at all.
	| { readonly kind: "cframe"; readonly packed?: true; readonly position?: ComponentWidths }
	| { readonly kind: "color3" }
	| { readonly kind: "colorSequence" }
	| { readonly kind: "numberSequence" }
	| { readonly kind: "enum"; readonly enumName: string; readonly members: ReadonlyArray<string> }
	| { readonly kind: "object"; readonly fields: ReadonlyArray<ObjectFieldEntry>; readonly helperName?: string }
	| { readonly kind: "array"; readonly element: Field; readonly length?: CountSpec }
	// `length` describes the rest element's count; the fixed elements are
	// inline and have no count of their own.
	| {
			readonly kind: "tuple";
			readonly fixed: ReadonlyArray<Field>;
			readonly rest: Field | undefined;
			readonly length?: CountSpec;
	  }
	// `value` is `undefined` for a Set: only the key is written, and the read
	// side reconstructs the table by setting each read key to `true`. `source`
	// doesn't affect the byte encoding (identical for all three -- Wire format
	// 5.4 in docs/specs/wire-format.md in the surge repo) but does affect what the read side casts
	// the reconstructed table's TypeScript type to, so a `Record` comes back
	// as a `Record` (plain bracket access) rather than a non-functional `Map`.
	| {
			readonly kind: "dict";
			readonly key: Field;
			readonly value: Field | undefined;
			readonly source: "map" | "set" | "record";
			// Width only, never an exact count: the write side counts entries as
			// it iterates, so it cannot promise a compile-time number, and a
			// mismatch would misread every field after this one rather than just
			// this one. Blink and Zap bound a map the same way, by width.
			readonly length?: LengthWidth;
	  }
	| { readonly kind: "optional"; readonly inner: Field; readonly packed: boolean }
	| { readonly kind: "literalConst"; readonly value: string | number | boolean }
	| { readonly kind: "literal"; readonly values: ReadonlyArray<string | number | boolean> }
	| {
			readonly kind: "taggedUnion";
			readonly tagKey: string;
			readonly tagKeyNumeric?: boolean;
			// Inside `Packed<T>`. With two variants and as a direct property of an
			// object, the tag is one bit of that object's packed region.
			readonly packed?: true;
			readonly variants: ReadonlyArray<{
				readonly tagValue: string | number | boolean;
				readonly fields: ReadonlyArray<ObjectFieldEntry>;
			}>;
	  }
	| { readonly kind: "guardedUnion"; readonly variants: ReadonlyArray<Field> }
	| { readonly kind: "blob" }
	// A self-referential type reappearing on its own walk path -- compiles to
	// a call into a named module-scoped helper instead of infinite inlining
	// (Transformer Design §6).
	| { readonly kind: "recursiveRef"; readonly helperName: string };
