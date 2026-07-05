import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildCompactionDigest,
	CUSTOM_TYPE_DESCRIPTION,
	CUSTOM_TYPE_VIDEO_DESCRIPTION,
	DIGEST_IMAGE_CHARS,
	DIGEST_LEAN_IMAGE_CHARS,
	DIGEST_MAX_IMAGES,
	findDescriptions,
	findVideoDescriptions,
	truncateForDigest,
	type VideoDescriptionEntry,
} from "../internal.ts";

// SessionEntry minimal shape — typed loose because peer dep types are not loaded in test
type Entry = any;

const customEntry = (customType: string, data: unknown): Entry => ({
	type: "custom",
	customType,
	data,
});

const video = (hash: string, description = `video ${hash}`): VideoDescriptionEntry => ({
	hash,
	filename: `${hash}.mp4`,
	mimeType: "video/mp4",
	description,
});

describe("findVideoDescriptions", () => {
	it("collects hash → entry from video description entries", () => {
		const entries: Entry[] = [
			customEntry(CUSTOM_TYPE_VIDEO_DESCRIPTION, video("v1")),
			customEntry(CUSTOM_TYPE_DESCRIPTION, { hash: "img", description: "not a video" }),
			customEntry(CUSTOM_TYPE_VIDEO_DESCRIPTION, { hash: "", description: "skip" }),
			customEntry(CUSTOM_TYPE_VIDEO_DESCRIPTION, video("v2")),
		];
		const map = findVideoDescriptions(entries);
		assert.equal(map.size, 2);
		assert.equal(map.get("v1")?.filename, "v1.mp4");
		assert.equal(map.get("v2")?.mimeType, "video/mp4");
	});

	it("keeps the most recent entry per hash", () => {
		const entries: Entry[] = [
			customEntry(CUSTOM_TYPE_VIDEO_DESCRIPTION, video("v1", "old")),
			customEntry(CUSTOM_TYPE_VIDEO_DESCRIPTION, video("v1", "new")),
		];
		assert.equal(findVideoDescriptions(entries).get("v1")?.description, "new");
	});

	it("moves a re-described hash to the end of the iteration order", () => {
		const entries: Entry[] = [
			customEntry(CUSTOM_TYPE_VIDEO_DESCRIPTION, video("v1", "first")),
			customEntry(CUSTOM_TYPE_VIDEO_DESCRIPTION, video("v2", "second")),
			customEntry(CUSTOM_TYPE_VIDEO_DESCRIPTION, video("v1", "updated")),
		];
		assert.deepEqual([...findVideoDescriptions(entries).keys()], ["v2", "v1"]);
	});

	it("backfills filename and mimeType on malformed entries instead of crashing later", () => {
		const entries: Entry[] = [
			customEntry(CUSTOM_TYPE_VIDEO_DESCRIPTION, { hash: "v1", description: "d" }),
			customEntry(CUSTOM_TYPE_VIDEO_DESCRIPTION, { hash: "v2", description: "d", filename: 42, mimeType: null }),
		];
		const map = findVideoDescriptions(entries);
		assert.equal(map.get("v1")?.filename, "unknown");
		assert.equal(map.get("v1")?.mimeType, "application/octet-stream");
		assert.equal(map.get("v2")?.filename, "unknown");
		assert.equal(map.get("v2")?.mimeType, "application/octet-stream");
		// The digest builder accepts the backfilled entries without throwing.
		const digest = buildCompactionDigest([], [...map.values()]);
		assert.ok(digest.includes('file="unknown"'));
	});
});

describe("findDescriptions ordering", () => {
	it("moves a re-described hash to the end of the iteration order", () => {
		const entries: Entry[] = [
			customEntry(CUSTOM_TYPE_DESCRIPTION, { hash: "a", description: "first" }),
			customEntry(CUSTOM_TYPE_DESCRIPTION, { hash: "b", description: "second" }),
			customEntry(CUSTOM_TYPE_DESCRIPTION, { hash: "a", description: "updated" }),
		];
		const map = findDescriptions(entries);
		assert.deepEqual([...map.keys()], ["b", "a"]);
		assert.equal(map.get("a"), "updated");
	});
});

