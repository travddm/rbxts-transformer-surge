import type ts from "typescript";

import { isFixedDatatype } from "./datatypes";
import { getDataTypeBrand, getPackedInnerType, isFromTypesPackage, isRobloxNominalType } from "./detect";
import type { Field, FieldKey, NumWidth, ObjectFieldEntry } from "./field";

export interface WalkDiagnostic {
	readonly message: string;
	readonly node: ts.Node;
}

const NUM_BRAND_WIDTHS: ReadonlySet<string> = new Set([
	"f32",
	"f64",
	"u8",
	"u16",
	"u24",
	"u32",
	"i8",
	"i16",
	"i24",
	"i32",
]);
const ROBLOX_SCALAR_KINDS: Readonly<Record<string, Field["kind"]>> = {
	Vector2: "vector2",
	Vector3: "vector3",
	CFrame: "cframe",
	Color3: "color3",
	ColorSequence: "colorSequence",
	NumberSequence: "numberSequence",
	buffer: "buffer",
};

// What `typeIs(value, tag)` reports for each kind that can be a member of a
// guarded union. Two variants with the same tag can't be told apart on the
// write side. `literalConst` is absent because it is guarded by value, and
// `blob` because an opaque value has no tag to check.
const RUNTIME_TYPE_TAGS: Partial<Record<Field["kind"], string>> = {
	num: "number",
	str: "string",
	bool: "boolean",
	object: "table",
	array: "table",
	tuple: "table",
	dict: "table",
	// Only an object type or a union is ever in progress (`tryWalkObject`,
	// `walkUnion`), and a union is never a member of another union.
	recursiveRef: "table",
	vector2: "Vector2",
	vector3: "Vector3",
	cframe: "CFrame",
	color3: "Color3",
	colorSequence: "ColorSequence",
	buffer: "buffer",
	numberSequence: "NumberSequence",
	enum: "EnumItem",
};

function runtimeTypeTag(field: Field): string | undefined {
	// A `datatype` is tagged with its own type name, so two different ones can share a union.
	return field.kind === "datatype" ? field.name : RUNTIME_TYPE_TAGS[field.kind];
}

let helperCounter = 0;
function nextHelperName(base: string): string {
	helperCounter += 1;
	return `surge_${base}_${helperCounter}`;
}

// `type.types`/`type.getProperties()` order reflects the checker's type-id
// or declaration-creation order -- stable for one program, but not across
// two programs that differ only in an unrelated file (Transformer Design §3
// promises field order is a pure function of the type itself). Every place
// that assigns a wire-format index from declaration/creation order must sort
// by value first.
const LITERAL_TYPE_ORDER: Readonly<Record<string, number>> = { boolean: 0, number: 1, string: 2, undefined: 3 };
function compareLiteral(a: string | number | boolean | undefined, b: string | number | boolean | undefined): number {
	const ta = LITERAL_TYPE_ORDER[typeof a];
	const tb = LITERAL_TYPE_ORDER[typeof b];
	if (ta !== tb) {
		return ta - tb;
	}
	if (a === b || a === undefined || b === undefined) {
		return 0;
	}
	return a < b ? -1 : a > b ? 1 : 0;
}

export class TypeWalker {
	// Keyed by (ts.Type, packed), not by symbol: the checker interns every
	// instantiation of a generic declaration (or an anonymous alias body) as
	// its own `ts.Type` object, so `Box<number>` and `Box<string>` are
	// distinct keys even though they share one declaration symbol -- keying
	// by symbol alone would silently collapse them onto whichever
	// instantiation was walked first. The `packed` half of the key is what
	// keeps a type walked once plain and once inside a `Packed<T>` subtree
	// (e.g. a shared `interface` reused as both a plain field and a
	// `Packed<T>` field elsewhere in the same root type) from sharing one
	// cached `Field`, since only one of those two walks bit-packs its
	// boolean fields. `ts.Type` identity works the same way for union types
	// (no symbol of their own) as for object types, so this one set of maps
	// also backs the union recursion guard in `walkUnion`.
	private readonly resolved = new Map<ts.Type, Map<boolean, Field>>();
	private readonly inProgress = new Set<ts.Type>();
	private readonly helperNames = new Map<ts.Type, Map<boolean, string>>();
	public readonly diagnostics: WalkDiagnostic[] = [];

