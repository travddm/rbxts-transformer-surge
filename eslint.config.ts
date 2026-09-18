import eslint from "@eslint/js";
import type { Linter } from "eslint";
import { flatConfigs as importXConfigs } from "eslint-plugin-import-x";
import prettierConfig from "eslint-plugin-prettier/recommended";
import { configs as tseslintConfigs } from "typescript-eslint";

export default [
	eslint.configs.recommended,
	...tseslintConfigs.recommended,
	prettierConfig,
	importXConfigs.recommended,
	importXConfigs.typescript,
	{
		// test/fixtures/** are fixture packages compiled into their own throwaway
		// `ts.Program` at test runtime (see test/harness.ts), not part of either
		// tsconfig project -- there's no project for typed linting to attach them to.
		ignores: ["**/lib/**", "**/node_modules/**", "eslint.config.ts", "test/fixtures/**"],
	},
	{
		files: ["**/*.ts", "**/*.tsx"],
		languageOptions: {
			parserOptions: {
				ecmaVersion: 2018,
				sourceType: "module",
				projectService: true,
				tsconfigRootDir: __dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-unused-vars": "off",
			"prettier/prettier": "warn",
			// TypeScript already verifies imports, and this rule misreports modules
			// that use `export =`.
			"import-x/default": "off",
		},
	},
	{
		// Plain Node/CommonJS operating on the TypeScript compiler API -- never
		// compiled by roblox-ts, so no roblox-ts-specific rules apply here (see
		// @rbxts/surge's own eslint.config.ts for those). `any` is still banned.
		files: ["**/*.ts"],
		rules: {
			"@typescript-eslint/no-explicit-any": "error",
		},
	},
] satisfies Linter.Config[];
