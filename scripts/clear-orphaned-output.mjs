// Deletes files in lib/ that no file in src/ produces any more, which `tsc`
// leaves behind: it never removes the output of a source file that was renamed
// or deleted, and `incremental` means it does not rewrite the rest either.
//
// A leftover file beside a new directory of the same name is why this runs.
// Splitting src/emit.ts into src/emit/ left lib/emit.js next to lib/emit/, and
// Node resolves `require("./emit")` to the file, so every consumer of the built
// package silently kept running the previous emitter -- including the round-trip
// and benchmark suites in the surge repository, which passed against it.
//
// Only output with no source is removed, so `incremental` keeps its meaning and
// a normal build stays a partial one. A file lib/ holds that tsc could not have
// emitted is left alone.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lib = join(root, "lib");
const src = join(root, "src");

// Longest first, so `.d.ts.map` is not read as a `.map` of something else.
const EMITTED_SUFFIXES = [".d.ts.map", ".d.ts", ".js.map", ".js"];

/** The source `tsc` would have emitted `file` (a path relative to lib/) from, or `undefined`. */
function sourceOf(file) {
	const suffix = EMITTED_SUFFIXES.find((candidate) => file.endsWith(candidate));
	return suffix === undefined ? undefined : `${file.slice(0, -suffix.length)}.ts`;
}

/** Removes orphaned output under `directory` and returns how many entries are left. */
function prune(directory) {
	let kept = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (prune(path) === 0) {
				rmSync(path, { recursive: true, force: true });
			} else {
				kept += 1;
			}
			continue;
		}
		const source = sourceOf(relative(lib, path));
		if (source !== undefined && !existsSync(join(src, source))) {
			rmSync(path, { force: true });
			continue;
		}
		kept += 1;
	}
	return kept;
}

if (existsSync(lib)) {
	prune(lib);
}