	public constructor(
		private readonly typescript: typeof ts,
		private readonly checker: ts.TypeChecker,
	) {}

	private report(message: string, node: ts.Node): void {
		this.diagnostics.push({ message, node });
	}

	private getResolved(type: ts.Type, packed: boolean): Field | undefined {
		return this.resolved.get(type)?.get(packed);
	}

	private setResolved(type: ts.Type, packed: boolean, field: Field): void {
		let byPacked = this.resolved.get(type);
		if (!byPacked) {
			byPacked = new Map<boolean, Field>();
			this.resolved.set(type, byPacked);
		}
		byPacked.set(packed, field);
	}

	private getHelperName(type: ts.Type, packed: boolean): string | undefined {
		return this.helperNames.get(type)?.get(packed);
	}

	/** Resolved `Field`s for every type that turned out to be self-referential, keyed by the helper name assigned to it. */
	public getHelperFields(): Map<string, Field> {
		const result = new Map<string, Field>();
		for (const [type, byPacked] of this.helperNames) {
			for (const [packed, name] of byPacked) {
				const resolved = this.getResolved(type, packed);
				if (resolved) {
					result.set(name, resolved);
				}
			}
		}
		return result;
	}

	public walk(type: ts.Type, node: ts.Node, packed: boolean): Field {
		const ts_ = this.typescript;
		const checker = this.checker;

		// `DataType.*` brands and `DataType.Packed<T>` are detected by alias
		// identity (detect.ts), independent of the structural checks below,
		// so they must be checked before anything else can misclassify them
		// (a plain `number & {...}` brand would otherwise just look like
		// `number`).
		const packedInner = getPackedInnerType(checker, type);
		if (packedInner) {
			return this.walk(packedInner, node, true);
		}
		const brand = getDataTypeBrand(type);
		if (brand && NUM_BRAND_WIDTHS.has(brand)) {
			return { kind: "num", width: brand as NumWidth };
		}

		if ((type.flags & ts_.TypeFlags.Union) !== 0) {
			return this.walkUnion(type as ts.UnionType, node, packed);
		}

		// `unknown` and `any` admit `undefined`, and the checker reduces
		// `unknown | undefined` to `unknown`, so `a?: unknown` never reaches
		// `walkUnion`. Without a presence flag an `undefined` value pushes no
		// blob, and every later blob is read one position early.
		if ((type.flags & (ts_.TypeFlags.Unknown | ts_.TypeFlags.Any)) !== 0) {
			return { kind: "optional", inner: { kind: "blob" }, packed };
		}

		if ((type.flags & ts_.TypeFlags.BooleanLiteral) !== 0) {
			const value = checker.typeToString(type) === "true";
			return { kind: "literalConst", value };
		}
		if (type.isStringLiteral() || type.isNumberLiteral()) {
			return { kind: "literalConst", value: type.value };
		}
		if ((type.flags & ts_.TypeFlags.String) !== 0) {
			return { kind: "str" };
		}
		if ((type.flags & ts_.TypeFlags.Number) !== 0) {
			return { kind: "num", width: "f64" };
		}
		if ((type.flags & ts_.TypeFlags.Boolean) !== 0) {
			return { kind: "bool", packed };
		}

		// Identity-based, not a bare name match: a user-declared
		// `interface Vector3 { foo: string }` has `type.symbol.name ===
		// "Vector3"` too, so the scalar-kind table only applies to the real
		// `@rbxts/types` declaration (see blob-classification.md).
		const symbolName = type.symbol?.name;
		if (symbolName && symbolName in ROBLOX_SCALAR_KINDS && isFromTypesPackage(type.symbol?.declarations)) {
			const kind = ROBLOX_SCALAR_KINDS[symbolName];
			return (kind === "cframe" && packed ? { kind, packed } : { kind }) as Field;
		}
		if (symbolName && isFixedDatatype(symbolName) && isFromTypesPackage(type.symbol?.declarations)) {
			return { kind: "datatype", name: symbolName };
		}

		// `@rbxts/types` brands `Instance` (and every subclass) and every
		// Roblox datatype not covered above with its own `_nominal_*`
		// property (fbs and serio both key off the same brand). Routing them
		// to the blob passthrough channel here, before any structural check
		// below can walk their declared properties, is the fix for
		// blob-classification.md: `Instance` has hundreds of properties and
		// `Region3`/`TweenInfo`/etc. have their own, so without this check
		// they never reach the "opaque type" fallback further down.
		if (isRobloxNominalType(type)) {
			return { kind: "blob" };
		}

		// These types carry properties inherited from their apparent type
		// (`String`/`Symbol` prototype members) or none at all, and either
		// way can't be structurally encoded -- reported instead of silently
		// routed to blob so a typo'd type doesn't disappear without a trace.
		if ((type.flags & ts_.TypeFlags.TemplateLiteral) !== 0) {
			this.report(
				`a template literal type can't be structurally encoded -- widen it to "string" or opt into the blob passthrough channel with "unknown".`,
				node,
			);
			return { kind: "blob" };
		}
		if ((type.flags & ts_.TypeFlags.ESSymbolLike) !== 0) {
			this.report(
				`"symbol" can't be structurally encoded -- opt into the blob passthrough channel with "unknown".`,
				node,
			);
			return { kind: "blob" };
		}
		if ((type.flags & ts_.TypeFlags.BigIntLike) !== 0) {
			this.report(
				`"bigint" can't be structurally encoded -- opt into the blob passthrough channel with "unknown".`,
				node,
			);
			return { kind: "blob" };
		}
		if ((type.flags & ts_.TypeFlags.Null) !== 0) {
			this.report(
				`"null" can't be structurally encoded -- opt into the blob passthrough channel with "unknown".`,
				node,
			);
			return { kind: "blob" };
		}
		if (
			checker.getSignaturesOfType(type, ts_.SignatureKind.Call).length > 0 ||
			checker.getSignaturesOfType(type, ts_.SignatureKind.Construct).length > 0
		) {
			this.report(
				`a function type can't be encoded -- it would round-trip as a stale reference in-process at best and be meaningless over a RemoteEvent at worst. Opt into the blob passthrough channel with "unknown" if this is intentional.`,
				node,
			);
			return { kind: "blob" };
		}

		if (this.isEnumItemUnionMember(type)) {
			// A single-member "union" (an enum with exactly one item) reaches
			// here as a plain object type rather than ts_.TypeFlags.Union.
			return this.walkEnum([type], node);
		}

		if (checker.isArrayType(type) || checker.isTupleType(type)) {
			return this.walkArrayOrTuple(type, node, packed);
		}

		if (this.isMapType(type) || this.isSetType(type)) {
			return this.walkMapOrSet(type, node, packed);
		}

		const indexInfos = checker.getIndexInfosOfType(type);
		if (type.getProperties().length > 0 && indexInfos.length > 0) {
			this.report(
				`a type with both declared properties and an index signature isn't supported -- split the index ` +
					`signature into its own "Record"/"Map" field, or opt into the blob passthrough channel with "unknown".`,
				node,
			);
			return { kind: "blob" };
		}

		if (type.getProperties().length > 0 || this.hasNoIndexOrProperties(type)) {
			const objectResult = this.tryWalkObject(type, node, packed);
			if (objectResult) {
				return objectResult;
			}
		}

		if (indexInfos.length > 0) {
			return this.walkIndexSignature(type, indexInfos, node, packed);
		}

		if (type.getProperties().length === 0) {
			// No declared properties and no index signature: an opaque type
			// (`unknown`, `Instance` and subclasses, or anything else this
			// walk doesn't recognize) -- the blob passthrough channel.
			return { kind: "blob" };
		}

		return this.tryWalkObject(type, node, packed) ?? { kind: "blob" };
	}

