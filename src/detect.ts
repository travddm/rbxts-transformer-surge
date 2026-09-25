import * as fs from "fs";
import * as path from "path";

import type ts from "typescript";

const FACTORY_NAMES = new Set(["createSerializer", "createDeserializer", "createBinarySerializer"]);
export type FactoryName = "createSerializer" | "createDeserializer" | "createBinarySerializer";

const packageNameCache = new Map<string, string | undefined>();

/**
 * Walks up from `filePath` to the nearest `package.json` and returns its
 * `name`. Deliberately *not* a check against a `node_modules/@rbxts/surge/`
 * path pattern: `@rbxts/surge` and `rbxts-transformer-surge` ship as two
 * separate repos (see architecture.md), and a consumer's `tests/`-style
 * project installs `@rbxts/surge` as a plain `file:`/`github:` dependency,
 * so `ts.Symbol.declarations[0]`'s source file is wherever npm actually
 * placed it -- always somewhere under a `node_modules/@rbxts/surge/`
 * directory in practice, but reading the nearest package.json's declared
 * `name` is the identity check that holds regardless of exactly how deep
 * under `node_modules` that turns out to be.
 */
function nearestPackageName(filePath: string): string | undefined {
	let dir = path.dirname(filePath);
	for (;;) {
		if (packageNameCache.has(dir)) {
			return packageNameCache.get(dir);
		}
		const pkgJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgJsonPath)) {
			try {
				const name = (JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as { name?: string }).name;
				packageNameCache.set(dir, name);
				return name;
			} catch {
				packageNameCache.set(dir, undefined);
				return undefined;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

function isFromPackage(declarations: ts.Declaration[] | undefined, packageName: string): boolean {
	const decl = declarations?.[0];
	return decl !== undefined && nearestPackageName(decl.getSourceFile().fileName) === packageName;
}

function isFromSurgePackage(declarations: ts.Declaration[] | undefined): boolean {
	return isFromPackage(declarations, "@rbxts/surge");
}

/**
 * `@rbxts/types` brands every Roblox class and datatype interface with its
 * own uniquely named `_nominal_<TypeName>: unique symbol` property --
 * `Instance` and each of its subclasses, plus `Vector2`, `BrickColor`,
 * `CFrame`, and every other datatype (confirmed via `grep -n "_nominal_"` in
 * the package's own `.d.ts` files; see Transformer 4.1 in
 * docs/specs/transformer.md in the surge repo). Checking property shape plus
 * declaration origin, rather than a fixed name list, covers all of them
 * uniformly and can't be triggered by an unrelated user type that happens to
 * declare its own `_nominal_*`-named property.
 */
export function isRobloxNominalType(type: ts.Type): boolean {
	return type
		.getProperties()
		.some((p) => p.name.startsWith("_nominal_") && isFromPackage(p.declarations, "@rbxts/types"));
}

export function isFromTypesPackage(declarations: ts.Declaration[] | undefined): boolean {
	return isFromPackage(declarations, "@rbxts/types");
}

/**
 * Whether a `Map`, `ReadonlyMap`, `Set` or `ReadonlySet` is the built-in one:
 * declared by `@rbxts/compiler-types` in a roblox-ts project, or by
 * TypeScript's own lib in a program compiled without it. Only the first occurs
 * in a real build; the second is what this repository's own tests compile
 * against unless they ask for the Roblox types. A user type of the same name
 * is neither.
 */
export function isBuiltinCollection(declarations: ts.Declaration[] | undefined): boolean {
	return isFromPackage(declarations, "@rbxts/compiler-types") || isFromPackage(declarations, "typescript");
}

/**
 * Resolves a call expression's callee to its canonical declaration --
 * following `checker.getAliasedSymbol` through any re-export/import alias --
 * and returns which `@rbxts/surge` factory it identifies, if any.
 * Detection by declaration identity, not by matching the name
 * "createSerializer" as text: confirmed via a spike
 * (docs/research/compile-time-specialization.md in the surge repo) that a
 * re-exported/aliased import still resolves correctly, while an unrelated
 * same-named local declaration does not.
 */
export function resolveFactoryName(
	typescript: typeof ts,
	checker: ts.TypeChecker,
	expression: ts.Expression,
): FactoryName | undefined {
	let symbol = checker.getSymbolAtLocation(expression);
	if (!symbol) {
		return undefined;
	}
	while ((symbol.flags & typescript.SymbolFlags.Alias) !== 0) {
		symbol = checker.getAliasedSymbol(symbol);
	}
	if (!FACTORY_NAMES.has(symbol.name) || !isFromSurgePackage(symbol.declarations)) {
		return undefined;
	}
	return symbol.name as FactoryName;
}

/**
 * Whether the result `@rbxts/surge` declares for this call site's `serialize`
 * is a table with a `blobs` array rather than the buffer alone: its
 * `Serialized<T>` resolved for the call's type argument (Runtime API 3.6 in
 * docs/specs/runtime-api.md in the surge repo). The package's type decides the
 * shape, because the caller's code is checked against it. A result with no
 * `blobs` property, such as a `buffer`, has no array.
 */
export function declaredResultCarriesBlobs(
	typescript: typeof ts,
	checker: ts.TypeChecker,
	node: ts.CallExpression,
	factoryName: FactoryName,
): boolean {
	if (factoryName === "createDeserializer") {
		return false;
	}
	const returned = checker.getTypeAtLocation(node);
	const serializeSymbol = factoryName === "createSerializer" ? undefined : returned.getProperty("serialize");
	const serialize = serializeSymbol ? checker.getTypeOfSymbolAtLocation(serializeSymbol, node) : returned;
	const result = serialize.getCallSignatures()[0]?.getReturnType();
	const blobs = result?.getProperty("blobs");
	if (!blobs) {
		return false;
	}
	const blobsType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(blobs, node));
	return (blobsType.flags & typescript.TypeFlags.Never) === 0;
}

/**
 * If `type` is a reference to one of `@rbxts/surge`'s branded
 * `DataType.*` type aliases (see data-type.ts in @rbxts/surge), returns
 * its bare name (`"f32"`, `"Packed"`, ...). Detected via `type.aliasSymbol`
 * rather than structurally matching the brand's intersection shape, which is
 * both simpler and can't be confused with a user-defined lookalike type
 * outside the package.
 */
export function getDataTypeBrand(type: ts.Type): string | undefined {
	const aliasSymbol = (type as ts.Type & { aliasSymbol?: ts.Symbol }).aliasSymbol;
	if (aliasSymbol && isFromSurgePackage(aliasSymbol.declarations)) {
		return aliasSymbol.name;
	}
	return widthFromBrandProperty(type);
}

/** The number widths `DataType` brands, each `number & { _surge_<width>?: never }` in data-type.ts. */
export const NUM_BRAND_WIDTHS: ReadonlySet<string> = new Set([
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

/**
 * A width brand that has lost its alias still carries its brand property. An
 * index signature's key type is one: in `Record<DataType.u8, V>` the key is
 * the bare intersection, with no `aliasSymbol` to find.
 */
function widthFromBrandProperty(type: ts.Type): string | undefined {
	if (!type.isIntersection()) {
		return undefined;
	}
	for (const width of NUM_BRAND_WIDTHS) {
		const property = type.getProperty(`_surge_${width}`);
		if (property && isFromSurgePackage(property.declarations)) {
			return width;
		}
	}
	return undefined;
}

/**
 * The `DataType.*` brands that take type arguments, and the property each one
 * records them in. The property holds every argument, so a re-alias -- which
 * carries its own `aliasSymbol` and not the brand's -- is still resolvable
 * from the type's shape.
 */
const PARAMETERIZED_BRANDS = [
	{ name: "Packed", property: "_surge_packed" },
	{ name: "Length", property: "_surge_length" },
	{ name: "Vector", property: "_surge_vector" },
	{ name: "Transform", property: "_surge_transform" },
	{ name: "Range", property: "_surge_range" },
	{ name: "Quantized", property: "_surge_quantized" },
] as const;

type ParameterizedBrand = (typeof PARAMETERIZED_BRANDS)[number];

export interface SurgeBrand {
	readonly name: string;
	readonly args: readonly ts.Type[];
}

/** The type arguments `property` records, or `undefined` if it is not surge's. */
function argumentsFromBrandProperty(
	checker: ts.TypeChecker,
	type: ts.Type,
	property: string,
): readonly ts.Type[] | undefined {
	const brandProperty = type.getProperty(property);
	if (!brandProperty || !isFromSurgePackage(brandProperty.declarations)) {
		return undefined;
	}
	const brandType = checker.getNonNullableType(checker.getTypeOfSymbol(brandProperty));
	return checker.isTupleType(brandType) ? checker.getTypeArguments(brandType as ts.TypeReference) : undefined;
}

/**
 * The outermost `DataType.*` brand on `type`, with its type arguments
 * (`Packed<T>` and `Quantized<T>` give `[T]`, `Length<T, L>` gives `[T, L]`,
 * `Vector<X, Y, Z>` and `Transform<X, Y, Z>` give `[X, Y, Z]`,
 * `Range<T, Min, Max>` gives `[T, Min, Max]`, and a width brand gives none).
 *
 * Alias identity is tried first, and for every brand rather than one brand at
 * a time, because a composition flattens into an intersection carrying both
 * brand properties: `Length<Packed<T>, u16>` has `_surge_packed` just as much
 * as `_surge_length`, so a property check would answer "Packed" and the
 * length would be dropped with no error.
 *
 * A re-alias (`type Ids = DataType.Length<string[], u16>`) has no brand alias
 * left, so the properties are all there is. Where a re-aliased composition
 * has both, only one is outermost, and the arguments say which: the outer
 * brand recorded the whole inner brand, so its inner type still carries the
 * other's property, while the inner brand recorded its arguments before the
 * outer one was applied and has lost it. A brand that fixes its own value
 * type records widths instead of a type and so is never the outer one, which
 * is the same answer: `Vector` and `Transform` cannot wrap anything.
 *
 * A width brand's property is read last. `Range<DataType.u8, 0, 100>` carries
 * `_surge_u8` as well as `_surge_range`, and the width is the inner brand.
 */
export function getSurgeBrand(checker: ts.TypeChecker, type: ts.Type): SurgeBrand | undefined {
	const aliasSymbol = (type as ts.Type & { aliasSymbol?: ts.Symbol }).aliasSymbol;
	if (aliasSymbol && isFromSurgePackage(aliasSymbol.declarations)) {
		const withArgs = type as ts.Type & { aliasTypeArguments?: readonly ts.Type[] };
		return { name: aliasSymbol.name, args: withArgs.aliasTypeArguments ?? [] };
	}

	const present: Array<{ brand: ParameterizedBrand; args: readonly ts.Type[] }> = [];
	for (const brand of PARAMETERIZED_BRANDS) {
		const args = argumentsFromBrandProperty(checker, type, brand.property);
		if (args) {
			present.push({ brand, args });
		}
	}
	if (present.length === 0) {
		const width = widthFromBrandProperty(type);
		return width === undefined ? undefined : { name: width, args: [] };
	}
	const outermost =
		present.find(({ brand, args }) =>
			present.every((other) => other.brand === brand || args[0]?.getProperty(other.brand.property) !== undefined),
		) ?? present[0];
	return { name: outermost.brand.name, args: outermost.args };
}
