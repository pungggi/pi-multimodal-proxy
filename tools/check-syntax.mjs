// Syntax gate for shipped extension files.
//
// Why: v1.16.0 shipped `extensions/vision-proxy.ts` with a stray quote
// (`ctx.ui.input("⏎ "prompt", ...)`) that pi's jiti/oxc loader rejected with
// "Unterminated string constant" — crash-looping every daemon that had the
// package installed. `node --check` (swc) ACCEPTS that construct, so the
// only reliable gate is the TypeScript parser's parse diagnostics: pure
// syntax, no type resolution, no ambient types needed.
//
// Usage: node tools/check-syntax.mjs [dirs...]  (default: extensions/)
// Exits 1 on any parse diagnostic. CI runs this before publish.

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
for (const root of roots) {
  for (const file of walk(root)) {
    checked++;
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
console.log(`check-syntax: ${checked} file(s), ${bad} with syntax errors`);
process.exit(bad > 0 ? 1 : 0);
