// Smoke: load extensions/vision-proxy.ts under a fake pi host (no TUI) and
// exercise the registerToolRenderer wiring end-to-end. Not part of `npm test`.
//
// Usage: node tools/smoke-renderers.mjs
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./smoke-hooks.mjs", import.meta.url);

const fail = (msg) => {
	console.error(`SMOKE FAIL: ${msg}`);
	process.exit(1);
};

const assert = (cond, msg) => {
	if (!cond) fail(msg);
	console.log(`  ok: ${msg}`);
};

// ── fake host ──────────────────────────────────────────────────────────────
const toolRenderers = [];
const pi = {
	on: () => () => {},
	registerCommand: () => {},
	registerTool: () => {},
	registerToolRenderer: (resolver) => toolRenderers.push(resolver),
	registerShortcut: () => {},
	registerFlag: () => {},
	getFlag: () => undefined,
	sendMessage: () => {},
	appendEntry: () => {},
	// registerVirtualModel intentionally absent → virtual-model path must skip
};

const mod = await import("../extensions/vision-proxy.ts");
assert(typeof mod.default === "function", "extension default-exports a factory");
mod.default(pi);

assert(toolRenderers.length === 1, "exactly one tool-renderer resolver registered");
const resolver = toolRenderers[0];

// ── fake theme + render helper ─────────────────────────────────────────────
// Real ANSI escapes (not pseudo-tags) so width-aware truncation behaves as
// in production: escapes are zero-width, stripped for the visible-length check.
const fakeTheme = {
	fg: (token, text) => `\x1b[${31 + (token.length % 5)}m${text}\x1b[0m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const stripAnsi = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
// 120 columns: wide enough that content assertions see the whole summary line
// (narrow-width behavior is covered by the explicit truncation check below).
const render = (comp) => comp.render(120).join("\n");

// ── resolver contract ──────────────────────────────────────────────────────
assert(resolver("bash", () => undefined) === undefined, "unknown tools pass through as undefined");
assert(resolver("analyze_image", () => undefined) !== undefined, "analyze_image gets renderers");
assert(resolver("generate_image", () => undefined) !== undefined, "generate_image gets renderers");

const merged = resolver("analyze_image", () => ({ renderShell: "self" }));
assert(merged.renderShell === "self", "next() renderers survive for unset keys (renderShell)");
assert(typeof merged.renderCall === "function", "our renderCall present");
assert(typeof merged.renderResult === "function", "our renderResult present");

// ── analyze_image rendering ────────────────────────────────────────────────
const analyze = resolver("analyze_image", () => undefined);
const hash = "deadbeef".repeat(4);
const callLine = render(analyze.renderCall(
	{ images: [`image="${hash}"`, "C:\\Users\\u\\shot.png"], question: "What does the legend say?", crop: [{ image_index: 0, region: "bottom-right" }] },
	fakeTheme,
	{},
));
console.log("  analyze call  →", callLine);
assert(callLine.includes("analyze_image"), "call shows the tool name");
assert(callLine.includes(`image="deadbeef…"`), "recall ref shortened");
assert(callLine.includes("shot.png"), "windows path shortened to basename");
assert(callLine.includes("bottom-right@0"), "crop summarized");

const okResult = render(analyze.renderResult(
	{ content: [{ type: "text", text: "<vision_proxy_analysis>\nthe answer\n</vision_proxy_analysis>" }], details: { ok: true, provider: "zai", model: "glm-5.3-flash", cached: true, latencyMs: 950 } },
	{ expanded: false, isPartial: false },
	fakeTheme,
	{ isError: false },
));
console.log("  analyze ok    →", okResult);
assert(okResult.includes("✓") && okResult.includes("zai/glm-5.3-flash") && okResult.includes("cached") && okResult.includes("0.9s"), "success summary line");
assert(!okResult.includes("the answer"), "collapsed view hides the fence body");

const expanded = render(analyze.renderResult(
	{ content: [{ type: "text", text: "<vision_proxy_analysis>\nthe answer\n</vision_proxy_analysis>" }], details: { ok: true } },
	{ expanded: true, isPartial: false },
	fakeTheme,
	{ isError: false },
));
assert(expanded.includes("the answer"), "expanded view shows the fence body");

const errResult = render(analyze.renderResult(
	{ content: [{ type: "text", text: "Error: consent required" }], details: { ok: false, error: "Error: consent required" } },
	{ expanded: false, isPartial: false },
	fakeTheme,
	{ isError: true },
));
console.log("  analyze error →", errResult);
assert(errResult.includes("\x1b[") && stripAnsi(errResult).startsWith("✗"), "error line styled error");

const partial = render(analyze.renderResult({ content: [] }, { expanded: false, isPartial: true }, fakeTheme, {}));
assert(partial.includes("Analyzing"), "partial shows Analyzing…");

// ── generate_image rendering ───────────────────────────────────────────────
const gen = resolver("generate_image", () => undefined);
const genCall = render(gen.renderCall({ prompt: "A red panda astronaut, watercolor", model: "google/imagen-4" }, fakeTheme, {}));
console.log("  gen call      →", genCall);
assert(genCall.includes("generate_image") && genCall.includes("red panda") && genCall.includes("google/imagen-4"), "gen call line");

const genOk = render(gen.renderResult(
	{
		content: [{ type: "text", text: "[generate_image] 1 image generated" }, { type: "image", data: "AAAA", mimeType: "image/png" }],
		details: { ok: true, provider: "google", model: "imagen-4", images: [{ id: hash, mimeType: "image/png", width: 1024, height: 768 }], costUSD: 0.0311 },
	},
	{ expanded: false, isPartial: false },
	fakeTheme,
	{ isError: false },
));
console.log("  gen ok        →", genOk);
assert(genOk.includes("1 image via google/imagen-4") && genOk.includes("$0.0311") && genOk.includes(`image="deadbeef…"`), "gen success summary");

// Garbage args must not throw (partial/streaming JSON from the model)
const garbage1 = analyze.renderCall("half-json{", fakeTheme, {});
const garbage2 = gen.renderCall([1, 2], fakeTheme, {});
const garbage3 = analyze.renderResult(undefined, { expanded: true, isPartial: false }, fakeTheme, {});
assert(true, `garbage args tolerated (${render(garbage1).length + render(garbage2).length + render(garbage3).length} chars)`);

// Fallback component must never exceed the render width (pi stops on overwide
// lines). pi-tui is unavailable in this sandbox, so plainLines is active here.
const longCall = analyze.renderCall({ images: ["/a.png"], question: "x".repeat(300) }, fakeTheme, {});
const ansi = /\x1b\[[0-9;]*m/g;
const wideOk = longCall.render(40).every((line) => line.replace(ansi, "").length <= 40);
assert(wideOk, "plainLines truncates to the render width (ANSI-aware)");

// Expanded view must show ALL text blocks (generate rows on text-only base
// models carry per-image description fences after the header).
const multiBlock = render(analyze.renderResult(
	{ content: [{ type: "text", text: "[generate_image] 1 image generated" }, { type: "text", text: "<vision_proxy_description>desc</vision_proxy_description>" }], details: { ok: true } },
	{ expanded: true, isPartial: false },
	fakeTheme,
	{ isError: false },
));
assert(multiBlock.includes("1 image generated") && multiBlock.includes("desc"), "expanded shows every text block");

console.log("SMOKE PASS");
