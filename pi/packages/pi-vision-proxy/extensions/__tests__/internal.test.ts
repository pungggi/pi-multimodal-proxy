/**
 * Unit tests for vision-proxy pure helpers.
 *
 * Run:
 *   node --experimental-strip-types --test extensions/__tests__/internal.test.ts
 *
 * Requires Node 22+ for native TypeScript stripping. No build / no deps.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import {
	buildConversationContext,
	buildDescriptionFence,
	buildAnalysisFence,
	clampPixels,
	CUSTOM_TYPE_CONFIG,
	CUSTOM_TYPE_CONSENT,
	CUSTOM_TYPE_DESCRIPTION,
	cropSignature,
	DEFAULT_CONFIG,
	envFlags,
	escapeAttr,
	extractCandidateImagePaths,
	extractDimensions,
	fenceUntrusted,
	findDescriptions,
	fuzzyMatches,
	getGroundingFormat,
	hasConsent,
	hashImageData,
	IMAGE_PATH_PLACEHOLDER,
	isPathAllowed,
	isValidNamedRegion,
	LRUCache,
	normalizedToPixels,
	parseModelString,
	pluralImages,
	readEnvOverrides,
	readImageFileWithReason,
	readPersistentFile,
	resolveConfig,
	resolveCropEntry,
	resolveRegion,
	sanitize,
	shouldStripImages,
	splitSubcommand,
	stripImagePaths,
	toPiAiImage,
	type VisionConfig,
	writePersistentFile,
} from "../internal.ts";

// SessionEntry minimal shape — typed loose because peer dep types are not loaded in test
type Entry = any;

const customEntry = (customType: string, data: unknown): Entry => ({
	type: "custom",
	customType,
	data,
});

const messageEntry = (role: "user" | "assistant", text: string): Entry => ({
	type: "message",
	message: { role, content: [{ type: "text", text }] },
});

describe("parseModelString", () => {
	it("accepts valid provider/model pairs", () => {
		assert.deepEqual(parseModelString("anthropic/claude-sonnet-4-5"), {
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		});
		assert.deepEqual(parseModelString("openai/gpt-4o"), { provider: "openai", modelId: "gpt-4o" });
		assert.deepEqual(parseModelString("provider/path/with/slashes"), {
			provider: "provider",
			modelId: "path/with/slashes",
		});
	});

	it("rejects malformed strings", () => {
		assert.equal(parseModelString(""), null);
		assert.equal(parseModelString("/foo"), null);
		assert.equal(parseModelString("foo/"), null);
		assert.equal(parseModelString("noslash"), null);
		assert.equal(parseModelString("provider with space/m"), null);
		assert.equal(parseModelString("provider/has space"), null);
	});
});

describe("sanitize", () => {
	it("clobbers garbage to defaults", () => {
		const out = sanitize({
			mode: "weird" as any,
			provider: "bad provider",
			modelId: "bad model id",
			systemPrompt: "",
			includeContext: "yes" as any,
		});
		assert.equal(out.mode, DEFAULT_CONFIG.mode);
		assert.equal(out.provider, DEFAULT_CONFIG.provider);
		assert.equal(out.modelId, DEFAULT_CONFIG.modelId);
		assert.equal(out.systemPrompt, DEFAULT_CONFIG.systemPrompt);
		assert.equal(out.includeContext, DEFAULT_CONFIG.includeContext);
	});

	it("preserves valid values", () => {
		const cfg: VisionConfig = {
			mode: "always",
			provider: "openai",
			modelId: "gpt-4o",
			systemPrompt: "custom prompt",
			includeContext: false,
			tool: "on",
			maxImagesPerCall: 5,
			maxBatch: 2,
			cacheSize: 100,
			pHashSimilarityThreshold: 0.9,
			groundingModels: {},
		};
		const result = sanitize(cfg);
		assert.equal(result.mode, cfg.mode);
		assert.equal(result.provider, cfg.provider);
		assert.equal(result.modelId, cfg.modelId);
		assert.equal(result.systemPrompt, cfg.systemPrompt);
		assert.equal(result.includeContext, cfg.includeContext);
		assert.equal(result.tool, cfg.tool);
		assert.equal(result.maxImagesPerCall, cfg.maxImagesPerCall);
		assert.equal(result.maxBatch, cfg.maxBatch);
		assert.equal(result.cacheSize, cfg.cacheSize);
		assert.equal(result.pHashSimilarityThreshold, cfg.pHashSimilarityThreshold);
	});
});

describe("readEnvOverrides", () => {
	it("returns empty when env unset", () => {
		assert.deepEqual(readEnvOverrides({}), {});
	});

	it("reads valid mode", () => {
		assert.deepEqual(readEnvOverrides({ PI_VISION_PROXY_MODE: "always" }), { mode: "always" });
		assert.deepEqual(readEnvOverrides({ PI_VISION_PROXY_MODE: "off" }), { mode: "off" });
	});

	it("ignores invalid mode", () => {
		assert.deepEqual(readEnvOverrides({ PI_VISION_PROXY_MODE: "bogus" }), {});
	});

	it("reads model string", () => {
		const out = readEnvOverrides({ PI_VISION_PROXY_MODEL: "openai/gpt-4o" });
		assert.equal(out.provider, "openai");
		assert.equal(out.modelId, "gpt-4o");
	});

	it("ignores malformed model string", () => {
		assert.deepEqual(readEnvOverrides({ PI_VISION_PROXY_MODEL: "noslash" }), {});
	});

	it("parses includeContext truthy/falsy values", () => {
		for (const v of ["1", "true", "yes", "on", "TRUE", "On"]) {
			assert.equal(readEnvOverrides({ PI_VISION_PROXY_INCLUDE_CONTEXT: v }).includeContext, true, `truthy ${v}`);
		}
		for (const v of ["0", "false", "no", "off", "FALSE"]) {
			assert.equal(readEnvOverrides({ PI_VISION_PROXY_INCLUDE_CONTEXT: v }).includeContext, false, `falsy ${v}`);
		}
		assert.equal(readEnvOverrides({ PI_VISION_PROXY_INCLUDE_CONTEXT: "garbage" }).includeContext, undefined);
	});
});

describe("envFlags", () => {
	it("reports presence per variable", () => {
		assert.deepEqual(envFlags({}), { mode: false, model: false, context: false, tool: false, maxImagesPerCall: false, maxBatch: false, cacheSize: false });
		assert.deepEqual(
			envFlags({
				PI_VISION_PROXY_MODE: "x",
				PI_VISION_PROXY_MODEL: "y",
				PI_VISION_PROXY_INCLUDE_CONTEXT: "",
			}),
			{ mode: true, model: true, context: true, tool: false, maxImagesPerCall: false, maxBatch: false, cacheSize: false },
		);
	});
});

describe("resolveConfig", () => {
	it("returns defaults with no entries and empty env", () => {
		const cfg = resolveConfig([], {});
		assert.deepEqual(cfg, DEFAULT_CONFIG);
	});

	it("env wins over persisted", () => {
		const entries: Entry[] = [customEntry(CUSTOM_TYPE_CONFIG, { mode: "off" })];
		const cfg = resolveConfig(entries, { PI_VISION_PROXY_MODE: "always" });
		assert.equal(cfg.mode, "always");
	});

	it("uses last persisted entry", () => {
		const entries: Entry[] = [
			customEntry(CUSTOM_TYPE_CONFIG, { mode: "off" }),
			customEntry(CUSTOM_TYPE_CONFIG, { mode: "always" }),
		];
		assert.equal(resolveConfig(entries, {}).mode, "always");
	});
});

describe("fenceUntrusted", () => {
	it("neutralizes opening tag", () => {
		const out = fenceUntrusted("<vision_proxy_description>");
		assert.notEqual(out, "<vision_proxy_description>");
		assert.ok(out.includes("​"), "ZWSP injected");
	});

	it("neutralizes closing tag, case-insensitive", () => {
		const out = fenceUntrusted("</VISION_PROXY_DESCRIPTION>");
		assert.notEqual(out, "</VISION_PROXY_DESCRIPTION>");
	});

	it("leaves unrelated text intact", () => {
		assert.equal(fenceUntrusted("plain text <other>"), "plain text <other>");
	});
});

describe("hashImageData", () => {
	it("is deterministic and 32 chars", () => {
		const a = hashImageData("hello");
		const b = hashImageData("hello");
		assert.equal(a, b);
		assert.equal(a.length, 32);
	});

	it("differs for different inputs", () => {
		assert.notEqual(hashImageData("a"), hashImageData("b"));
	});
});

describe("pluralImages", () => {
	it("singular vs plural", () => {
		assert.equal(pluralImages(1), "1 image");
		assert.equal(pluralImages(0), "0 images");
		assert.equal(pluralImages(5), "5 images");
	});
});

describe("splitSubcommand", () => {
	it("splits sub and value with arbitrary whitespace", () => {
		assert.deepEqual(splitSubcommand("model anthropic/claude"), { sub: "model", value: "anthropic/claude" });
		assert.deepEqual(splitSubcommand("model    anthropic/claude  "), {
			sub: "model",
			value: "anthropic/claude",
		});
		assert.deepEqual(splitSubcommand("CONSENT YES"), { sub: "consent", value: "YES" });
	});

	it("handles bare sub with no value", () => {
		assert.deepEqual(splitSubcommand("consent"), { sub: "consent", value: "" });
	});

	it("handles empty input", () => {
		assert.deepEqual(splitSubcommand(""), { sub: "", value: "" });
	});
});

describe("buildConversationContext", () => {
	it("returns empty for no message entries", () => {
		assert.equal(buildConversationContext([]), "");
	});

	it("concatenates user and assistant text in order", () => {
		const entries: Entry[] = [
			messageEntry("user", "first"),
			messageEntry("assistant", "reply"),
			customEntry("other", {}),
		];
		const out = buildConversationContext(entries);
		assert.equal(out, "User: first\nAssistant: reply");
	});

	it("keeps only the last 8 message entries", () => {
		const entries: Entry[] = [];
		for (let i = 0; i < 12; i++) entries.push(messageEntry("user", `m${i}`));
		const out = buildConversationContext(entries);
		const lines = out.split("\n");
		assert.equal(lines.length, 8);
		assert.equal(lines[0], "User: m4");
		assert.equal(lines[7], "User: m11");
	});

	it("truncates assistant content to 500 chars", () => {
		const long = "x".repeat(800);
		const out = buildConversationContext([messageEntry("assistant", long)]);
		assert.ok(out.startsWith("Assistant: "));
		assert.equal(out.length, "Assistant: ".length + 500);
	});

	it("truncates total to last 3000 chars with ellipsis", () => {
		const entries: Entry[] = [];
		for (let i = 0; i < 8; i++) entries.push(messageEntry("user", "y".repeat(490)));
		const out = buildConversationContext(entries);
		assert.ok(out.length <= 3001);
		assert.ok(out.startsWith("…"));
	});
});

describe("findDescriptions", () => {
	it("collects hash → description from custom entries", () => {
		const entries: Entry[] = [
			customEntry(CUSTOM_TYPE_DESCRIPTION, { hash: "abc", description: "desc-a" }),
			customEntry(CUSTOM_TYPE_DESCRIPTION, { hash: "def", description: "desc-b" }),
			customEntry("other", {}),
			customEntry(CUSTOM_TYPE_DESCRIPTION, { hash: "", description: "skip" }),
		];
		const map = findDescriptions(entries);
		assert.equal(map.size, 2);
		assert.equal(map.get("abc"), "desc-a");
		assert.equal(map.get("def"), "desc-b");
	});
});

describe("hasConsent", () => {
	it("returns false with no entries", () => {
		assert.equal(hasConsent([]), false);
	});

	it("uses the most recent consent entry", () => {
		const entries: Entry[] = [
			customEntry(CUSTOM_TYPE_CONSENT, { granted: true }),
			customEntry(CUSTOM_TYPE_CONSENT, { granted: false }),
		];
		assert.equal(hasConsent(entries), false);

		const granted: Entry[] = [
			customEntry(CUSTOM_TYPE_CONSENT, { granted: false }),
			customEntry(CUSTOM_TYPE_CONSENT, { granted: true }),
		];
		assert.equal(hasConsent(granted), true);
	});

	it("supports per-provider consent", () => {
		// Consent for anthropic should not carry over to openai
		const entries: Entry[] = [
			customEntry(CUSTOM_TYPE_CONSENT, { granted: true, provider: "anthropic" }),
		];
		assert.equal(hasConsent(entries, "anthropic"), true);
		assert.equal(hasConsent(entries, "openai"), false);
		// Without provider arg, any granted consent matches
		assert.equal(hasConsent(entries), true);
	});

	it("global consent (no provider) does NOT satisfy per-provider check", () => {
		const entries: Entry[] = [
			customEntry(CUSTOM_TYPE_CONSENT, { granted: true }),
		];
		// Global consent is valid when no specific provider is requested
		assert.equal(hasConsent(entries), true);
		// But it does NOT satisfy a per-provider consent check
		assert.equal(hasConsent(entries, "anthropic"), false);
		assert.equal(hasConsent(entries, "openai"), false);
	});
});

describe("toPiAiImage", () => {
	it("passes through new shape", () => {
		const img = { type: "image", data: "AAAA", mimeType: "image/png" } as any;
		assert.deepEqual(toPiAiImage(img), { type: "image", data: "AAAA", mimeType: "image/png" });
	});

	it("converts legacy { source: { data, mediaType } } shape", () => {
		const legacy = { source: { data: "BBBB", mediaType: "image/jpeg" } };
		assert.deepEqual(toPiAiImage(legacy), { type: "image", data: "BBBB", mimeType: "image/jpeg" });
	});

	it("throws on unsupported shape", () => {
		assert.throws(() => toPiAiImage({} as any), /Unsupported image content shape/);
	});
});

describe("shouldStripImages", () => {
	const cfg = (mode: VisionConfig["mode"]): VisionConfig => ({ ...DEFAULT_CONFIG, mode });

	it("off → never strip", () => {
		assert.equal(shouldStripImages(cfg("off"), undefined), false);
		assert.equal(shouldStripImages(cfg("off"), ["image", "text"]), false);
	});

	it("always → always strip", () => {
		assert.equal(shouldStripImages(cfg("always"), undefined), true);
		assert.equal(shouldStripImages(cfg("always"), ["image"]), true);
	});

	it("fallback → strip only when model lacks image input", () => {
		assert.equal(shouldStripImages(cfg("fallback"), ["text"]), true);
		assert.equal(shouldStripImages(cfg("fallback"), undefined), true);
		assert.equal(shouldStripImages(cfg("fallback"), ["text", "image"]), false);
	});
});

describe("extractCandidateImagePaths", () => {
	it("detects pi-clipboard temp files (Windows)", () => {
		const text = "What is this? C:\\Users\\Alessandro\\AppData\\Local\\Temp\\pi-clipboard-57a452d3-a1b2-c3d4-e5f6-789012345678.png";
		const paths = extractCandidateImagePaths(text);
		assert.equal(paths.length, 1);
		assert.ok(paths[0].includes("pi-clipboard-"));
		assert.ok(paths[0].endsWith(".png"));
	});

	it("detects pi-clipboard temp files (Unix)", () => {
		const text = "/tmp/pi-clipboard-abc123-def456.png";
		const paths = extractCandidateImagePaths(text);
		assert.equal(paths.length, 1);
		assert.ok(paths[0].includes("pi-clipboard-"));
	});

	it("detects general image paths with common extensions", () => {
		const cases = [
			{ input: "see ./screenshot.jpg", ext: ".jpg" },
			{ input: "look at /home/user/photo.jpeg", ext: ".jpeg" },
			{ input: "check /tmp/diagram.gif", ext: ".gif" },
			{ input: "view C:\\logs\\capture.webp", ext: ".webp" },
			{ input: "show ~/pic.bmp", ext: ".bmp" },
			{ input: "open ./scan.tiff", ext: ".tiff" },
			{ input: "see ./icon.ico", ext: ".ico" },
			{ input: "view ./photo.avif", ext: ".avif" },
		];
		for (const { input, ext } of cases) {
			const paths = extractCandidateImagePaths(input);
			assert.equal(paths.length, 1, `should detect ${ext} in: ${input}`);
			assert.ok(paths[0].endsWith(ext), `path should end with ${ext}`);
		}
	});

	it("deduplicates identical paths", () => {
		const text = "see ./img.png and ./img.png again";
		const paths = extractCandidateImagePaths(text);
		assert.equal(paths.length, 1);
	});

	it("returns empty for text without image paths", () => {
		assert.deepEqual(extractCandidateImagePaths("hello world"), []);
		assert.deepEqual(extractCandidateImagePaths(""), []);
		assert.deepEqual(extractCandidateImagePaths("no images here.txt"), []);
	});

	it("does not match URLs", () => {
		const paths = extractCandidateImagePaths("see https://example.com/photo.png for details");
		assert.equal(paths.length, 0);
	});

	it("does not match bare filenames (HTML/Markdown)", () => {
		assert.deepEqual(extractCandidateImagePaths('<img src="photo.png">'), []);
		assert.deepEqual(extractCandidateImagePaths('![alt](photo.png)'), []);
		assert.deepEqual(extractCandidateImagePaths('photo.png'), []);
	});

	it("does not match file:// URLs as bare paths", () => {
		// file:///tmp/x.png — leading "file:" not in allow-list; only the inner /tmp portion
		// matters, but the colon prevents the anchor from matching cleanly. Should not double-emit.
		const paths = extractCandidateImagePaths("see file:///tmp/x.png");
		assert.ok(paths.every((p) => !p.startsWith("file:")));
	});
});

describe("stripImagePaths", () => {
	it("replaces a single path with placeholder", () => {
		const result = stripImagePaths("see /tmp/pi-clipboard-abc.png here", ["/tmp/pi-clipboard-abc.png"]);
		assert.equal(result, `see ${IMAGE_PATH_PLACEHOLDER} here`);
	});

	it("replaces multiple paths", () => {
		const result = stripImagePaths(
			"/tmp/a.png and /tmp/b.jpg",
			["/tmp/a.png", "/tmp/b.jpg"],
		);
		assert.ok(!result.includes("/tmp/a.png"));
		assert.ok(!result.includes("/tmp/b.jpg"));
		assert.equal(result.match(/\[image file/g)?.length, 2);
	});

	it("handles empty paths array", () => {
		const text = "unchanged text";
		assert.equal(stripImagePaths(text, []), text);
	});

	it("handles longer paths first to avoid partial replacements", () => {
		const result = stripImagePaths(
			"/tmp/img.png /tmp/img.png.bak",
			["/tmp/img.png.bak", "/tmp/img.png"],
		);
		assert.ok(!result.includes("/tmp/img.png"));
	});
});

// 1×1 transparent PNG
const TINY_PNG = Buffer.from(
	"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082",
	"hex",
);

describe("isPathAllowed", () => {
	it("allows files inside tmpdir", async () => {
		const dir = await mkdtemp(join(os.tmpdir(), "vp-test-"));
		const file = join(dir, "x.png");
		await writeFile(file, TINY_PNG);
		try {
			assert.equal(await isPathAllowed(file), true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("denies non-existent files", async () => {
		assert.equal(await isPathAllowed(join(os.tmpdir(), "does-not-exist-xyz.png")), false);
	});

	it("denies homedir files unless PI_VISION_PROXY_ALLOW_HOME=1", async () => {
		// Use tmpdir as a stand-in we can write to; flip env to simulate the gate.
		// We resolve a path that is neither under cwd nor tmp by asserting the env behaviour
		// indirectly: with the flag set, an existing tmp file is still allowed (tmp wins);
		// without it, that's also true. So we test the env path explicitly with realpath of
		// homedir itself, which is a real, resolvable directory outside tmp/cwd.
		const home = os.homedir();
		const prev = process.env.PI_VISION_PROXY_ALLOW_HOME;
		try {
			delete process.env.PI_VISION_PROXY_ALLOW_HOME;
			// homedir() may equal cwd in odd setups; skip the assertion in that case.
			if (!home.toLowerCase().startsWith(process.cwd().toLowerCase())) {
				assert.equal(await isPathAllowed(home), false);
			}
			process.env.PI_VISION_PROXY_ALLOW_HOME = "1";
			assert.equal(await isPathAllowed(home), true);
		} finally {
			if (prev === undefined) delete process.env.PI_VISION_PROXY_ALLOW_HOME;
			else process.env.PI_VISION_PROXY_ALLOW_HOME = prev;
		}
	});
});

describe("readImageFileWithReason", () => {
	it("reads valid PNG inside tmpdir", async () => {
		const dir = await mkdtemp(join(os.tmpdir(), "vp-test-"));
		const file = join(dir, "ok.png");
		await writeFile(file, TINY_PNG);
		try {
			const r = await readImageFileWithReason(file);
			assert.ok(r.image, "image should be returned");
			assert.equal(r.image?.mimeType, "image/png");
			assert.equal(r.image?.type, "image");
			assert.ok((r.image?.data ?? "").length > 0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("returns reason=not-an-image for unsupported extensions", async () => {
		const r = await readImageFileWithReason("/tmp/foo.txt");
		assert.equal(r.image, null);
		assert.equal(r.reason, "not-an-image");
	});

	it("returns reason=denied for path outside allow-list", async () => {
		// /etc/passwd.png does not exist but extension is image-like.
		// realpath fails → denied. Either reason is acceptable in that order; assert non-null reason.
		const r = await readImageFileWithReason("/etc/never-exists-vp.png");
		assert.equal(r.image, null);
		assert.equal(r.reason, "denied");
	});

	it("returns reason=empty for zero-byte image", async () => {
		const dir = await mkdtemp(join(os.tmpdir(), "vp-test-"));
		const file = join(dir, "empty.png");
		await writeFile(file, "");
		try {
			const r = await readImageFileWithReason(file);
			assert.equal(r.image, null);
			assert.equal(r.reason, "empty");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("returns reason=too-large when above PI_VISION_PROXY_MAX_IMAGE_BYTES", async () => {
		const dir = await mkdtemp(join(os.tmpdir(), "vp-test-"));
		const file = join(dir, "big.png");
		await writeFile(file, Buffer.alloc(64));
		const prev = process.env.PI_VISION_PROXY_MAX_IMAGE_BYTES;
		process.env.PI_VISION_PROXY_MAX_IMAGE_BYTES = "32";
		try {
			const r = await readImageFileWithReason(file);
			assert.equal(r.image, null);
			assert.equal(r.reason, "too-large");
			assert.equal(r.bytes, 64);
		} finally {
			if (prev === undefined) delete process.env.PI_VISION_PROXY_MAX_IMAGE_BYTES;
			else process.env.PI_VISION_PROXY_MAX_IMAGE_BYTES = prev;
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("denies symlink resolving outside allow-list", async () => {
		const dir = await mkdtemp(join(os.tmpdir(), "vp-test-"));
		const target = "/etc/never-exists-vp-target.png";
		const link = join(dir, "link.png");
		try {
			try {
				await symlink(target, link);
			} catch {
				return; // platform doesn't support symlinks (e.g., Windows w/o admin) → skip
			}
			const r = await readImageFileWithReason(link);
			assert.equal(r.image, null);
			assert.equal(r.reason, "denied");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("readPersistentFile / writePersistentFile", () => {
	it("round-trips config through a file", async () => {
		const dir = await mkdtemp(join(os.tmpdir(), "vp-test-"));
		try {
			const cfg: Partial<VisionConfig> = { mode: "always", provider: "openai", modelId: "gpt-4o" };
			await writePersistentFile(cfg, dir);
			const read = await readPersistentFile(dir);
			assert.equal(read.mode, "always");
			assert.equal(read.provider, "openai");
			assert.equal(read.modelId, "gpt-4o");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("returns empty when file does not exist", async () => {
		const dir = await mkdtemp(join(os.tmpdir(), "vp-test-"));
		try {
			const read = await readPersistentFile(dir);
			assert.deepEqual(read, {});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("returns empty for invalid JSON", async () => {
		const dir = await mkdtemp(join(os.tmpdir(), "vp-test-"));
		try {
			await writeFile(join(dir, "vision-proxy.json"), "not json");
			const read = await readPersistentFile(dir);
			assert.deepEqual(read, {});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveConfig with fileConfig", () => {
	it("layers fileConfig between defaults and session entries", () => {
		const entries: Entry[] = [];
		const fileConfig: Partial<VisionConfig> = { mode: "always", provider: "openai", modelId: "gpt-4o" };
		const cfg = resolveConfig(entries, {}, fileConfig);
		assert.equal(cfg.mode, "always");
		assert.equal(cfg.provider, "openai");
		assert.equal(cfg.modelId, "gpt-4o");
	});

	it("session entries override fileConfig", () => {
		const entries: Entry[] = [customEntry(CUSTOM_TYPE_CONFIG, { mode: "off" })];
		const fileConfig: Partial<VisionConfig> = { mode: "always" };
		const cfg = resolveConfig(entries, {}, fileConfig);
		assert.equal(cfg.mode, "off");
	});

	it("env overrides both file and session entries", () => {
		const entries: Entry[] = [customEntry(CUSTOM_TYPE_CONFIG, { mode: "off" })];
		const fileConfig: Partial<VisionConfig> = { mode: "always" };
		const cfg = resolveConfig(entries, { PI_VISION_PROXY_MODE: "fallback" }, fileConfig);
		assert.equal(cfg.mode, "fallback");
	});

	it("defaults fill in missing fileConfig fields", () => {
		const fileConfig: Partial<VisionConfig> = { mode: "off" };
		const cfg = resolveConfig([], {}, fileConfig);
		assert.equal(cfg.mode, "off");
		assert.equal(cfg.provider, DEFAULT_CONFIG.provider);
		assert.equal(cfg.modelId, DEFAULT_CONFIG.modelId);
		assert.equal(cfg.systemPrompt, DEFAULT_CONFIG.systemPrompt);
		assert.equal(cfg.includeContext, DEFAULT_CONFIG.includeContext);
	});
});

describe("fuzzyMatches", () => {
	it("matches when all query chars appear in order", () => {
		assert.equal(fuzzyMatches("Claude Sonnet 4.5", "cs4"), true);
		assert.equal(fuzzyMatches("Claude Opus 4.6", "op46"), true);
		assert.equal(fuzzyMatches("GPT-5.4 Pro", "g54"), true);
	});

	it("is case-insensitive", () => {
		assert.equal(fuzzyMatches("Claude Sonnet", "CLAUDE"), true);
		assert.equal(fuzzyMatches("gpt-4o", "GPT4O"), true);
	});

	it("rejects when chars are out of order or missing", () => {
		assert.equal(fuzzyMatches("Claude Sonnet 4.5", "4cs"), false);
		assert.equal(fuzzyMatches("GPT-5", "xyz"), false);
		assert.equal(fuzzyMatches("Gemini", "gpt"), false);
	});

	it("matches empty query against anything", () => {
		assert.equal(fuzzyMatches("anything", ""), true);
	});

	it("matches exact string", () => {
		assert.equal(fuzzyMatches("Claude Sonnet 4.5", "Claude Sonnet 4.5"), true);
	});

	it("matches partial name", () => {
		assert.equal(fuzzyMatches("Claude Opus 4.6 (EU)", "opus eu"), true);
		assert.equal(fuzzyMatches("Nova Premier", "nova"), true);
	});
});

// ── 1.4.0 tests ──────────────────────────────────────────────────────────

describe("isValidNamedRegion", () => {
	it("accepts valid region names", () => {
		for (const r of ["top-left", "bottom-right", "center", "top-half", "right"]) {
			assert.equal(isValidNamedRegion(r), true, r);
		}
	});

	it("rejects invalid names", () => {
		assert.equal(isValidNamedRegion("middle"), false);
		assert.equal(isValidNamedRegion(""), false);
		assert.equal(isValidNamedRegion("TOP-LEFT"), false); // case-sensitive
	});
});

describe("resolveRegion", () => {
	it("returns normalized rectangle for each region", () => {
		const tl = resolveRegion("top-left");
		assert.deepEqual(tl, { x: 0, y: 0, width: 0.5, height: 0.5 });

		const br = resolveRegion("bottom-right");
		assert.deepEqual(br, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 });

		const center = resolveRegion("center");
		assert.deepEqual(center, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
	});

	it("top-half aliases top", () => {
		assert.deepEqual(resolveRegion("top-half"), resolveRegion("top"));
	});
});

describe("normalizedToPixels", () => {
	it("converts normalized coordinates to pixels", () => {
		const result = normalizedToPixels({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, 1000, 1000);
		assert.ok(result);
		assert.equal(result!.x, 500);
		assert.equal(result!.y, 500);
		assert.equal(result!.width, 500);
		assert.equal(result!.height, 500);
	});

	it("clamps to image bounds", () => {
		// x=-0.5 clamped to 0, x+width=(-0.5+0.3)*100=-20 clamped to 0 → zero area → null
		const result = normalizedToPixels({ x: -0.5, y: 0.9, width: 0.3, height: 0.3 }, 100, 100);
		assert.equal(result, null, "negative x with small width should be null after clamp");

		// A valid clamped case
		const result2 = normalizedToPixels({ x: -0.1, y: 0.5, width: 0.8, height: 0.6 }, 100, 100);
		assert.ok(result2);
		assert.equal(result2!.x, 0);
		assert.equal(result2!.y, 50);
	});

	it("returns null for zero-area crop", () => {
		// Edge case: both x and x+width clamp to same value
		const result = normalizedToPixels({ x: 1.0, y: 0, width: 0, height: 0.5 }, 100, 100);
		assert.equal(result, null);
	});
});

describe("clampPixels", () => {
	it("clamps pixel coordinates to image bounds", () => {
		const result = clampPixels({ x: -10, y: 50, width: 200, height: 100 }, 100, 200);
		assert.ok(result);
		assert.equal(result!.x, 0);
		assert.equal(result!.y, 50);
		assert.equal(result!.width, 100);
		assert.equal(result!.height, 100);
	});

	it("returns null for zero-area after clamping", () => {
		const result = clampPixels({ x: 200, y: 200, width: 10, height: 10 }, 100, 100);
		assert.equal(result, null);
	});

	it("handles valid crop within bounds", () => {
		const result = clampPixels({ x: 10, y: 20, width: 30, height: 40 }, 100, 100);
		assert.ok(result);
		assert.deepEqual(result, { x: 10, y: 20, width: 30, height: 40 });
	});
});

describe("resolveCropEntry", () => {
	it("resolves region crop", () => {
		const result = resolveCropEntry({ image_index: 0, region: "top-left" }, 1000, 1000);
		assert.equal(result.x, 0);
		assert.equal(result.y, 0);
		assert.equal(result.width, 500);
		assert.equal(result.height, 500);
	});

	it("resolves normalized crop", () => {
		const result = resolveCropEntry(
			{ image_index: 0, normalized: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } },
			1000, 1000,
		);
		assert.equal(result.x, 250);
		assert.equal(result.y, 250);
		assert.equal(result.width, 500);
		assert.equal(result.height, 500);
	});

	it("resolves pixel crop", () => {
		const result = resolveCropEntry(
			{ image_index: 0, pixels: { x: 100, y: 200, width: 300, height: 400 } },
			1000, 1000,
		);
		assert.deepEqual(result, { x: 100, y: 200, width: 300, height: 400 });
	});

	it("clamps pixel crop to image bounds", () => {
		const result = resolveCropEntry(
			{ image_index: 0, pixels: { x: 900, y: 900, width: 200, height: 200 } },
			1000, 1000,
		);
		assert.equal(result.width, 100);
		assert.equal(result.height, 100);
	});

	it("throws for zero-area normalized crop", () => {
		assert.throws(
			() => resolveCropEntry({ image_index: 0, normalized: { x: 1.0, y: 1.0, width: 0, height: 0 } }, 100, 100),
			/zero area/,
		);
	});

	it("throws for zero-area pixel crop", () => {
		assert.throws(
			() => resolveCropEntry({ image_index: 0, pixels: { x: 200, y: 200, width: 10, height: 10 } }, 100, 100),
			/zero area/,
		);
	});
});

describe("cropSignature", () => {
	it("formats x,y,width,height", () => {
		assert.equal(cropSignature({ x: 10, y: 20, width: 30, height: 40 }), "10,20,30,40");
	});
});

describe("LRUCache", () => {
	it("stores and retrieves values", () => {
		const cache = new LRUCache<string, number>(3);
		cache.set("a", 1);
		assert.equal(cache.get("a"), 1);
	});

	it("evicts oldest when over capacity", () => {
		const cache = new LRUCache<string, number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3); // evicts "a"
		assert.equal(cache.get("a"), undefined);
		assert.equal(cache.get("b"), 2);
		assert.equal(cache.get("c"), 3);
	});

	it("renews entry on get", () => {
		const cache = new LRUCache<string, number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.get("a"); // "a" is now most recent
		cache.set("c", 3); // evicts "b" instead of "a"
		assert.equal(cache.get("a"), 1);
		assert.equal(cache.get("b"), undefined);
	});

	it("reports size", () => {
		const cache = new LRUCache<string, number>(10);
		assert.equal(cache.size, 0);
		cache.set("x", 1);
		assert.equal(cache.size, 1);
	});

	it("clear removes all entries", () => {
		const cache = new LRUCache<string, number>(10);
		cache.set("a", 1);
		cache.clear();
		assert.equal(cache.size, 0);
		assert.equal(cache.get("a"), undefined);
	});

	it("resize shrinks the cache and evicts excess", () => {
		const cache = new LRUCache<string, number>(5);
		for (let i = 0; i < 5; i++) cache.set(`k${i}`, i);
		assert.equal(cache.size, 5);
		cache.resize(2);
		assert.equal(cache.size, 2);
		assert.equal(cache.maxSize, 2);
		// Oldest entries should be evicted
		assert.equal(cache.get("k0"), undefined);
		assert.equal(cache.get("k1"), undefined);
		assert.equal(cache.get("k2"), undefined);
		// Newest should survive
		assert.equal(cache.get("k3"), 3);
		assert.equal(cache.get("k4"), 4);
	});

	it("resize to larger does not lose entries", () => {
		const cache = new LRUCache<string, number>(3);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.resize(10);
		assert.equal(cache.size, 2);
		assert.equal(cache.get("a"), 1);
		assert.equal(cache.get("b"), 2);
	});
});

describe("extractDimensions", () => {
	it("extracts dimensions from a PNG buffer", () => {
		// TINY_PNG is 1×1
		const dims = extractDimensions(TINY_PNG);
		assert.ok(dims, "should return dimensions for valid PNG");
		assert.equal(dims!.width, 1);
		assert.equal(dims!.height, 1);
	});

	it("returns undefined for invalid data", () => {
		const dims = extractDimensions(Buffer.from("not an image"));
		assert.equal(dims, undefined);
	});
});

describe("buildDescriptionFence", () => {
	it("builds fence with metadata attributes", () => {
		const fence = buildDescriptionFence("abc123", "A screenshot", { width: 1920, height: 1080, filename: "screen.png" });
		assert.ok(fence.startsWith("<vision_proxy_description"));
		assert.ok(fence.includes('image="abc123"'));
		assert.ok(fence.includes('width="1920"'));
		assert.ok(fence.includes('height="1080"'));
		assert.ok(fence.includes('filename="screen.png"'));
		assert.ok(fence.includes("A screenshot"));
		assert.ok(fence.endsWith("</vision_proxy_description>"));
	});

	it("includes crop_origin when cropped", () => {
		const fence = buildDescriptionFence("abc123", "Detail", { width: 3840, height: 2160 }, { x: 1840, y: 120, width: 840, height: 360 });
		assert.ok(fence.includes('#crop:1840,120,840,360'));
		assert.ok(fence.includes('crop_origin="1840,120"'));
		assert.ok(fence.includes('width="840"'));
		assert.ok(fence.includes('height="360"'));
	});
});

describe("buildAnalysisFence", () => {
	it("builds fence with grounding_format", () => {
		const fence = buildAnalysisFence("abc", "Analysis", { width: 100, height: 100 }, undefined, "qwen_pixels");
		assert.ok(fence.includes('grounding_format="qwen_pixels"'));
	});

	it("omits grounding_format when undefined", () => {
		const fence = buildAnalysisFence("abc", "Analysis", { width: 100, height: 100 });
		assert.ok(!fence.includes("grounding_format"));
	});
});

describe("fenceUntrusted (all three tags)", () => {
	it("neutralizes vision_proxy_analysis tags", () => {
		const out = fenceUntrusted('<vision_proxy_analysis>content</vision_proxy_analysis>');
		assert.ok(!out.includes("<vision_proxy_analysis>"));
		assert.ok(!out.includes("</vision_proxy_analysis>"));
	});

	it("neutralizes vision_proxy_joint_description tags", () => {
		const out = fenceUntrusted('<vision_proxy_joint_description>content</vision_proxy_joint_description>');
		assert.ok(!out.includes("<vision_proxy_joint_description>"));
	});

	it("neutralizes vision_proxy_description tags (unchanged)", () => {
		const out = fenceUntrusted('<vision_proxy_description>content</vision_proxy_description>');
		assert.ok(!out.includes("<vision_proxy_description>"));
	});

	it("neutralizes both < and > in tags", () => {
		const out = fenceUntrusted('<vision_proxy_description>test</vision_proxy_description>');
		// Neither raw < nor raw > should appear in the tag parts
		const tagMatch = out.match(/vision_proxy_description/g);
		assert.ok(tagMatch);
		// The opening bracket of each tag should be neutralized
		assert.ok(!out.includes("<vision_proxy"), "opening < should be neutralized");
		assert.ok(!out.includes("</vision_proxy"), "closing < should be neutralized");
	});

	it("neutralizes tags with trailing whitespace", () => {
		const out = fenceUntrusted('</vision_proxy_description >');
		assert.ok(!out.includes("</vision_proxy_description >"), "closing tag with space should be neutralized");
	});

	it("neutralizes tags with attributes", () => {
		const out = fenceUntrusted('<vision_proxy_description image="abc" >');
		assert.ok(!out.includes("<vision_proxy_description"), "opening tag with attrs should be neutralized");
	});
});

describe("escapeAttr", () => {
	it("escapes double quotes", () => {
		assert.equal(escapeAttr('file"name.png'), "file&quot;name.png");
	});

	it("escapes angle brackets", () => {
		assert.equal(escapeAttr("a<b>c"), "a&lt;b&gt;c");
	});

	it("escapes ampersands", () => {
		assert.equal(escapeAttr("a&b"), "a&amp;b");

	});

	it("leaves safe characters intact", () => {
		assert.equal(escapeAttr("photo.png"), "photo.png");
	});

	it("handles empty string", () => {
		assert.equal(escapeAttr(""), "");
	});
});

describe("getGroundingFormat", () => {
	it("returns format for known model", () => {
		const fmt = getGroundingFormat(DEFAULT_CONFIG, "Qwen", "Qwen2.5-VL-7B-Instruct");
		assert.equal(fmt, "qwen_pixels");
	});

	it("returns 'none' for unknown model", () => {
		const fmt = getGroundingFormat(DEFAULT_CONFIG, "anthropic", "claude-sonnet-4-5");
		assert.equal(fmt, "none");
	});
});

describe("readEnvOverrides (1.4.0 fields)", () => {
	it("reads PI_VISION_PROXY_TOOL", () => {
		assert.equal(readEnvOverrides({ PI_VISION_PROXY_TOOL: "on" }).tool, "on");
		assert.equal(readEnvOverrides({ PI_VISION_PROXY_TOOL: "off" }).tool, "off");
		assert.equal(readEnvOverrides({ PI_VISION_PROXY_TOOL: "bogus" }).tool, undefined);
	});

	it("reads PI_VISION_PROXY_MAX_IMAGES_PER_CALL", () => {
		assert.equal(readEnvOverrides({ PI_VISION_PROXY_MAX_IMAGES_PER_CALL: "5" }).maxImagesPerCall, 5);
		assert.equal(readEnvOverrides({ PI_VISION_PROXY_MAX_IMAGES_PER_CALL: "0" }).maxImagesPerCall, undefined);
		assert.equal(readEnvOverrides({ PI_VISION_PROXY_MAX_IMAGES_PER_CALL: "21" }).maxImagesPerCall, undefined);
	});

	it("reads PI_VISION_PROXY_MAX_BATCH", () => {
		assert.equal(readEnvOverrides({ PI_VISION_PROXY_MAX_BATCH: "3" }).maxBatch, 3);
		assert.equal(readEnvOverrides({ PI_VISION_PROXY_MAX_BATCH: "0" }).maxBatch, undefined);
	});

	it("reads PI_VISION_PROXY_CACHE_SIZE", () => {
		assert.equal(readEnvOverrides({ PI_VISION_PROXY_CACHE_SIZE: "100" }).cacheSize, 100);
		assert.equal(readEnvOverrides({ PI_VISION_PROXY_CACHE_SIZE: "501" }).cacheSize, undefined);
	});

	it("reads PI_VISION_PROXY_PHASH_THRESHOLD", () => {
		assert.equal(readEnvOverrides({ PI_VISION_PROXY_PHASH_THRESHOLD: "0.9" }).pHashSimilarityThreshold, 0.9);
		assert.equal(readEnvOverrides({ PI_VISION_PROXY_PHASH_THRESHOLD: "1.5" }).pHashSimilarityThreshold, undefined);
	});
});

describe("sanitize (1.4.0 fields)", () => {
	it("defaults new fields when missing", () => {
		const result = sanitize({
			mode: "fallback",
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
			systemPrompt: "test",
			includeContext: true,
		} as VisionConfig);
		assert.equal(result.tool, "off");
		assert.equal(result.maxImagesPerCall, 10);
		assert.equal(result.maxBatch, 1);
		assert.equal(result.cacheSize, 50);
		assert.equal(result.pHashSimilarityThreshold, 0.8);
		assert.ok(result.groundingModels);
	});

	it("validates maxImagesPerCall range", () => {
		const bad = sanitize({ ...DEFAULT_CONFIG, maxImagesPerCall: 0 });
		assert.equal(bad.maxImagesPerCall, 10); // reset to default
		const good = sanitize({ ...DEFAULT_CONFIG, maxImagesPerCall: 15 });
		assert.equal(good.maxImagesPerCall, 15);
	});
});

describe("readImageFileWithReason (basename)", () => {
	it("returns filename (basename)", async () => {
		const dir = await mkdtemp(join(os.tmpdir(), "vp-test-"));
		const file = join(dir, "test-image.png");
		await writeFile(file, TINY_PNG);
		try {
			const r = await readImageFileWithReason(file);
			assert.equal(r.filename, "test-image.png");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
