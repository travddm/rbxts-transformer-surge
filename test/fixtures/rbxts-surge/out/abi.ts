// The signatures of the real `@rbxts/surge/out/abi`, the helpers generated
// code calls, so a test can type-check transformed output the way roblox-ts
// does. Declarations only: nothing here runs.
//
// Reserving bytes is not among them: a generated serializer keeps its own
// buffer and cursors and does that inline, so the only write-side exports left
// are the two cold ones.
export declare function grow(current: buffer, live: number, needed: number): buffer;
export declare function finishWrite(written: buffer, size: number): buffer;
export declare function beginWriteBlobs(): void;
export declare function pushBlob(value: defined): void;
export declare function finishWriteBlobs(): Array<defined>;
export declare function beginReadBlobs(blobs: Array<defined> | undefined): void;
export declare function nextBlob(): defined;
export declare function writePackedCFrame(buf: buffer, pos: number, value: CFrame): number;
export declare function readPackedCFrame(buf: buffer, pos: number): LuaTuple<[value: CFrame, size: number]>;
export declare function unpackBit(buf: buffer, byteOffset: number, bitIndex: number): boolean;