	/**
	 * The node a diagnostic about `prop`'s type points at: the property's own
	 * declaration when it is in the file being transformed, otherwise `node`
	 * (a declaration in a library's `.d.ts` is not where the user fixes it).
	 */
	private nodeForProperty(prop: ts.Symbol, node: ts.Node): ts.Node {
		const declaration = prop.valueDeclaration ?? prop.declarations?.[0];
		return declaration && declaration.getSourceFile() === node.getSourceFile() ? declaration : node;
	}

	/** `numericKey` is left out, not `false`, for an ordinary name, so the common `Field` stays `{ name, field }`. */
	private keyOf(prop: ts.Symbol): FieldKey {
		return this.isNumericKey(prop) ? { name: prop.name, numericKey: true } : { name: prop.name };
	}

	private isNumericKey(prop: ts.Symbol): boolean {
		const declaredName = (prop.valueDeclaration as ts.NamedDeclaration | undefined)?.name;
		if (declaredName) {
			const nameNode = this.typescript.isComputedPropertyName(declaredName)
				? declaredName.expression
				: declaredName;
			return this.typescript.isNumericLiteral(nameNode);
		}
		// No declared name to inspect (a mapped type such as `Record<0 | 1, T>`).
		return String(Number(prop.name)) === prop.name && Number(prop.name) >= 0;
	}

