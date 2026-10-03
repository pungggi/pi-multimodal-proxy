/**
 * Unit tests for the tool-transcript rendering helpers (1.21.0).
 *
 * These back the pi ≥ 1.0.1 registerToolRenderer() integration: compact
 * analyze_image / generate_image call and result lines. Pure data in, plain
 * segments out — theming happens in vision-proxy.ts.
 *
 * Run:
 *   node --experimental-strip-types --test extensions/__tests__/tool-render.test.ts
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	analyzeDetailsForTranscript,
	formatAnalyzeImageCall,
	formatAnalyzeImageResult,
	formatGenerateImageCall,
	formatGenerateImageResult,
	summarizeCrop,
	summarizeForTranscript,
	summarizeImageRef,
} from "../internal.ts";

const HASH32 = "deadbeefdeadbeefdeadbeefdeadbeef";

function plain(segments: ReadonlyArray<{ text: string }>): string {
	return segments.map((s) => s.text).join("");
}

describe("summarizeForTranscript", () => {
	it("passes short text through with collapsed whitespace", () => {
		assert.equal(summarizeForTranscript("  hello   world\n\tnext  ", 50), "hello world next");
	});

	it("truncates long text on a word boundary", () => {
		const out = summarizeForTranscript("alpha bravo charlie delta echo foxtrot golf hotel", 20);
		assert.ok(out.length <= 20, `length ${out.length}: ${out}`);
		assert.ok(out.endsWith("…"));
		assert.ok(!out.endsWith(" …"), "no dangling space before ellipsis");
	});

	it("never splits a surrogate pair", () => {
		const emoji = "😀".repeat(60); // each emoji is a surrogate pair
		const out = summarizeForTranscript(emoji, 20); // odd max → cut lands mid-pair
		assert.ok(out.length <= 20);
		// No lone high surrogate anywhere: the string still round-trips as text.
		// (With the guard removed, the hard cut leaves an unpaired high surrogate
		// right before the ellipsis, which this regex detects.)
		assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out));
	});
});

describe("summarizeImageRef", () => {
	it("shortens a quoted recall reference", () => {
		assert.equal(summarizeImageRef(`image="${HASH32}"`), `image="deadbeef…"`);
	});

	it("shortens an unquoted recall reference and sha256:/#crop forms", () => {
		assert.equal(summarizeImageRef(`image=${HASH32}`), `image="deadbeef…"`);
		assert.equal(summarizeImageRef(`sha256:${HASH32}#x0y0`), `image="deadbeef…"`);
		assert.equal(summarizeImageRef(HASH32), `image="deadbeef…"`);
	});

	it("reduces file paths to the file name (posix + windows)", () => {
		assert.equal(summarizeImageRef("/home/u/pics/cat.png"), "cat.png");
		assert.equal(summarizeImageRef("D:\\Users\\u\\Downloads\\shot (1).jpg"), "shot (1).jpg");
	});

	it("truncates very long file names", () => {
		const long = "a".repeat(120) + ".png";
		const out = summarizeImageRef(long);
		assert.ok(out.length <= 48);
		assert.ok(out.endsWith("…"));
	});

	it("leaves non-hash short junk as-is", () => {
		assert.equal(summarizeImageRef("not-a-hash"), "not-a-hash");
	});
});

describe("summarizeCrop", () => {
	it("renders named regions with the image index", () => {
		assert.equal(summarizeCrop({ image_index: 0, region: "bottom-right" }), "bottom-right@0");
	});

	it("renders normalized crops as percentages", () => {
		assert.equal(
			summarizeCrop({ image_index: 1, normalized: { x: 0.25, y: 0.133, width: 0.5, height: 0.5 } }),
			"25%,13.3% 50%×50%@1",
		);
	});

	it("renders pixel crops rounded", () => {
		assert.equal(
			summarizeCrop({ image_index: 0, pixels: { x: 128.4, y: 64.2, width: 256, height: 256 } }),
			"128,64 256×256@0",
		);
	});

	it("returns empty for unrecognized input", () => {
		assert.equal(summarizeCrop(undefined), "");
		assert.equal(summarizeCrop("nonsense"), "");
		assert.equal(summarizeCrop({ image_index: 0 }), "crop@0");
	});
});

describe("formatAnalyzeImageCall", () => {
	it("builds a full call line", () => {
		const segs = formatAnalyzeImageCall({
			images: [`image="${HASH32}"`, "/tmp/chart.png"],
			question: "What does the legend say?",
			crop: [{ image_index: 0, region: "center" }],
			model: "zai/glm-5.3-flash",
		});
		assert.equal(
			plain(segs),
			`"What does the legend say?" · 2 images (image="deadbeef…", chart.png) · crop center@0 · zai/glm-5.3-flash`,
		);
		assert.equal(segs[0]!.style, "accent");
	});

	it("collapses many images to two shown plus a count", () => {
		const segs = formatAnalyzeImageCall({
			images: ["/a.png", "/b.png", "/c.png", "/d.png"],
			question: "q",
		});
		assert.ok(plain(segs).includes("4 images (a.png, b.png +2)"));
	});

	it("summarizes multiple crops as a count", () => {
		const segs = formatAnalyzeImageCall({
			images: ["/a.png", "/b.png"],
			question: "q",
			crop: [
				{ image_index: 0, region: "top" },
				{ image_index: 1, region: "bottom" },
			],
		});
		assert.ok(plain(segs).includes("crops ×2"));
	});

	it("truncates long questions and tolerates garbage args", () => {
		const long = formatAnalyzeImageCall({ images: ["/a.png"], question: "x".repeat(300) });
		assert.ok(plain(long).length < 200);

		assert.deepEqual(formatAnalyzeImageCall("junk"), [{ text: '"junk"', style: "muted" }]);
		assert.deepEqual(formatAnalyzeImageCall(null), [{ text: "null", style: "muted" }]);
	});

	it("handles missing question/images defensively", () => {
		const segs = formatAnalyzeImageCall({});
		assert.equal(plain(segs), '""');
	});
});

describe("formatGenerateImageCall", () => {
	it("builds prompt + model line", () => {
		const segs = formatGenerateImageCall({ prompt: "A red panda astronaut, watercolor", model: "google/imagen-4" });
		assert.equal(plain(segs), '"A red panda astronaut, watercolor" · google/imagen-4');
	});

	it("prompt-only line and garbage fallback", () => {
		assert.equal(plain(formatGenerateImageCall({ prompt: "cat" })), '"cat"');
		assert.deepEqual(formatGenerateImageCall(42), [{ text: "42", style: "muted" }]);
	});
});

describe("formatAnalyzeImageResult", () => {
	it("summarizes a successful analysis", () => {
		const segs = formatAnalyzeImageResult(
			{ ok: true, provider: "zai", model: "glm-5.3-flash", cached: true, latencyMs: 1234 },
			false,
		);
		assert.equal(plain(segs), "✓ zai/glm-5.3-flash · cached · 1.2s");
	});

	it("summarizes without optional fields and with model only", () => {
		assert.equal(plain(formatAnalyzeImageResult({ ok: true }, false)), "✓");
		assert.equal(plain(formatAnalyzeImageResult({ ok: true, model: "glm-5.3-flash" }, false)), "✓ glm-5.3-flash");
	});

	it("renders errors from details, isError flag, or a generic fallback", () => {
		assert.equal(
			plain(formatAnalyzeImageResult({ ok: false, error: "Error: consent required" }, true)),
			"✗ Error: consent required",
		);
		// isError without details
		assert.equal(plain(formatAnalyzeImageResult(undefined, true)), "✗ analysis failed");
		// ok:false wins even without the flag (older rows)
		assert.equal(plain(formatAnalyzeImageResult({ ok: false }, false)), "✗ analysis failed");
	});

	it("marks the summary segment styles", () => {
		const segs = formatAnalyzeImageResult({ ok: true, provider: "zai", model: "m" }, false);
		assert.equal(segs[0]!.style, "success");
		assert.equal(segs[1]!.style, "muted");
	});
});

describe("formatGenerateImageResult", () => {
	it("summarizes generation with images, cost, and first id", () => {
		const segs = formatGenerateImageResult(
			{
				ok: true,
				provider: "google",
				model: "imagen-4",
				images: [
					{ id: HASH32, mimeType: "image/png", width: 1024, height: 768 },
					{ id: "f".repeat(32), mimeType: "image/png", width: 1024, height: 768 },
				],
				costUSD: 0.0311,
			},
			false,
		);
		assert.equal(plain(segs), `✓ 2 images via google/imagen-4 · $0.0311 · image="deadbeef…" +1`);
	});

	it("renders errors from details or generically", () => {
		assert.equal(
			plain(formatGenerateImageResult({ ok: false, error: "Error: no keyed image model" }, true)),
			"✗ Error: no keyed image model",
		);
		assert.equal(plain(formatGenerateImageResult(undefined, true)), "✗ generation failed");
	});

	it("falls back to 'done' when details carry no image list", () => {
		assert.equal(plain(formatGenerateImageResult({ ok: true, provider: "google", model: "imagen-4" }, false)), "✓ done via google/imagen-4");
	});
});

describe("analyzeDetailsForTranscript", () => {
	it("strips text and images but keeps display fields", () => {
		const out = analyzeDetailsForTranscript({
			ok: true,
			text: "a".repeat(2000),
			images: [{ id: HASH32 }],
			provider: "zai",
			model: "glm-5.3-flash",
			latencyMs: 120,
		});
		assert.deepEqual(out, { ok: true, provider: "zai", model: "glm-5.3-flash", latencyMs: 120 });
	});

	it("does not mutate the input", () => {
		const input = { ok: true, text: "keep-me", images: [1, 2] };
		analyzeDetailsForTranscript(input);
		assert.deepEqual(input, { ok: true, text: "keep-me", images: [1, 2] });
	});
});
