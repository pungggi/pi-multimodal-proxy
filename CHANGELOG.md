# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.9.0] - 2026-07-07

### Added

- **Pre-consented providers** ([#14](https://github.com/pungggi/pi-multimodal-proxy/issues/14)) — a persisted `allowedProviders` list lets you consent to data egress for chosen providers once, instead of once per session. Providers on the list skip the first-use consent prompt everywhere (auto-proxy, video/audio, the `analyze_image` tool, and `/multimodal-proxy describe`). Manage it with `/multimodal-proxy allowed-providers add|remove <provider>|clear` (or the interactive config menu), or grant-and-persist in one step with `/multimodal-proxy consent always`. The list lives in `~/.pi/agent/multimodal-proxy.json` next to the other persisted settings and is kept out of session-entry configs so per-session config changes can never clobber it.
- **New env var**: `PI_VISION_PROXY_ALLOWED_PROVIDERS` — comma-separated provider ids, overriding the persisted list (a defined-but-empty value disables the list for that shell/project, handy for sensitive repositories).
- Safety semantics: an explicit in-session `/multimodal-proxy consent no` always beats the pre-consent list, and additionally removes the provider from the persisted list so the refusal sticks across sessions. The list only ever matches a specific provider — it is never a blanket grant. Provider ids are validated and canonicalized (`x-ai` → `xai`) on every boundary (file, env, commands).
- New tested helpers in `internal.ts`: `parseProviderList` (comma/whitespace splitting, canonicalization, dedup) and `consentState` (distinguishes "revoked" from "no verdict" so pre-consent can't override a refusal); `hasConsent` gained an optional `allowedProviders` parameter.

## [1.8.0] - 2026-07-04

### Added

- **Compaction survival** — media knowledge now survives context compaction. Previously, compaction summarized away the user messages carrying image blocks (and the injected video fences), so the `context` handler had nothing left to annotate and the agent lost all knowledge of earlier images/videos — even though the description entries were still persisted in the session. Now, when the active branch contains a compaction entry, the proxy detects which persisted image/video descriptions are no longer visible in context and re-injects them as a **post-compaction recall digest**: truncated description fences keyed by the same stable `image="..."` ids that `analyze_image` recall accepts, placed directly after the compaction summary.
- **Compaction-trigger awareness** (Pi ≥ 0.79.10) — a `session_compact` handler records the compaction's `reason`/`willRetry` metadata. During the **overflow-recovery** window (context hit the hard limit and the turn is retried), the digest switches to lean budgets (200/240 chars per image/video instead of 600/800) so re-injection doesn't contribute to a second overflow; `turn_end` closes the window so later turns get normal budgets again. On older Pi runtimes the fields are absent and the digest simply uses its normal budgets.
- New helpers in `internal.ts`, all covered by unit tests: `findVideoDescriptions` (latest persisted entry per hash), `truncateForDigest` (word-boundary truncation with `… [truncated]` marker), and `buildCompactionDigest` (caps at the 12 most recent images / 4 most recent videos, restates the UNTRUSTED warning, and mentions `analyze_image` recall only when the tool is enabled).
- **`#` image-recall autocomplete** (Pi ≥ 0.79.1) — typing `#` at a token boundary in the interactive editor now suggests images seen earlier in the session (newest first, fuzzy-matched on filename, id, and description as you type). Picking one inserts the image's stable `image="<hash>"` recall id into the prompt, so *"zoom into `#`⇥"* works without copying ids out of fences. Implemented as a stacked autocomplete provider via `ctx.ui.addAutocompleteProvider`: it falls through to the built-in provider when the token matches no image, is a no-op in RPC/print modes and on older Pi versions without the API, and suggests nothing when the proxy is `off`. New tested helpers: `extractRecallToken`, `collectRecallCandidates`, `buildRecallItems` (max 8 items), `parseRecallItemValue`, `applyRecallCompletion`.

### Changed

- **Default vision model bumped to Claude Sonnet 5** (`anthropic/claude-sonnet-5`, in Pi catalogs since 0.80.3), with default-tracking for implicit configs: explicit model choices are now persisted with a `modelExplicit` flag (`/multimodal-proxy model` and `pick`), and only *implicit* model values participate in substitution. An implicit legacy baked-in default (`claude-sonnet-4-5`, which full-config persistence wrote into every config on any settings change) is upgraded to the current default when the registry has it, and the current default falls back to `claude-sonnet-4-5` on older Pi catalogs. Explicit choices (via the flag or `PI_VISION_PROXY_MODEL`) are never rewritten — a missing explicit model still surfaces as "Model not found". The registry-resolved model is applied consistently at image analysis, the `analyze_image` tool, `/multimodal-proxy describe`, the status line, and the interactive config menu.
- The `context` handler no longer returns early when the active model supports images natively — the post-compaction digest is injected whenever the proxy is not `off` and orphaned descriptions exist, since natively-visioned models also lose compacted-away images. Image-block stripping behavior is unchanged.

## [1.7.0] - 2026-06-20

### Added

- **Session image recall** — the agent can now re-query an image it saw earlier in the session without a re-attachment or file path. Every `<vision_proxy_description>`, `<vision_proxy_analysis>`, and `<vision_proxy_joint_description>` block already carries an `image="..."` id; passing that id back to `analyze_image` (or `/multimodal-proxy describe`) recalls the original image bytes and re-runs the targeted question or crop against it (e.g. *"zoom into that screenshot from before"*).
- Image bytes are retained **in process memory only** — never written to the session log or disk — in a byte-bounded LRU store (`PI_VISION_PROXY_IMAGE_RECALL_BYTES`, default 64 MB, oldest-first eviction).
- **New env var**: `PI_VISION_PROXY_IMAGE_RECALL_BYTES`.
- **Persistent recall reminder** — when the proxy rewrites earlier images into descriptions, it now restates once per turn (as trusted text, outside the untrusted fence) that those images can be re-queried by id, so the affordance is visible even on turns where no new image was attached.
- **Live progress indicator** — slow image and video/audio analysis now animate a spinner with elapsed seconds on the status line (`multimodal-proxy ⠙ Analyzing image 2/4… (3s)`), restoring the steady-state status when the call completes. No-ops without a UI.
- Unit tests for `parseRecallRef` (bare hash, `sha256:` prefix, `#crop` suffix, case normalization, path rejection), the recall store (round-trip, dedup, byte-budget eviction, oversized-single-image retention, recency bumping), `spinnerFrame`, `formatProgressStatus`, and `RECALL_HINT`.

### Changed

- `analyze_image` now accepts a recall handle (the fence `image="..."` id) as an image reference in addition to a file path; the previous hard rejection of `sha256:` references is removed. The tool schema, tool description, and the injected Vision Proxy system-prompt section document the recall handle.

## [1.4.0-beta.1] - 2026-05-03

### Added

- **`analyze_image` tool** — agent-facing tool for targeted re-querying of images with multi-form crop support (FR-1.x). Disabled by default during beta; enable with `/vision-proxy tool on`.
- **Three crop forms**: `region` (named areas like `top-right`, `center`), `normalized` (0.0–1.0 fractional coordinates), and `pixels` (absolute pixel coordinates). All resolve to pixel rectangles with clamping and zero-area validation.
- **Image dimension extraction** via `image-size` package. Dimensions and filenames stored in an in-memory `_imageMeta` map populated on first image ingestion.
- **Enhanced fence tags**: `<vision_proxy_description>` now carries `image`, `width`, `height`, `filename`, and `crop_origin` attributes. New `<vision_proxy_analysis>` fence for tool results with optional `grounding_format` attribute.
- **LRU result cache** for `analyze_image` calls, keyed by (image hashes, crop signature, question hash, model).
- **Grounding format registry** with curated Tier 1 defaults (Qwen, Molmo, DeepSeek, InternVL, Gemini). Grounding instructions appended to system prompt per model's native format.
- **New configuration**: `/vision-proxy tool on|off`, `max-images-per-call <n>`, `max-batch <n>`, `cache-size <n>`.
- **New env vars**: `PI_VISION_PROXY_TOOL`, `PI_VISION_PROXY_MAX_IMAGES_PER_CALL`, `PI_VISION_PROXY_MAX_BATCH`, `PI_VISION_PROXY_CACHE_SIZE`, `PI_VISION_PROXY_PHASH_THRESHOLD`.
- **Security**: `fenceUntrusted` now neutralizes all three fence tag types (`description`, `analysis`, `joint_description`).
- **`readImageFileWithReason`** now returns the file's basename in the `filename` field.
- **Telemetry**: `vision_proxy.tool_call` session entries with crop form, latency, cache hit status.
- 112 unit tests covering crop resolution, LRU cache, dimension extraction, fence building, grounding lookups, config backwards compatibility, and all new env var parsing.

### Changed

- `VisionConfig` extended with `tool`, `maxImagesPerCall`, `maxBatch`, `cacheSize`, `pHashSimilarityThreshold`, `groundingModels` fields. Backwards compatible — 1.3.0 config files load unchanged with sensible defaults.
- Version bumped to `1.4.0-beta.1`.
- Added `image-size` as a runtime dependency.

## [1.3.0] - 2026-05-01

### Added

- Two-step model picker (`/vision-proxy pick`): provider first, then model. Replaces the single flat list of 400+ models.
- Current provider is shown first with a ★ marker and pre-selected — picker opens directly on the model list, no need to re-select the same provider every time.
- `← Change provider` option inside the model list to switch providers without restarting the picker.
- `🔍 Type to filter models…` option for providers with more than 8 models. Uses fuzzy character-order matching (e.g. `cs4` matches `Claude Sonnet 4.5`). Single matches are auto-selected.
- `fuzzyMatches()` helper exported from `internal.ts` with full test coverage.

### Changed

- Duplicated picker code between `/vision-proxy pick` and the interactive `Model:` row consolidated into a single `pickVisionModel()` function.

## [1.2.0] - 2026-05-01

### Added

- `/vision-proxy pick` sub-command. Lists vision-capable models from the registry with friendly names and provider tags via `ctx.ui.select`. Avoids typing canonical ids like `accounts/fireworks/models/kimi-k2p6`.
- Interactive `Model:` row in `/vision-proxy` config now opens the same vision-only picker (was raw text input).
- `friendlyModelLabel(config, registry)` helper. Status line and notifies now display `Kimi K2.6 [fireworks]` instead of `fireworks/accounts/fireworks/models/kimi-k2p6` when the registry knows the model.

### Changed

- "Model not found" error now points to `/vision-proxy pick` instead of `/vision-proxy model`.

## [1.1.0] - 2026-05-01

### Changed

- Settings (mode, model, context) now persist across sessions to `~/.pi/agent/vision-proxy.json`. Previously settings were stored only in session entries and lost when starting a new session. Config precedence (highest → lowest): environment variables → session entries → persistent file → defaults.

### Added

- `readPersistentFile()` / `writePersistentFile()` helpers for file-based config storage.
- `fileConfig` parameter on `resolveConfig()` to layer persisted file config between defaults and session entries.
- Tests for persistent file round-trip and layered config resolution.
