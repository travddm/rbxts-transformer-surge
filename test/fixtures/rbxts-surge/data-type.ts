/**
 * Fixture mirror of @rbxts/surge's src/data-type.ts, kept in sync by hand
 * (see Repository layout in surge's architecture.md for why this can't be a
 * real cross-repo dependency). Update this alongside the real file if its
 * brand shapes change.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace -- matches the real file's namespace, needed for the real `DataType.f32` dotted-type-reference syntax.
export namespace DataType {
	export type f32 = number & { readonly _surge_f32?: never };
	export type f64 = number & { readonly _surge_f64?: never };
	export type u8 = number & { readonly _surge_u8?: never };
	export type u16 = number & { readonly _surge_u16?: never };
	export type u24 = number & { readonly _surge_u24?: never };
	export type u32 = number & { readonly _surge_u32?: never };
	export type i8 = number & { readonly _surge_i8?: never };
	export type i16 = number & { readonly _surge_i16?: never };
	export type i24 = number & { readonly _surge_i24?: never };
	export type i32 = number & { readonly _surge_i32?: never };

	export type Length<T, L extends u8 | u16 | u24 | u32 = u32> = T & { readonly _surge_length?: [T, L] };

	type Width = f32 | f64 | u8 | u16 | u24 | u32 | i8 | i16 | i24 | i32;

	export type Vector<X extends Width = f32, Y extends Width = X, Z extends Width = X> = Vector3 & {
		readonly _surge_vector?: [X, Y, Z];
	};

	export type Transform<X extends Width = f32, Y extends Width = X, Z extends Width = X> = CFrame & {
		readonly _surge_transform?: [X, Y, Z];
	};

	export type Packed<T> = T & { readonly _surge_packed?: [T] };
}
