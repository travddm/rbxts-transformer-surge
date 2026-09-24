/**
 * What a `Field` costs and how it is laid out, read off the IR alone.
 * Nothing here emits or touches emitter state, so both sides answer the
 * same question the same way.
 */
import { FIXED_DATATYPES } from "../datatypes";
import type { ComponentWidths, CountSpec, Field, FieldKey, LengthWidth, ObjectFieldEntry } from "../field";
import { DEFAULT_LENGTH_WIDTH } from "../field";
import { ALLOC_RUN_FIELDS, DEFAULT_COMPONENTS, ROTATION_BYTES, WIDTH_BYTES } from "./constants";

export function tagKeyOf(field: Extract<Field, { kind: "taggedUnion" }>): FieldKey {
	return { name: field.tagKey, numericKey: field.tagKeyNumeric };
}

export interface PackedBit {
	readonly entry: ObjectFieldEntry;
	/** `present`: whether an optional has a value. `value`: a boolean. `tag`: which of a tagged union's two variants. */
	readonly role: "present" | "value" | "tag";
}

/**
 * The width of the count a variable-length kind writes ahead of its
 * contents. Absent means `u32`, which is what all five of them wrote
 * before `DataType.Length<T, L>` existed, so an unbranded shape's bytes
 * do not move (see field.ts).
 */
export function lengthWidth(length: CountSpec | undefined): LengthWidth {
	return typeof length === "number" ? DEFAULT_LENGTH_WIDTH : (length ?? DEFAULT_LENGTH_WIDTH);
}

/**
 * The element or byte count of the exact form, where no count is written
 * at all and both sides use this number, or `undefined` for the counted
 * form. The value has to have exactly this many: a longer one is
 * truncated, and what a shorter one writes depends on its element type
 * (Wire format 6.3, 6.6 and 6.7 in docs/specs/wire-format.md in the surge
 * repo). The type states the length, and only `writeChecks` checks it
 * (Runtime API 3.10 in docs/specs/runtime-api.md in the surge repo).
 */
export function exactCount(length: CountSpec | undefined): number | undefined {
	return typeof length === "number" ? length : undefined;
}

/** The bytes a count of its own costs: none in the exact form, which writes no count. */
function countBytes(length: CountSpec | undefined): number {
	return exactCount(length) === undefined ? WIDTH_BYTES[lengthWidth(length)] : 0;
}

/** The widths a `vector3`'s or a `cframe` position's components are stored at, with absence resolved. */
export function componentsOf(widths?: ComponentWidths): ComponentWidths {
	return widths ?? DEFAULT_COMPONENTS;
}

export function componentBytes(widths?: ComponentWidths): number {
	return componentsOf(widths).reduce((total, width) => total + WIDTH_BYTES[width], 0);
}

/**
 * A lower bound on the bytes `field` reads, used to reject a count no
 * payload of this length could hold. It must never overstate: a bound above
 * what a valid value actually costs would reject that value. Anything whose
 * cost depends on the payload contributes what it cannot avoid writing --
 * a container its count, an optional nothing, a blob nothing -- and a
 * recursive reference contributes nothing at all.
 */
export function minBytes(field: Field): number {
	switch (field.kind) {
		case "num":
			return WIDTH_BYTES[field.width];
		case "bool":
			return field.packed ? 0 : 1;
		case "vector2":
			return 8;
		case "vector3":
			return componentBytes(field.components);
		case "color3":
			return 3;
		case "cframe":
			// The packed form's smallest value is its header alone.
			return field.packed ? 1 : componentBytes(field.position) + ROTATION_BYTES;
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
			return countBytes(field.length);
		case "tuple":
			return (
				field.fixed.reduce((total, element) => total + minBytes(element), 0) +
				(field.rest === undefined ? 0 : countBytes(field.length))
			);
		case "object":
			// The packed region is left out rather than counted: it is bytes a
			// valid value does read, so leaving it out only lowers the bound.
			// An object whose fields are all packed therefore bounds at zero and
			// falls to the cap, which rejects the same payloads a byte at a time
			// later. Counting the region would be tighter and is not worth the
			// risk of counting it differently from the emitter.
			return field.fields.reduce((total, entry) => total + minBytes(entry.field), 0);
		case "taggedUnion":
			// The tag is an index of the same width a `literal` uses, except
			// where the enclosing object's packed region holds it as one bit --
			// which only a direct property of such an object does, so a packed
			// two-variant union elsewhere still reads a byte this leaves out.
			return (
				(field.packed === true && field.variants.length === 2 ? 0 : field.variants.length <= 256 ? 1 : 2) +
				Math.min(
					...field.variants.map((variant) =>
						variant.fields.reduce((total, entry) => total + minBytes(entry.field), 0),
					),
				)
			);
		case "guardedUnion":
			return 1 + Math.min(...field.variants.map((variant) => minBytes(variant)));
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
export function fixedBytes(field: Field): number | undefined {
	switch (field.kind) {
		case "num":
			return WIDTH_BYTES[field.width];
		case "bool":
			return 1;
		case "vector2":
			return 8;
		case "vector3":
			return componentBytes(field.components);
		case "color3":
			return 3;
		case "cframe":
			return field.packed ? undefined : componentBytes(field.position) + ROTATION_BYTES;
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
export function allocRuns<T>(entries: ReadonlyArray<T>, shareable: (entry: T) => boolean): Array<Array<T>> {
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
 * The bits of an object's packed region, in wire order. Both sides build
 * the region from this one list, so the bit order cannot differ between
 * them. A packed `boolean` is one value bit. A packed `optional` is one
 * presence bit, and an optional packed `boolean` is a presence bit and a
 * value bit with no bytes of its own. A packed tagged union with two
 * variants is one tag bit, set for the second variant.
 */
export function packedBits(fields: ReadonlyArray<ObjectFieldEntry>): PackedBit[] {
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
export function isAllPackedBits(field: Field): boolean {
	if (field.kind === "bool") {
		return field.packed;
	}
	return field.kind === "optional" && field.packed && field.inner.kind === "bool" && field.inner.packed;
}
