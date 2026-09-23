/** The fixed numbers and injected names the emitter's modules share. */
import type { ComponentWidths, NumWidth } from "../field";
import { DEFAULT_COMPONENT_WIDTH } from "../field";

/** What a `vector3`'s or a `cframe` position's absent widths mean. */
export const DEFAULT_COMPONENTS: ComponentWidths = [
	DEFAULT_COMPONENT_WIDTH,
	DEFAULT_COMPONENT_WIDTH,
	DEFAULT_COMPONENT_WIDTH,
];

export const WIDTH_BYTES: Record<NumWidth, number> = {
	f32: 4,
	f64: 8,
	u8: 1,
	u16: 2,
	u24: 3,
	u32: 4,
	i8: 1,
	i16: 2,
	i24: 3,
	i32: 4,
};

// Luau allows 200 registers per function, and every local the emitter
// declares holds one until its scope ends (confirmed with Lune's
// `luau.compile`: 100 `const [buf, pos] = alloc(n)` pairs in one function
// fail with "Out of local registers"). Past `LOCALS_BUDGET` live locals the
// emitter wraps runs of at most `LOCALS_PER_BLOCK` locals in a block, which
// roblox-ts compiles to `do ... end`; Luau frees a block's registers at its
// `end`. The budget leaves the rest of the 200 to parameters, loop state,
// expression temporaries, and the temporaries roblox-ts adds itself.
export const LOCALS_BUDGET = 120;
export const LOCALS_PER_BLOCK = 32;
// A run of K fields declares K locals: the position the reservation took, then
// one more for each field after the first. `pushScoped` cannot split a run,
// because every field after the first reads the reservation's locals, so a run
// has to fit in the block `pushScoped` would give it. The bound is one field
// short of the block, which is one more than a run now needs.
export const ALLOC_RUN_FIELDS = LOCALS_PER_BLOCK - 1;

// The injected `@rbxts/surge` imports are aliased so that a user's own
// `grow` (or any other export's name), at the top level or in a scope
// enclosing the call site, can neither collide with nor shadow them.
export function importAlias(name: string): string {
	return `__surge_${name}`;
}

// The cursor state, declared in the closure each serializer is emitted into
// rather than owned by `@rbxts/surge`. A reservation is then a compare and two
// moves here instead of a call into another module, which is the whole of the
// cost on a shape with one field per element (Transformer Design §4 in
// transformer.md). They carry the import prefix for the same reason the
// aliases do: nothing a user wrote can collide with them.
export const SCRATCH = importAlias("scratch");
export const CAPACITY = importAlias("capacity");
export const CURSOR = importAlias("cursor");
export const READ_BUFFER = importAlias("input");
export const READ_CURSOR = importAlias("readCursor");
export const READ_LENGTH = importAlias("inputLength");
/** What a serializer starts with, doubled by `grow` from there. */
export const INITIAL_CAPACITY = 64;
/** The largest form `writePackedCFrame` can write: header, position, rotation. */
export const PACKED_CFRAME_MAX_BYTES = 25;
// A `cframe`'s rotation is always an f32 axis-angle triple. `DataType.Transform`
// sets the widths of the position, and of nothing else.
export const ROTATION_BYTES = 12;
/** The prefix every check's message carries, so one `pcall` can tell a rejection from a bug. */
export const ERROR_PREFIX = "@rbxts/surge: ";
/**
 * The largest count `checks` accepts for an element that consumes no bytes
 * (a literal constant, a blob, an object made only of those). Such an element
 * costs nothing, so the payload's own length cannot bound it and the count
 * needs a bound of its own. This is the largest count a `u24` prefix could
 * have written: a shape that means to carry more than sixteen million absent
 * or constant elements says so with a wider `DataType.Length`.
 */
export const ZERO_SIZE_COUNT_CAP = 1 << 24;
