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
	CUSTOM_TYPE_CONFIG,
	CUSTOM_TYPE_CONSENT,
	CUSTOM_TYPE_DESCRIPTION,
	DEFAULT_CONFIG,
	envFlags,
	extractCandidateImagePaths,
	fenceUntrusted,
	findDescriptions,
	hasConsent,
	hashImageData,
	IMAGE_PATH_PLACEHOLDER,
	isPathAllowed,
	parseModelString,
	pluralImages,
	readEnvOverrides,
	readImageFileWithReason,
	readPersistentFile,
	resolveConfig,
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
		};
		assert.deepEqual(sanitize(cfg), cfg);
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
		assert.deepEqual(envFlags({}), { mode: false, model: false, context: false });
		assert.deepEqual(
			envFlags({
				PI_VISION_PROXY_MODE: "x",
				PI_VISION_PROXY_MODEL: "y",
				PI_VISION_PROXY_INCLUDE_CONTEXT: "",
			}),
			{ mode: true, model: true, context: true },
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
