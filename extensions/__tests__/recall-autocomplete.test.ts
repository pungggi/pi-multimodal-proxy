import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyRecallCompletion,
	buildRecallItems,
	collectRecallCandidates,
	extractRecallToken,
	parseRecallItemValue,
	RECALL_AC_MAX_ITEMS,
	RECALL_AC_VALUE_PREFIX,
	type RecallCandidate,
} from "../internal.ts";

describe("extractRecallToken", () => {
	it("matches a bare # at the start of the line", () => {
		assert.deepEqual(extractRecallToken(["#"], 0, 1), { query: "", prefix: "#" });
	});

	it("matches a # token after leading whitespace (pi #10218 mirror)", () => {
		// Pi 1.0 fixed slash-command autocomplete not triggering when the input
		// starts with whitespace; the # recall provider must behave the same.
		assert.deepEqual(extractRecallToken(["  #shot"], 0, 7), {
			query: "shot",
			prefix: "#shot",
		});
		assert.deepEqual(extractRecallToken(["   #"], 0, 4), { query: "", prefix: "#" });
	});

	it("matches a # token after whitespace with a partial query", () => {
		assert.deepEqual(extractRecallToken(["zoom into #shot"], 0, 15), {
			query: "shot",
			prefix: "#shot",
		});
	});

	it("only considers text before the cursor", () => {
		assert.deepEqual(extractRecallToken(["#abc tail"], 0, 4), { query: "abc", prefix: "#abc" });
	});

	it("returns null mid-word (no token boundary)", () => {
		assert.equal(extractRecallToken(["issue#42"], 0, 8), null);
	});

	it("returns null when the cursor is not in a # token", () => {
		assert.equal(extractRecallToken(["plain text"], 0, 5), null);
		assert.equal(extractRecallToken(["# spaced"], 0, 8), null);
	});

	it("uses the cursor line in multi-line input", () => {
		assert.deepEqual(extractRecallToken(["first", "see #x"], 1, 6), { query: "x", prefix: "#x" });
	});
});

describe("collectRecallCandidates", () => {
	it("orders newest first and attaches in-memory filenames", () => {
		const descriptions = new Map([
			["h1", "first image"],
			["h2", "second image"],
		]);
		const meta = new Map([["h2", { width: 1, height: 1, filename: "b.png" }]]);
		const out = collectRecallCandidates(descriptions, (h) => meta.get(h));
		assert.deepEqual(out, [
			{ hash: "h2", description: "second image", filename: "b.png" },
			{ hash: "h1", description: "first image", filename: undefined },
		]);
	});
});

describe("buildRecallItems", () => {
	const candidates: RecallCandidate[] = [
		{ hash: "a".repeat(32), filename: "screenshot.png", description: "a login form" },
		{ hash: "b".repeat(32), description: "an error dialog with a stack trace" },
	];

	it("lists all candidates for an empty query", () => {
		const items = buildRecallItems(candidates, "");
		assert.equal(items.length, 2);
		assert.equal(items[0]!.value, `${RECALL_AC_VALUE_PREFIX}${"a".repeat(32)}`);
		assert.equal(items[0]!.label, "screenshot.png");
		assert.equal(items[1]!.label, `${"b".repeat(12)}…`);
	});

	it("fuzzy-matches filename and description", () => {
		assert.equal(buildRecallItems(candidates, "shot")[0]!.label, "screenshot.png");
		const byDesc = buildRecallItems(candidates, "stack trace");
		assert.equal(byDesc.length, 1);
		assert.ok(byDesc[0]!.value.endsWith("b".repeat(32)));
		assert.equal(buildRecallItems(candidates, "zzz-no-match").length, 0);
	});

	it("matches the hash by prefix only, not by fuzzy subsequence", () => {
		// "b" is a prefix of the second hash but no subsequence match on the
		// first candidate's filename/description — hex letters must not match
		// every image via the 32-hex hash.
		const byPrefix = buildRecallItems(candidates, "bbbb");
		assert.equal(byPrefix.length, 1);
		assert.ok(byPrefix[0]!.value.endsWith("b".repeat(32)));
		const q = buildRecallItems(candidates, "eeee");
		assert.equal(q.length, 0, "hex query matching no prefix and no text must return nothing");
	});

	it("truncates dropdown descriptions to a single short line", () => {
		const long = [{ hash: "c".repeat(32), description: `x${"y z".repeat(80)}` }];
		const item = buildRecallItems(long, "")[0]!;
		assert.ok(item.description!.length <= 61);
		assert.ok(item.description!.endsWith("…"));
	});

	it("caps the item count", () => {
		const many: RecallCandidate[] = Array.from({ length: RECALL_AC_MAX_ITEMS + 5 }, (_, i) => ({
			hash: `${i}`.padStart(32, "0"),
			description: `img ${i}`,
		}));
		assert.equal(buildRecallItems(many, "").length, RECALL_AC_MAX_ITEMS);
	});
});

describe("parseRecallItemValue", () => {
	it("round-trips recall values and rejects foreign ones", () => {
		assert.equal(parseRecallItemValue(`${RECALL_AC_VALUE_PREFIX}deadbeef`), "deadbeef");
		assert.equal(parseRecallItemValue("/some/file.png"), null);
		assert.equal(parseRecallItemValue("deadbeef"), null);
	});
});

describe("applyRecallCompletion", () => {
	const hash = "f".repeat(32);

	it("replaces the # token with the fence-style id and moves the cursor", () => {
		const out = applyRecallCompletion(["zoom into #shot"], 0, 15, hash, "#shot");
		assert.equal(out.lines[0], `zoom into image="${hash}" `);
		assert.equal(out.cursorLine, 0);
		assert.equal(out.cursorCol, out.lines[0]!.length);
	});

	it("preserves text after the cursor", () => {
		const out = applyRecallCompletion(["#ab and crop it"], 0, 3, hash, "#ab");
		assert.equal(out.lines[0], `image="${hash}"  and crop it`);
		assert.equal(out.cursorCol, `image="${hash}" `.length);
	});

	it("only touches the cursor line", () => {
		const out = applyRecallCompletion(["keep", "#x"], 1, 2, hash, "#x");
		assert.equal(out.lines[0], "keep");
		assert.equal(out.lines[1], `image="${hash}" `);
	});
});