describe("truncateForDigest", () => {
	it("returns short text unchanged", () => {
		assert.equal(truncateForDigest("short text", 100), "short text");
	});

	it("trims surrounding whitespace", () => {
		assert.equal(truncateForDigest("  padded  ", 100), "padded");
	});

	it("cuts long text at a word boundary and marks the truncation", () => {
		// slice(0,20) is "alpha beta gamma del"; the boundary cut must drop "del".
		const out = truncateForDigest("alpha beta gamma delta epsilon", 20);
		assert.equal(out, "alpha beta gamma … [truncated]");
	});

	it("hard-cuts when there is no usable word boundary", () => {
		const out = truncateForDigest("a".repeat(50), 20);
		assert.equal(out, `${"a".repeat(20)} … [truncated]`);
	});
});

describe("buildCompactionDigest", () => {
	it("returns empty string when there is nothing to restore", () => {
		assert.equal(buildCompactionDigest([], []), "");
	});

	it("restores image fences with id, meta, and untrusted warning", () => {
		const digest = buildCompactionDigest(
			[{ hash: "hash-a", description: "a red square", meta: { width: 10, height: 20, filename: "sq.png" } }],
			[],
		);
		assert.ok(digest.includes("post-compaction recall"));
		assert.ok(digest.includes('image="hash-a"'));
		assert.ok(digest.includes('width="10"'));
		assert.ok(digest.includes('filename="sq.png"'));
		assert.ok(digest.includes("a red square"));
		assert.ok(digest.includes("UNTRUSTED"));
	});

	it("includes video fences", () => {
		const digest = buildCompactionDigest([], [video("v9", "a talking head")]);
		assert.ok(digest.includes('hash="v9"'));
		assert.ok(digest.includes('file="v9.mp4"'));
		assert.ok(digest.includes("a talking head"));
		assert.ok(digest.includes("1 video/audio file"));
	});

	it("mentions analyze_image recall only when the tool is enabled", () => {
		const imgs = [{ hash: "h", description: "d" }];
		assert.ok(buildCompactionDigest(imgs, [], { toolEnabled: true }).includes("analyze_image"));
		assert.ok(!buildCompactionDigest(imgs, [], { toolEnabled: false }).includes("analyze_image"));
	});

	it("keeps only the most recent images when over the cap", () => {
		const imgs = Array.from({ length: DIGEST_MAX_IMAGES + 3 }, (_, i) => ({
			hash: `h${i}`,
			description: `d${i}`,
		}));
		const digest = buildCompactionDigest(imgs, []);
		assert.ok(!digest.includes('image="h0"'), "oldest images dropped");
		assert.ok(!digest.includes('image="h2"'));
		assert.ok(digest.includes('image="h3"'));
		assert.ok(digest.includes(`image="h${DIGEST_MAX_IMAGES + 2}"`));
	});

	it("applies tighter budgets in lean mode", () => {
		const long = "word ".repeat(400);
		const [full] = buildCompactionDigest([{ hash: "h", description: long }], [])
			.split("\n\n")
			.slice(1);
		const [lean] = buildCompactionDigest([{ hash: "h", description: long }], [], { lean: true })
			.split("\n\n")
			.slice(1);
		assert.ok(full!.length > lean!.length);
		assert.ok(lean!.length < DIGEST_LEAN_IMAGE_CHARS + 200);
		assert.ok(full!.length < DIGEST_IMAGE_CHARS + 200);
	});

	it("counts both media kinds in the header", () => {
		const digest = buildCompactionDigest(
			[
				{ hash: "a", description: "d1" },
				{ hash: "b", description: "d2" },
			],
			[video("v1"), video("v2")],
		);
		assert.ok(digest.includes("2 images and 2 video/audio files"));
	});
});
