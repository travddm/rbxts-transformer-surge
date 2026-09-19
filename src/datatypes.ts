import type { NumWidth } from "./field";

export interface DatatypeSpec {
	/** The property paths read on the write side, in wire order, and the width each one is stored at. */
	readonly components: ReadonlyArray<{ readonly path: ReadonlyArray<string>; readonly width: NumWidth }>;
	/** The static method that rebuilds the value from its components. `new Name(...)` when absent. */
	readonly factoryMethod?: string;
}

/**
 * Roblox datatypes whose value is a fixed list of numbers, and that a
 * constructor rebuilds from that list. The key is the type's name in
 * `@rbxts/types`, which is also its `typeIs` tag and its global constructor.
 * One table row is the whole encoding, so these share the `datatype` field
 * kind instead of each adding a kind to every switch in the emitter.
 */
export const FIXED_DATATYPES: Readonly<Record<string, DatatypeSpec>> = {
	Vector3int16: {
		components: [
			{ path: ["X"], width: "i16" },
			{ path: ["Y"], width: "i16" },
			{ path: ["Z"], width: "i16" },
		],
	},
	UDim: {
		components: [
			{ path: ["Scale"], width: "f32" },
			{ path: ["Offset"], width: "i32" },
		],
	},
	UDim2: {
		components: [
			{ path: ["X", "Scale"], width: "f32" },
			{ path: ["X", "Offset"], width: "i32" },
			{ path: ["Y", "Scale"], width: "f32" },
			{ path: ["Y", "Offset"], width: "i32" },
		],
	},
	BrickColor: {
		components: [{ path: ["Number"], width: "u16" }],
	},
	NumberRange: {
		components: [
			{ path: ["Min"], width: "f32" },
			{ path: ["Max"], width: "f32" },
		],
	},
};

export function isFixedDatatype(name: string): boolean {
	// Not `in`: that is also true for `toString` and `constructor`.
	return Object.prototype.hasOwnProperty.call(FIXED_DATATYPES, name);
}
