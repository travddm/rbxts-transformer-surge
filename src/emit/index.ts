/**
 * The emitter's entry point. The rest of `src/emit/` is internal to it:
 * `context.ts` holds the state and the plumbing, `layout.ts` answers what a
 * `Field` costs, `types.ts` builds the types the generated code declares, and
 * `write.ts`/`read.ts` hold one function per `Field` kind for their side.
 */
import type ts from "typescript";

import type { Field } from "../field";
import { EmitContext } from "./context";
import { readField, readObjectInline } from "./read";
import { fieldToTypeNode, objectShapeTypeNode } from "./types";
import { writeField, writeObjectInline } from "./write";

export { importAlias } from "./constants";

/**
 * Turns a `Field` IR tree into `write`/`read` statements (Transformer 5.1
 * and 5.2 in docs/specs/transformer.md in the surge repo). Every field,
 * fixed or variable-size, is inlined in source order with no runtime
 * dispatch on kind -- the exception is a self-referential field (an `object`
 * carrying `helperName`, or a bare `recursiveRef`), which compiles to a call
 * into a named helper declared in the call site's closure instead (Transformer
 * 4.2); `ensureHelper` generates that helper's body lazily,
 * the first time it's actually referenced.
 */
export class Emitter extends EmitContext {
	public writeField(field: Field, value: ts.Expression, out: ts.Statement[]): void {
		writeField(this, field, value, out);
	}

	public readField(field: Field, out: ts.Statement[]): ts.Expression {
		return readField(this, field, out);
	}

	public ensureHelper(name: string): void {
		if (this.generatedHelpers.has(name)) {
			return;
		}
		this.generatedHelpers.add(name);
		const field = this.helperFields.get(name);
		if (!field) {
			throw new Error(`surge: internal error -- no resolved field for recursive helper "${name}"`);
		}
		// Building this body can never recurse into this same helper: for an
		// `object`, `field.fields` is used directly below (`writeObjectInline`/
		// `readObjectInline`), bypassing the `field.helperName` check that
		// `writeObject`/`readObject` make -- the marker is there, just unused
		// here. Every other kind has no such marker to carry in the first
		// place, so the walker (see `walk.ts`'s `resolved`/`walkUnion` doc
		// comments) only ever hands back the bare structure for those; the
		// first call site to finish walking a recursive one instead resolves
		// to `recursiveRef`, and that's what a *nested* reference inside this
		// very `field` will be.
		const f = this.factory;

		// The helper's functions are emitted in the middle of whichever function
		// first refers to them, but their locals are their own.
		const callerLocals = this.liveLocals;

		const typeNode =
			field.kind === "object" ? objectShapeTypeNode(this, field.fields) : fieldToTypeNode(this, field);
		this.helperDecls.push(f.createTypeAliasDeclaration(undefined, `${name}_Type`, undefined, typeNode));
		const typeRef = f.createTypeReferenceNode(`${name}_Type`);

		const valueParam = f.createParameterDeclaration(undefined, undefined, "value", undefined, typeRef, undefined);
		if (this.sides.write) {
			this.beginFunction();
			const writeBody: ts.Statement[] = [];
			if (field.kind === "object") {
				writeObjectInline(this, field.fields, f.createIdentifier("value"), writeBody);
			} else {
				writeField(this, field, f.createIdentifier("value"), writeBody);
			}
			this.helperDecls.push(
				f.createFunctionDeclaration(
					undefined,
					undefined,
					`${name}_write`,
					undefined,
					[valueParam],
					undefined,
					f.createBlock(writeBody, true),
				),
			);
		}

		if (this.sides.read) {
			this.beginFunction();
			const readBody: ts.Statement[] = [];
			const resultExpr =
				field.kind === "object"
					? readObjectInline(this, field.fields, readBody)
					: readField(this, field, readBody);
			readBody.push(f.createReturnStatement(resultExpr));
			this.helperDecls.push(
				f.createFunctionDeclaration(
					undefined,
					undefined,
					`${name}_read`,
					undefined,
					[],
					typeRef,
					f.createBlock(readBody, true),
				),
			);
		}
		this.liveLocals = callerLocals;
	}

	public getHelperDecls(): ts.Statement[] {
		return this.helperDecls;
	}
}