	private hasNoIndexOrProperties(type: ts.Type): boolean {
		return this.checker.getIndexInfosOfType(type).length === 0;
	}

	// ---- objects --------------------------------------------------------

	private tryWalkObject(type: ts.Type, node: ts.Node, packed: boolean): Field | undefined {
		const properties = type.getProperties();
		if (properties.length === 0) {
			return undefined;
		}
		if (this.inProgress.has(type)) {
			const helperName = this.helperNameFor(type, packed);
			return { kind: "recursiveRef", helperName };
		}
		const cached = this.getResolved(type, packed);
		if (cached) {
			return cached;
		}
		this.inProgress.add(type);

		const names = properties.map((p) => p.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		const fields: ObjectFieldEntry[] = [];
		for (const name of names) {
			const prop = properties.find((p) => p.name === name)!;
			const propType = this.checker.getTypeOfSymbolAtLocation(prop, node);
			fields.push({
				...this.keyOf(prop),
				field: this.walk(propType, this.nodeForProperty(prop, node), packed),
			});
		}

		this.inProgress.delete(type);
		let result: Field = { kind: "object", fields };
		const helperName = this.getHelperName(type, packed);
		if (helperName) {
			result = { kind: "object", fields, helperName };
		}
		this.setResolved(type, packed, result);
		return result;
	}

	/**
	 * The type's own name has no bearing on wire compatibility (only field
	 * order and kinds do), so any name that helps a reader match a helper
	 * back to its source type is fine -- prefer the alias name
	 * (`type X = ...`) over the declaration symbol's name, since an
	 * anonymous alias body's symbol is always `__type`.
	 */
	private helperBaseName(type: ts.Type): string {
		const aliasSymbol = (type as ts.Type & { aliasSymbol?: ts.Symbol }).aliasSymbol;
		return aliasSymbol?.name ?? type.symbol?.name ?? "recursive";
	}

	private helperNameFor(type: ts.Type, packed: boolean): string {
		let byPacked = this.helperNames.get(type);
		if (!byPacked) {
			byPacked = new Map<boolean, string>();
			this.helperNames.set(type, byPacked);
		}
		let name = byPacked.get(packed);
		if (!name) {
			name = nextHelperName(this.helperBaseName(type));
			byPacked.set(packed, name);
		}
		return name;
	}

	// ---- arrays / tuples --------------------------------------------------

	private walkArrayOrTuple(type: ts.Type, node: ts.Node, packed: boolean): Field {
		const checker = this.checker;
		if (checker.isTupleType(type)) {
			const typeArgs = checker.getTypeArguments(type as ts.TypeReference);
			const target = (type as ts.TypeReference).target as ts.TupleType;
			const elementFlags = target.elementFlags;
			const fixed: Field[] = [];
			let rest: Field | undefined;
			for (let i = 0; i < typeArgs.length; i++) {
				const flags = elementFlags[i];
				if ((flags & this.typescript.ElementFlags.Variable) !== 0 && i !== typeArgs.length - 1) {
					this.report(
						`a tuple with a rest element that isn't last (for example "[...number[], string]") isn't ` +
							`supported -- move the rest element to the end.`,
						node,
					);
					return { kind: "blob" };
				}
				const elementField = this.walk(typeArgs[i], node, packed);
				if ((flags & this.typescript.ElementFlags.Rest) !== 0) {
					rest = elementField;
				} else {
					fixed.push(elementField);
				}
			}
			return { kind: "tuple", fixed, rest };
		}
		const elementType = checker.getIndexTypeOfType(type, this.typescript.IndexKind.Number) ?? checker.getAnyType();
		return { kind: "array", element: this.walk(elementType, node, packed) };
	}

	// ---- map / set / record (unified `dict`) -----------------------------

	private isMapType(type: ts.Type): boolean {
		return type.symbol?.name === "Map" || type.symbol?.name === "ReadonlyMap";
	}
	private isSetType(type: ts.Type): boolean {
		return type.symbol?.name === "Set" || type.symbol?.name === "ReadonlySet";
	}

	private walkMapOrSet(type: ts.Type, node: ts.Node, packed: boolean): Field {
		const checker = this.checker;
		const isSet = this.isSetType(type);
		const typeArgs = checker.getTypeArguments(type as ts.TypeReference);
		const keyField = this.walk(typeArgs[0], node, packed);
		const valueField = isSet ? undefined : this.walk(typeArgs[1], node, packed);
		return { kind: "dict", key: keyField, value: valueField, source: isSet ? "set" : "map" };
	}

	private walkIndexSignature(
		type: ts.Type,
		indexInfos: readonly ts.IndexInfo[],
		node: ts.Node,
		packed: boolean,
	): Field {
		// `Record<SomeUnion, V>` (a finite key union, not a true index
		// signature) is intentionally out of scope for this kind -- a finite
		// key union is walked as a fixed-property object instead, above,
		// before this is ever reached.
		const info = indexInfos[0];
		const keyField = this.walk(info.keyType, node, packed);
		const valueField = this.walk(info.type, node, packed);
		return { kind: "dict", key: keyField, value: valueField, source: "record" };
	}

	// ---- enums ------------------------------------------------------------

	private isEnumItemLike(type: ts.Type): boolean {
		// The shape alone also matches a user type with these three
		// properties, which the emitter would then look up under `Enum`.
		if (!isFromTypesPackage(type.symbol?.declarations)) {
			return false;
		}
		const props = type.getProperties();
		const names = new Set(props.map((p) => p.name));
		return names.has("Name") && names.has("Value") && names.has("EnumType");
	}

	/** The symbol of the enum that declares an item (`Enum.SortOrder` for `Enum.SortOrder.Name`). */
	private enumOf(item: ts.Type): ts.Symbol | undefined {
		return (item.symbol as (ts.Symbol & { parent?: ts.Symbol }) | undefined)?.parent;
	}

	private isEnumItemUnionMember(type: ts.Type): boolean {
		return this.isEnumItemLike(type);
	}

	private walkEnum(constituents: ts.Type[], node: ts.Node): Field {
		const checker = this.checker;
		const named: string[] = [];
		for (const constituent of constituents) {
			const nameProp = constituent.getProperty("Name");
			const nameType = nameProp ? checker.getTypeOfSymbolAtLocation(nameProp, node) : undefined;
			if (!nameType || !nameType.isStringLiteral()) {
				// A bare `EnumItem` field (not a specific `Enum.*` type): `Name` is
				// the general `string` type rather than a member's literal name, so
				// there is no member list to index into. Reported instead of
				// classified, since the alternative is `Enum.Enum.EnumItem` on the
				// read side, which errors at runtime (see enum-encoding.md).
				this.report(
					`a bare "EnumItem" field isn't supported -- narrow it to a specific enum type, e.g. "Enum.KeyCode".`,
					node,
				);
				return { kind: "blob" };
			}
			named.push(nameType.value);
		}
		named.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

		// One `enum` field indexes the members of one enum. Items of two enums
		// would all be looked up under the first enum's name, and two items
		// with the same name (`None`) would share an index and read back as
		// the first enum's item.
		const first = constituents[0];
		const parentSymbol = this.enumOf(first);
		const other = constituents.find((constituent) => this.enumOf(constituent) !== parentSymbol);
		if (other) {
			this.report(
				`a union of items from two enums ("${parentSymbol?.name}" and "${this.enumOf(other)?.name}") isn't ` +
					`supported -- use one enum per field, or opt into the blob passthrough channel with "unknown".`,
				node,
			);
			return { kind: "blob" };
		}

		const aliasName = (first as ts.Type & { aliasSymbol?: ts.Symbol }).aliasSymbol?.name;
		const enumName = aliasName ?? parentSymbol?.name ?? "Enum";
		return { kind: "enum", enumName, members: named };
	}

	// ---- unions -------------------------------------------------------

	/**
	 * Recursion through a union (or an alias resolving to one) has no
	 * declaration symbol to key the recursion guard by the way
	 * `tryWalkObject` keys on an object type's symbol -- this guards by the
	 * union's own `ts.Type` identity instead (see the field comment on
	 * `resolved` above), so a discriminated union that reappears on its own
	 * walk path compiles to a helper instead of recursing the walker
	 * forever. Wrapping the whole union walk (not only the table-shaped
	 * branch in `classifyUnion`) costs nothing on the common, non-recursive
	 * cases: they simply never hit the `inProgress`/helper paths.
	 *
	 * Unlike `tryWalkObject`, which can attach `helperName` directly onto its
	 * `object` result (`Field`'s `object` variant has that slot, and
	 * `emit.ts` dispatches on it), no other `Field` kind has anywhere to
	 * carry a helper marker. So here, once a walk this method starts turns
	 * out to need a helper, *every* call site that walk passes through --
	 * including the outermost one, whether that's the root declaration or a
	 * plain, non-recursive-looking field elsewhere -- gets back
	 * `{ kind: "recursiveRef", helperName }` instead of the real structure.
	 * The real structure exists exactly once, in `resolved`, reachable only
	 * through `getHelperFields()` (what `emit.ts`'s `ensureHelper` builds the
	 * helper's body from).
	 */
	private walkUnion(type: ts.UnionType, node: ts.Node, packed: boolean): Field {
		const cached = this.getResolved(type, packed);
		if (cached !== undefined) {
			const helperName = this.getHelperName(type, packed);
			return helperName ? { kind: "recursiveRef", helperName } : cached;
		}
		if (this.inProgress.has(type)) {
			return { kind: "recursiveRef", helperName: this.helperNameFor(type, packed) };
		}
		this.inProgress.add(type);
		const field = this.walkUnionBody(type, node, packed);
		this.inProgress.delete(type);
		this.setResolved(type, packed, field);
		const helperName = this.getHelperName(type, packed);
		return helperName ? { kind: "recursiveRef", helperName } : field;
	}

	private walkUnionBody(type: ts.UnionType, node: ts.Node, packed: boolean): Field {
		const ts_ = this.typescript;
		const checker = this.checker;
		let constituents = [...type.types];

		const hasUndefined = constituents.some((t) => (t.flags & ts_.TypeFlags.Undefined) !== 0);
		const nonUndefined = constituents.filter((t) => ((t.flags & ts_.TypeFlags.Undefined) !== 0) === false);

		// The checker represents the plain `boolean` type itself as the union
		// `true | false` in property-type position (unlike `number`/`string`,
		// which keep their own non-union flags), so it must be special-cased
		// here before the generic literal-union branch below turns it into a
		// wasteful literal-index encoding and makes `Packed<T>` unable to find
		// any `bool` field to pack.
		const isBooleanLiteral = (t: ts.Type): boolean => (t.flags & ts_.TypeFlags.BooleanLiteral) !== 0;
		if (
			nonUndefined.length === 2 &&
			nonUndefined.every(isBooleanLiteral) &&
			new Set(nonUndefined.map((t) => checker.typeToString(t))).size === 2
		) {
			const boolField: Field = { kind: "bool", packed };
			return hasUndefined ? { kind: "optional", inner: boolField, packed } : boolField;
		}

		const isLiteralLike = (t: ts.Type): boolean =>
			t.isStringLiteral() || t.isNumberLiteral() || (t.flags & ts_.TypeFlags.BooleanLiteral) !== 0;

		if (nonUndefined.length > 0 && nonUndefined.every(isLiteralLike)) {
			const values = nonUndefined.map((t) =>
				t.isStringLiteral() || t.isNumberLiteral() ? t.value : checker.typeToString(t) === "true",
			);
			values.sort(compareLiteral);
			if (hasUndefined) {
				return { kind: "literal", values: [...values, undefined as unknown as string] };
			}
			if (values.length === 1) {
				return { kind: "literalConst", value: values[0] };
			}
			return { kind: "literal", values };
		}

		if (nonUndefined.every((t) => this.isEnumItemLike(t))) {
			const enumField = this.walkEnum(nonUndefined, node);
			return hasUndefined ? { kind: "optional", inner: enumField, packed } : enumField;
		}

		if (hasUndefined && nonUndefined.length === 1) {
			return { kind: "optional", inner: this.walk(nonUndefined[0], node, packed), packed };
		}

		constituents = nonUndefined.length > 0 ? nonUndefined : constituents;
		const union = hasUndefined
			? this.classifyUnion(constituents, node, packed)
			: this.classifyUnion(constituents, node, packed);
		return hasUndefined ? { kind: "optional", inner: union, packed } : union;
	}

	private classifyUnion(constituents: ts.Type[], node: ts.Node, packed: boolean): Field {
		const objectLike = constituents.filter((t) => t.getProperties().length > 0);
		if (objectLike.length === constituents.length) {
			const discriminant = this.findDiscriminant(objectLike, node);
			if (discriminant) {
				return this.buildTaggedUnion(objectLike, discriminant, node, packed);
			}
		}

		const fields = constituents.map((t) => this.walk(t, node, packed));

		// Every constituent routed to the opaque passthrough channel (for
		// example a union of `Instance` subclasses, now that they're
		// nominally detected -- see blob-classification.md): there is
		// nothing left to guard on, since `pushBlob`/`nextBlob` write and
		// read identically regardless of which variant produced the value.
		if (fields.length > 0 && fields.every((f) => f.kind === "blob")) {
			return { kind: "blob" };
		}

		// The write side picks a variant with a runtime type check (`guardFor`
		// in emit.ts), so every shape that check can't decide is rejected here.
		if (fields.some((f) => f.kind === "blob")) {
			this.report(
				"this union mixes an opaque variant (an Instance, a Roblox datatype without its own encoding, or " +
					'"unknown") with other variants. An opaque value has no runtime type to check, so the write side cannot ' +
					'tell the variants apart -- type the field as "unknown" to send the whole value through the blob ' +
					"passthrough channel.",
				node,
			);
			return { kind: "blob" };
		}
		const unguardable = fields.find((f) => f.kind !== "literalConst" && runtimeTypeTag(f) === undefined);
		if (unguardable) {
			this.report(`a "${unguardable.kind}" variant isn't supported as a member of this union.`, node);
			return { kind: "blob" };
		}

		const tableShapedCount = fields.filter((f) => runtimeTypeTag(f) === "table").length;
		if (tableShapedCount > 1) {
			this.report(
				"this union has two or more table-shaped variants (object/array/tuple/Map/Set/Record) with no " +
					"shared literal discriminant. Structural union guards for this case aren't implemented -- add a " +
					"unique literal discriminant property to each variant instead.",
				node,
			);
			return { kind: "blob" };
		}
		const seenTags = new Set<string>();
		for (const variant of fields) {
			const tag = runtimeTypeTag(variant);
			if (tag === undefined) {
				continue;
			}
			if (seenTags.has(tag)) {
				this.report(
					`this union has two or more variants that are all "${tag}" at runtime (for example two ` +
						`"DataType" number widths, or an enum with several members next to another type), so the ` +
						`write side can't tell them apart.`,
					node,
				);
				return { kind: "blob" };
			}
			seenTags.add(tag);
		}
		// Sorted by kind, then by value for two `literalConst` variants and by
		// name for two `datatype` variants (the only kinds that can repeat
		// among guarded-union variants): `type.types`
		// order is otherwise the checker's unstable type-id order (see
		// `compareLiteral`'s doc comment), and the variant index is encoded in
		// the buffer.
		const variants = [...fields].sort((a, b) => {
			if (a.kind !== b.kind) {
				return a.kind < b.kind ? -1 : 1;
			}
			if (a.kind === "literalConst" && b.kind === "literalConst") {
				return compareLiteral(a.value, b.value);
			}
			if (a.kind === "datatype" && b.kind === "datatype") {
				return compareLiteral(a.name, b.name);
			}
			return 0;
		});
		return { kind: "guardedUnion", variants };
	}

	private findDiscriminant(variants: ts.Type[], node: ts.Node): string | undefined {
		const checker = this.checker;
		// Name-sorted, not declaration order: when two properties both qualify
		// as a discriminant, the choice must not depend on which was declared
		// first in variant 0 (see `compareLiteral`'s doc comment).
		const candidateNames = variants[0]
			.getProperties()
			.map((p) => p.name)
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		for (const name of candidateNames) {
			const values: Array<string | number | boolean> = [];
			let ok = true;
			for (const variant of variants) {
				const prop = variant.getProperty(name);
				if (!prop) {
					ok = false;
					break;
				}
				const propType = checker.getTypeOfSymbolAtLocation(prop, node);
				if (propType.isStringLiteral() || propType.isNumberLiteral()) {
					values.push(propType.value);
				} else if ((propType.flags & this.typescript.TypeFlags.BooleanLiteral) !== 0) {
					values.push(checker.typeToString(propType) === "true");
				} else {
					ok = false;
					break;
				}
			}
			if (ok && new Set(values).size === values.length) {
				return name;
			}
		}
		return undefined;
	}

	private buildTaggedUnion(variants: ts.Type[], tagKey: string, node: ts.Node, packed: boolean): Field {
		const checker = this.checker;
		const builtVariants = variants.map((variant) => {
			const prop = variant.getProperty(tagKey)!;
			const propType = checker.getTypeOfSymbolAtLocation(prop, node);
			const tagValue: string | number | boolean =
				propType.isStringLiteral() || propType.isNumberLiteral()
					? propType.value
					: checker.typeToString(propType) === "true";
			const properties = variant.getProperties().filter((p) => p.name !== tagKey);
			const names = properties.map((p) => p.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
			const fields = names.map((name) => {
				const propSymbol = properties.find((p) => p.name === name)!;
				const propType2 = checker.getTypeOfSymbolAtLocation(propSymbol, node);
				return {
					...this.keyOf(propSymbol),
					field: this.walk(propType2, this.nodeForProperty(propSymbol, node), packed),
				};
			});
			return { tagValue, fields };
		});
		// Sorted by tag value for the same reason object properties are
		// sorted by name (Transformer Design §3): union constituent order
		// from `type.types` reflects declaration/normalization order, not
		// anything guaranteed stable across differently-constructed
		// equivalent types, and the variant index is encoded in the buffer.
		builtVariants.sort((a, b) => compareLiteral(a.tagValue, b.tagValue));
		const tagKeyNumeric = this.keyOf(variants[0].getProperty(tagKey)!).numericKey;
		return { kind: "taggedUnion", tagKey, ...(tagKeyNumeric ? { tagKeyNumeric } : {}), variants: builtVariants };
	}
}
