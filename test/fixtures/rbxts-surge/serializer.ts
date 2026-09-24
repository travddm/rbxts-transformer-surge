/**
 * Fixture mirror of @rbxts/surge's src/serializer.ts (see data-type.ts in
 * this directory for why this can't be a real cross-repo dependency). Only
 * the declarations `detect.ts`/`index.ts` need to identify are reproduced;
 * the bodies are never called.
 */
export interface Serializer<T> {
	serialize: (value: T) => { buffer: buffer; blobs: Array<defined> };
	deserialize: (input: buffer, inputBlobs?: Array<defined>) => T;
}

function notConfigured(): never {
	throw "fixture @rbxts/surge: createSerializer/createDeserializer/createBinarySerializer have no real implementation.";
}

export interface SerializerOptions {
	readonly checks?: boolean;
	readonly writeChecks?: boolean;
}

export function createSerializer<T>(
	options?: Pick<SerializerOptions, "writeChecks">,
): (value: T) => { buffer: buffer; blobs: Array<defined> } {
	return notConfigured();
}

export function createDeserializer<T>(
	options?: Pick<SerializerOptions, "checks">,
): (input: buffer, inputBlobs?: Array<defined>) => T {
	return notConfigured();
}

export function createBinarySerializer<T>(options?: SerializerOptions): Serializer<T> {
	return notConfigured();
}
