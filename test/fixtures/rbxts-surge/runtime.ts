// The signatures of the real `@rbxts/surge` runtime exports that generated
// code calls, so a test can type-check transformed output the way roblox-ts
// does. Declarations only: nothing here runs.
export declare function alloc(size: number): LuaTuple<[buf: buffer, offset: number]>;
export declare function readAlloc(size: number): LuaTuple<[buf: buffer, offset: number]>;
export declare function backpatchU32(offset: number, value: number): void;
export declare function beginWrite(): void;
export declare function finishWrite(): buffer;
export declare function beginRead(inputBuffer: buffer): void;
export declare function beginWriteBlobs(): void;
export declare function pushBlob(value: defined): void;
export declare function finishWriteBlobs(): Array<defined>;
export declare function beginReadBlobs(blobs: Array<defined> | undefined): void;
export declare function nextBlob(): defined;
export declare function writePackedCFrame(value: CFrame): void;
export declare function readPackedCFrame(): CFrame;
export declare function packBit(buf: buffer, byteOffset: number, bitIndex: number, value: boolean): void;
export declare function unpackBit(buf: buffer, byteOffset: number, bitIndex: number): boolean;
