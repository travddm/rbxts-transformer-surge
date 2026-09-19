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
 * the package's own `.d.ts` files; see blob-classification.md). Checking
 * property shape plus declaration origin, rather than a fixed name list,
 * covers all of them uniformly and can't be triggered by an unrelated user
 * type that happens to declare its own `_nominal_*`-named property.
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
 * Resolves a call expression's callee to its canonical declaration --
 * following `checker.getAliasedSymbol` through any re-export/import alias --
 * and returns which `@rbxts/surge` factory it identifies, if any.
 * Detection by declaration identity, not by matching the name
 * "createSerializer" as text: confirmed (Transformer Design §1 in
 * docs/transformer.md) via a spike that a re-exported/aliased import still
 * resolves correctly, while an unrelated same-named local declaration does
 * not.
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
 * If `type` is a reference to one of `@rbxts/surge`'s branded
 * `DataType.*` type aliases (see data-type.ts in @rbxts/surge), returns
 * its bare name (`"f32"`, `"Packed"`, ...). Detected via `type.aliasSymbol`
 * rather than structurally matching the brand's intersection shape, which is
 * both simpler and can't be confused with a user-defined lookalike type
 * outside the package.
 */
export function getDataTypeBrand(type: ts.Type): string | undefined {
	const aliasSymbol = (type as ts.Type & { aliasSymbol?: ts.Symbol }).aliasSymbol;
	if (!aliasSymbol || !isFromSurgePackage(aliasSymbol.declarations)) {
		return undefined;
	}
	return aliasSymbol.name;
}

export function getPackedInnerType(type: ts.Type): ts.Type | undefined {
	const withArgs = type as ts.Type & { aliasSymbol?: ts.Symbol; aliasTypeArguments?: readonly ts.Type[] };
	if (getDataTypeBrand(type) !== "Packed") {
		return undefined;
	}
	return withArgs.aliasTypeArguments?.[0];
}
