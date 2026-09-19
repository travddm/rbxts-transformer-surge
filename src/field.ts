/**
 * The internal IR every `createSerializer`/`createDeserializer`/
 * `createBinarySerializer` call site is walked into (see Transformer Design
 * §2 in docs/transformer.md), and the only input the emitter (`emit.ts`)
 * consumes. Producing this from a `ts.Type` is `walk.ts`'s job; turning it
 * into statements is the emitter's.
 */
export type NumWidth = "f32" | "f64" | "u8" | "u16" | "u32" | "i8" | "i16" | "i32";

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
	| { readonly kind: "str" }
	| { readonly kind: "vector2" }
	| { readonly kind: "vector3" }
	| { readonly kind: "cframe" }
	| { readonly kind: "color3" }
	| { readonly kind: "colorSequence" }
	| { readonly kind: "numberSequence" }
	| { readonly kind: "enum"; readonly enumName: string; readonly members: ReadonlyArray<string> }
	| { readonly kind: "object"; readonly fields: ReadonlyArray<ObjectFieldEntry>; readonly helperName?: string }
	| { readonly kind: "array"; readonly element: Field }
	| { readonly kind: "tuple"; readonly fixed: ReadonlyArray<Field>; readonly rest: Field | undefined }
	// `value` is `undefined` for a Set: only the key is written, and the read
	// side reconstructs the table by setting each read key to `true`. `source`
	// doesn't affect the byte encoding (identical for all three -- see Type
	// Coverage in transformer.md) but does affect what the read side casts
	// the reconstructed table's TypeScript type to, so a `Record` comes back
	// as a `Record` (plain bracket access) rather than a non-functional `Map`.
	| {
			readonly kind: "dict";
			readonly key: Field;
			readonly value: Field | undefined;
			readonly source: "map" | "set" | "record";
	  }
	| { readonly kind: "optional"; readonly inner: Field; readonly packed: boolean }
	| { readonly kind: "literalConst"; readonly value: string | number | boolean }
	| { readonly kind: "literal"; readonly values: ReadonlyArray<string | number | boolean> }
	| {
			readonly kind: "taggedUnion";
			readonly tagKey: string;
			readonly tagKeyNumeric?: boolean;
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
