import type ts from "typescript";

import { getDataTypeBrand, getPackedInnerType } from "./detect";
import type { Field, NumWidth, ObjectFieldEntry } from "./field";

export interface WalkDiagnostic {
	readonly message: string;
	readonly node: ts.Node;
}

const NUM_BRAND_WIDTHS: ReadonlySet<string> = new Set(["f32", "f64", "u8", "u16", "u32", "i8", "i16", "i32"]);
const ROBLOX_SCALAR_KINDS: Readonly<Record<string, Field["kind"]>> = {
	Vector3: "vector3",
	CFrame: "cframe",
	Color3: "color3",
	ColorSequence: "colorSequence",
	NumberSequence: "numberSequence",
};

let helperCounter = 0;
function nextHelperName(base: string): string {
	helperCounter += 1;
	return `surge_${base}_${helperCounter}`;
}

export class TypeWalker {
	// Keyed by (symbol, packed): the same named object type can be walked
	// once plain and once inside a `Packed<T>` subtree (e.g. a shared
	// `interface` reused as both a plain field and a `Packed<T>` field
	// elsewhere in the same root type), and those two walks must produce
	// different `Field`s (only one has its boolean fields bit-packed) --
	// memoizing by symbol alone would silently reuse whichever variant was
	// walked first for both.
	private readonly resolved = new Map<ts.Symbol, Map<boolean, Field>>();
	private readonly inProgress = new Set<ts.Symbol>();
	private readonly helperNames = new Map<ts.Symbol, { name: string; packed: boolean }>();
	public readonly diagnostics: WalkDiagnostic[] = [];

	public constructor(
		private readonly typescript: typeof ts,
		private readonly checker: ts.TypeChecker,
	) {}

	private report(message: string, node: ts.Node): void {
		this.diagnostics.push({ message, node });
	}

	private getResolved(symbol: ts.Symbol, packed: boolean): Field | undefined {
		return this.resolved.get(symbol)?.get(packed);
	}

	private setResolved(symbol: ts.Symbol, packed: boolean, field: Field): void {
		let byPacked = this.resolved.get(symbol);
		if (!byPacked) {
			byPacked = new Map<boolean, Field>();
			this.resolved.set(symbol, byPacked);
		}
		byPacked.set(packed, field);
	}

