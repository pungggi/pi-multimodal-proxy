// Syntax gate for shipped extension files.
//
// Why: v1.16.0 shipped `extensions/vision-proxy.ts` with a stray quote
// (`ctx.ui.input("⏎ "prompt", ...)`) that pi's jiti/oxc loader rejected with
// "Unterminated string constant" — crash-looping every daemon that had the
// package installed. `node --check` (swc) ACCEPTS that construct, so the
// only reliable gate is the TypeScript parser's parse diagnostics: pure
// syntax, no type resolution, no ambient types needed.
//
// Stage 2 (1.18.0): parse-only misses constructs that only the binder sees —
// e.g. `await` inside a non-async arrow (valid to the parser, SyntaxError at
// load under node --experimental-strip-types). A full `createProgram` pass
// filtered to syntax-range codes (< 2000) catches those while staying immune
// to the known pre-existing type-level noise (TS2xxx), so the gate starts
// from a clean baseline.
//
// Usage: node tools/check-syntax.mjs [dirs...]  (default: extensions/)
// Exits 1 on any parse or syntax-range diagnostic. CI runs this before
// publish.

import { createRequire } from 'node:module';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let ts;
try {
  ts = require('typescript');
} catch {
  console.error('check-syntax: typescript is not installed (npm ci first)');
  process.exit(1);
}

const roots = process.argv.length > 2 ? process.argv.slice(2) : ['extensions'];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) yield p;
  }
}

let bad = 0;
let checked = 0;
const allFiles = [];
// TypeScript normalizes source file names to forward slashes on every
// platform; walk() yields platform separators. Normalize both sides or the
// `has()` filter below silently drops every diagnostic on Windows (found in
// review: the planted-probe test passed with the gate as a no-op).
const toTsPath = (p) => p.replace(/\\/g, '/');
const allFilesTs = new Set();
for (const root of roots) {
  for (const file of walk(root)) {
    checked++;
    allFiles.push(file);
    allFilesTs.add(toTsPath(file));
    const source = ts.createSourceFile(file, ts.sys.readFile(file) ?? '', ts.ScriptTarget.ESNext, true);
    const diags = source.parseDiagnostics;
    if (diags.length > 0) {
      bad++;
      for (const d of diags.slice(0, 5)) {
        const { line, character } = source.getLineAndCharacterOfPosition(d.start);
        console.error(`${file}:${line + 1}:${character + 1} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
      }
    }
  }
}

// Stage 2 — binder-level syntax diagnostics (codes < 2000) via a real
// program build. Type-level errors (TS2xxx) are deliberately ignored: the
// runtime strips types, and the codebase has pre-existing type noise we do
// not gate on. Requires node_modules (peer types) to be installed.
if (allFiles.length > 0) {
  const program = ts.createProgram(allFiles, {
    noEmit: true,
    skipLibCheck: true,
    allowJs: false,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const semantic = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => typeof d.code === 'number' && d.code < 2000)
    .filter((d) => {
      // Only diagnostics attached to our own files (skip lib/no-file entries).
      if (!d.file) return false;
      return allFilesTs.has(toTsPath(d.file.fileName));
    });
  if (semantic.length > 0) {
    bad += semantic.length;
    for (const d of semantic.slice(0, 10)) {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      console.error(`${d.file.fileName}:${line + 1}:${character + 1} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
  }
}
console.log(`check-syntax: ${checked} file(s), ${bad} with syntax errors`);
process.exit(bad > 0 ? 1 : 0);
