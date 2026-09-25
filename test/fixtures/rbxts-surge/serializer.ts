/**
 * Fixture mirror of @rbxts/surge's src/serializer.ts (see data-type.ts in
 * this directory for why this can't be a real cross-repo dependency). Only
 * the declarations `detect.ts`/`index.ts` need to identify are reproduced;
 * the bodies are never called. `Serialized<T>` and the types it is built from
 * are copied exactly, because `declaredSerializedCarriesBlobs` reads what it
 * resolves to; update them alongside the real file.
 */
type EncodedRobloxType =
	| Vector2
	| Vector3
	| CFrame
	| Color3
	| ColorSequence
	| NumberSequence
	| Vector3int16
	| UDim
	| UDim2
	| BrickColor
	| NumberRange
	| Rect
	| DateTime
	| EnumItem;

type FieldKey<T> = Exclude<keyof T, `_surge_${string}`>;

type ExtraKeys<T> = EncodedRobloxType extends infer R
	? R extends unknown
		? T extends R
			? Exclude<FieldKey<T>, keyof R>
			: never
		: never
	: never;

type Same<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

type Includes<Seen extends unknown[], T> = Seen extends [infer Head, ...infer Rest]
	? Same<Head, T> extends true
		? true
		: Includes<Rest, T>
	: false;

type MayCarryBlobs<T, Seen extends unknown[] = []> = 0 extends 1 & T
	? true
	: unknown extends T
		? true
		: true extends (T extends unknown ? PartCarriesBlobs<T, Seen> : never)
			? true
			: false;

type PartCarriesBlobs<T, Seen extends unknown[]> = T extends string | number | boolean | undefined | void | buffer
	? false
	: T extends EncodedRobloxType
		? [ExtraKeys<T>] extends [never]
			? false
			: true
		: Includes<Seen, T> extends true
			? false
			: T extends ReadonlyArray<infer E>
				? MayCarryBlobs<E, [...Seen, T]>
				: T extends ReadonlyMap<infer K, infer V>
					? MayCarryBlobs<K | V, [...Seen, T]>
					: T extends ReadonlySet<infer E>
						? MayCarryBlobs<E, [...Seen, T]>
						: [Extract<keyof T, `_nominal_${string}`>] extends [never]
							? [FieldKey<T>] extends [never]
								? true
								: true extends { [K in FieldKey<T>]: MayCarryBlobs<T[K], [...Seen, T]> }[FieldKey<T>]
									? true
									: false
							: true;

export type Serialized<T> = MayCarryBlobs<T> extends true ? { buffer: buffer; blobs: Array<defined> } : buffer;

export type Serializer<in out T> = (value: T) => Serialized<T>;

export type Deserializer<in out T> = (input: Serialized<T>) => T;

export interface Codec<in out T> {
	serialize: Serializer<T>;
	deserialize: Deserializer<T>;
}

function notConfigured(): never {
	throw "fixture @rbxts/surge: createCodec/createSerializer/createDeserializer have no real implementation.";
}

export interface CodecOptions {
	readonly readChecks?: boolean;
	readonly writeChecks?: boolean;
}

export function createCodec<T>(options?: CodecOptions): Codec<T> {
	return notConfigured();
}

export function createSerializer<T>(options?: Pick<CodecOptions, "writeChecks">): Serializer<T> {
	return notConfigured();
}

export function createDeserializer<T>(options?: Pick<CodecOptions, "readChecks">): Deserializer<T> {
	return notConfigured();
}