	/** Resolved `Field`s for every symbol that turned out to be self-referential, keyed by the helper name assigned to it. */
	public getHelperFields(): Map<string, Field> {
		const result = new Map<string, Field>();
		for (const [symbol, { name, packed }] of this.helperNames) {
			const resolved = this.getResolved(symbol, packed);
			if (resolved) {
				result.set(name, resolved);
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
		const packedInner = getPackedInnerType(type);
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

		const symbolName = type.symbol?.name;
		if (symbolName && symbolName in ROBLOX_SCALAR_KINDS) {
			return { kind: ROBLOX_SCALAR_KINDS[symbolName] } as Field;
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

		if (type.getProperties().length > 0 || this.hasNoIndexOrProperties(type)) {
			const objectResult = this.tryWalkObject(type, node, packed);
			if (objectResult) {
				return objectResult;
			}
		}

		const indexInfos = checker.getIndexInfosOfType(type);
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

	private hasNoIndexOrProperties(type: ts.Type): boolean {
		return this.checker.getIndexInfosOfType(type).length === 0;
	}

	// ---- objects --------------------------------------------------------

	private tryWalkObject(type: ts.Type, node: ts.Node, packed: boolean): Field | undefined {
		const properties = type.getProperties();
		if (properties.length === 0) {
			return undefined;
		}
		const symbol = type.symbol;
		if (symbol && this.inProgress.has(symbol)) {
			const helperName = this.helperNameFor(symbol, packed);
			return { kind: "recursiveRef", helperName };
		}
		const cached = symbol && this.getResolved(symbol, packed);
		if (cached) {
			return cached;
		}
		if (symbol) {
			this.inProgress.add(symbol);
		}

		const names = properties.map((p) => p.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		const fields: ObjectFieldEntry[] = [];
		for (const name of names) {
			const prop = properties.find((p) => p.name === name)!;
			const propType = this.checker.getTypeOfSymbolAtLocation(prop, node);
			fields.push({ name, field: this.walk(propType, node, packed) });
		}

		let result: Field = { kind: "object", fields };
		if (symbol) {
			this.inProgress.delete(symbol);
			const helper = this.helperNames.get(symbol);
			if (helper && helper.packed === packed) {
				result = { kind: "object", fields, helperName: helper.name };
			}
			this.setResolved(symbol, packed, result);
		}
		return result;
	}

	private helperNameFor(symbol: ts.Symbol, packed: boolean): string {
		let entry = this.helperNames.get(symbol);
		if (!entry) {
			entry = { name: nextHelperName(symbol.name || "recursive"), packed };
			this.helperNames.set(symbol, entry);
		}
		return entry.name;
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
		const props = type.getProperties();
		const names = new Set(props.map((p) => p.name));
		return names.has("Name") && names.has("Value") && names.has("EnumType");
	}

	private isEnumItemUnionMember(type: ts.Type): boolean {
		return this.isEnumItemLike(type);
	}

	private walkEnum(constituents: ts.Type[], node: ts.Node): Field {
		const checker = this.checker;
		const named = constituents.map((constituent) => {
			const nameProp = constituent.getProperty("Name");
			const nameType = nameProp ? checker.getTypeOfSymbolAtLocation(nameProp, node) : undefined;
			const name = nameType && nameType.isStringLiteral() ? nameType.value : (constituent.symbol?.name ?? "");
			return name;
		});
		named.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

		const first = constituents[0];
		const aliasName = (first as ts.Type & { aliasSymbol?: ts.Symbol }).aliasSymbol?.name;
		const parentSymbol = (first.symbol as (ts.Symbol & { parent?: ts.Symbol }) | undefined)?.parent;
		const enumName = aliasName ?? parentSymbol?.name ?? "Enum";
		return { kind: "enum", enumName, members: named };
	}

	// ---- unions -------------------------------------------------------

	private walkUnion(type: ts.UnionType, node: ts.Node, packed: boolean): Field {
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
		const checker = this.checker;
		const objectLike = constituents.filter((t) => t.getProperties().length > 0);
		if (objectLike.length === constituents.length) {
			const discriminant = this.findDiscriminant(objectLike, node);
			if (discriminant) {
				return this.buildTaggedUnion(objectLike, discriminant, node, packed);
			}
		}

		const fields = constituents.map((t) => this.walk(t, node, packed));
		const tableShapedCount = fields.filter(
			(f) => f.kind === "object" || f.kind === "array" || f.kind === "tuple" || f.kind === "dict",
		).length;
		if (tableShapedCount > 1) {
			this.report(
				"surge: this union has two or more table-shaped variants (object/array/tuple/Map/Set/Record) with no " +
					"shared literal discriminant. Structural union guards for this case aren't implemented -- add a " +
					"unique literal discriminant property to each variant instead.",
				node,
			);
			return { kind: "blob" };
		}
		void checker;
		return { kind: "guardedUnion", variants: fields };
	}

	private findDiscriminant(variants: ts.Type[], node: ts.Node): string | undefined {
		const checker = this.checker;
		const candidateNames = variants[0].getProperties().map((p) => p.name);
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
				return { name, field: this.walk(propType2, node, packed) };
			});
			return { tagValue, fields };
		});
		// Sorted by tag value for the same reason object properties are
		// sorted by name (Transformer Design §3): union constituent order
		// from `type.types` reflects declaration/normalization order, not
		// anything guaranteed stable across differently-constructed
		// equivalent types, and the variant index is encoded in the buffer.
		builtVariants.sort((a, b) => (a.tagValue < b.tagValue ? -1 : a.tagValue > b.tagValue ? 1 : 0));
		return { kind: "taggedUnion", tagKey, variants: builtVariants };
	}
}
