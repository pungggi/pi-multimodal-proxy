# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.21.0] - 2026-10-03

### Added

- **Compact transcript rows via `pi.registerToolRenderer()` (Pi ≥ 1.0.1, feature-detected)** — `analyze_image` and `generate_image` calls now render as one compact, themed line each instead of the default JSON-args dump. The `analyze_image` call line shows the question (word-boundary truncated, surrogate-pair safe), image references (recall ids → `image="deadbeef…"`, file paths → file name, `+N more` beyond two shown), a crop summary (`bottom-right@0` / `25%,13% 50%×50%@1` / `128,64 256×256@0` / `crops ×N`), and a model override; `generate_image` shows the prompt and override. Result lines summarize `✓ provider/model · cached · 1.2s` for analyses and `✓ N images via provider/model · $0.0311 · image="<id8>…"` for generations, or `✗ <error>`; expanding a row reveals the full text content. Generated images still render inline from the result's image blocks (independent of `renderResult`), reliable across Kitty/Ghostty/WezTerm/Warp via pi 1.0.1's JPEG/WebP/GIF `Image` fixes.
- **Renderer coverage for unregistered tools** — registering through `registerToolRenderer` rather than inline `renderCall`/`renderResult` on the tool definitions means the compact rows also apply to calls replayed when the tool is *not registered* at render time: sessions resumed with the tool disabled (`/multimodal-proxy tool off`, mode off), transcript rows rendered before extension load, and HTML exports. Resolver chaining (`next() ?? {}`) preserves other extensions' renderers for the keys we don't set.
- **Tool-result `details` payloads** — both tools now return a display-sized `details` object (analyze: `ok`/`error`/`cached`/`provider`/`model`/`latencyMs`/`groundingFormat`, with the heavy `text`/`images` stripped; generate: the structured payload as-is — ids/dims/cost) that feeds the renderer and persists in the session log without ever reaching the model.
- Defensive renderer plumbing: pi-tui's `Text` (ANSI-aware wrapping) is loaded lazily with a plain-lines structural fallback so an unresolvable package can never block extension load; renderers tolerate partial/garbage streaming args and missing result objects (the fake-host smoke test caught one such crash before it shipped).
- New `tool-render.test.ts` (24 tests: truncation, ref/crop summarization, call and result lines, garbage tolerance, details stripping) plus a fake-host smoke script (`tools/smoke-renderers.mjs`) that loads the real extension module and exercises the resolver contract — 540 tests total, all green; also verified loading under the real pi 1.0.1 RPC loader.

### Changed

- Nothing user-visible on pi < 1.0.1 hosts: registration is gated on `typeof pi.registerToolRenderer === "function"`, so older runtimes keep the default tool rendering with zero behavior change.

## [1.20.0] - 2026-10-02

### Added

- **`generate_image` tool (Pi ≥ 1.0, feature-detected)** — agent-facing image creation through `ModelRegistry.generateImages()` with the session's credentials and request-time auth; usage counts toward session cost. Parameters: `prompt` (1..4000 chars), optional `model` (`provider/model-id` of an image-generation model). Model resolution walks `getAvailableOfType("image")` (cached per session): without an override the first keyed image model wins; a mistyped override errors with recovery-style close matches and a malformed one gets the expected format (Pi 1.0 codemode-error philosophy). The prompt leaves only after the data-egress consent gate (`/multimodal-proxy consent yes` / `allowed-providers`). Results carry the generated image blocks (vision-capable base models see the pixels directly) plus a summary text naming each `image="<id>"` id, and an `outputSchema`-shaped `structuredContent` (provider, model, per-image id/mimeType/dimensions, `costUSD` when the provider reported usage; `usage` passed through on the tool result). Generated images are persisted in the per-session recall stores (`imageData`/`imageMeta`) with `generated-<hash8>.<ext>` filename hints, so the existing pipeline takes over: for text-only base models the `tool_result` hook auto-describes them via the vision model and appends `DescriptionEntry`s (making `#` recall work), and `analyze_image` can re-query or crop them by id regardless of base-model modality. Shares the per-turn tool-call budget with `analyze_image` (10/turn); annotated `readOnlyHint: false` (cost-incurring content creation) and namespaced `multimodal-proxy`. Registered only when the runtime exposes `generateImages` — pi < 1.0 never sees the tool.
- Five new tests for `resolveImageGenModelChoice` (default-first, exact override, close-match suggestions on typos, expected-format error, actionable hint when nothing is keyed) — 512 total, all green.

## [1.19.1] - 2026-10-02

### Changed

- **Leaner `analyze_image` description** — the tool description shrinks ~40% (1.7 KB → ~1.0 KB) while keeping every actionable detail (when to use, the three crop forms with shapes, recall ids, fence attributes, `crop_origin` math). Pi 1.0's codemode lists tool declarations under a 3000-token inline budget and drops what doesn't fit, so a long description both costs tokens on every request and risks pushing other tools out of the listing.
- **Recovery-style errors (Pi 1.0 codemode philosophy: errors say how to recover)** — `analyze_image`'s model-not-found error now names close registry matches (`anthropic/claude-sont-5` → suggests `anthropic/claude-sonnet-5`, `…-sonnet-4-5`), the recall-id-not-found error lists close ids still retained in the session cache, and zero-area crop errors explain the expected shape (fraction/absolute bounds) instead of just "zero area".
- **Dynamic implicit-vision-model fallback (Pi ≥ 1.0, feature-detected)** — when the curated fallback chain (`zai/glm-5.3-flash` → `deepseek/…-flash-vision-exp` → `anthropic/claude-sonnet-5/4-5`) is entirely unkeyed but another keyed vision-capable chat model exists (openrouter, google, …), `ModelRegistry.getAvailableOfType("chat")` resolves the implicit default to the first one (cheap-tier ids — flash/mini/fast/haiku/express/lite — preferred so an implicit default never lands on a frontier-priced model). Probe cached per session; older runtimes and the "nothing keyed anywhere" notice path are unchanged.
- **`#` recall autocomplete regression tests** mirroring pi #10218 (autocomplete must trigger when input starts with whitespace) — the `(?:^|\s)#` token regex already handled it; the tests pin it.
- Six new tests: `closeMatches` (near-typo ranking, substring bonus, relevance floor, deterministic ties), `pickDynamicVisionCandidate` (cheap-tier preference, first-capable fallback, input filtering), zero-area crop recovery hints (507 total, all green).

## [1.19.0] - 2026-10-01

### Added

- **Virtual model — `Multimodal Auto`** (`multimodal-proxy/auto`, Pi ≥ 0.99, feature-detected). The extension registers a virtual model via `pi.registerVirtualModel()`; selecting it in `/model` routes each request: turns whose pending user input carries image blocks go natively to the configured vision model (real pixels, no description fence), everything else goes to the base model — the pinned `virtual-base` model, else the physical model that answered last (`request.previous`), else the vision model. Sticky routing (`retry` → `failed`, `continuation`/`direct` → `previous`) keeps prompt caches and thinking signatures valid. `route()` resolves config per request (no registration churn on model changes) and throws an actionable error pointing at `/multimodal-proxy pick` when no vision model resolves. New commands `/multimodal-proxy virtual on|off` (default on; `unregisterVirtualModel` when off), `/multimodal-proxy virtual-base <provider/model-id>|off`, env overrides `PI_VISION_PROXY_VIRTUAL` / `PI_VISION_PROXY_VIRTUAL_BASE`, status-line `[+virtual]` marker, interactive-menu entry, and summary/help lines. With the virtual model selected, image stripping never applies (it advertises image input); video/audio detection, `analyze_image`, and consent gates are unchanged.
- **`analyze_image` adopts the Pi 0.99 extension tool API** (older hosts ignore the new fields): results carry `isError: true` for failures instead of "Error: …" text masquerading as content (all ~18 failure paths now route through an `AnalyzeImageOutcome`), successful calls return an `outputSchema`-shaped `structuredContent` — analysis text, `cached`, fallback-aware `provider`/`model`, `latencyMs`, `groundingFormat`, and per-image `id`/`filename`/dimensions/absolute-pixel `crop` — so codemode scripts and other `ctx.executeTool()` callers receive machine-readable results, and MCP-style `annotations` (`readOnlyHint: true`, `openWorldHint: true`) plus a `multimodal-proxy` namespace group the tool in codemode listings.
- **Model-aware upload downscale** (Pi ≥ 0.87). `modelImageResizeLimits()` reads the vision model catalog entry's `inputLimits.images.resize` (`maxWidth`/`maxHeight`/`maxBytes`/`jpegQuality`, all optional) and `downscaleForUpload()` tightens the user's `maxUploadDim`/`maxUploadBytes`/quality with it — the derived long-edge target is `min(maxWidth, maxHeight)`, the base64 `maxBytes` budget is converted to raw bytes (×0.75) before mixing with the user's raw budget, and a user-disabled downscale (`maxUploadDim: 0`) always wins. `downscaleImage` gained a `quality` parameter threaded through both the worker task and the in-thread path. All four upload paths (auto-proxy, `analyze_image`, joint descriptions, `/describe`) pass the resolved vision model's limits.
- **Compaction-proof, cache-stable recall hint** (Pi ≥ 0.87). A `context_with_system` handler — probed on first invocation so the affordance never appears twice — takes over the `analyze_image` recall affordance once media has been described: a stable system-layer block replaces the per-user-message restatement. It survives compaction (which summarized the old hint away) and reaches vision-capable session models, where the strip path never fired. Older hosts keep the exact previous behavior.

### Changed

- `envFlags()` reports two new presence flags (`virtual`, `virtualBase`); the config summary, no-UI command list, and interactive menu show the virtual-model state (including a "(needs pi ≥ 0.99)" qualifier when registered on an older host).
- Six new tests: env override + flag presence for the virtual vars, `modelImageResizeLimits` derivation (null cases, box target, quality default, raw-byte conversion), model-limits tightening vs. user-disabled downscale vs. in-budget images, and sanitize validation of the new fields (494 total, all green).

### Fixed (PR #34 review)

- **`modelImageResizeLimits` no longer drops maxBytes-only declarations** — a catalog entry with `inputLimits.images.resize.maxBytes` but no `maxWidth`/`maxHeight` is now honored: `targetDim` stays unset (the user's dim target applies) while the byte budget (converted to raw bytes, floored at 1) and JPEG quality still tighten the upload path. Quality-only declarations remain a no-op.
- **Virtual-model routing filters for vision-capable entries** — `resolveVisionTarget` only accepts models whose `input` includes `image`, so a text-only pin (via `/multimodal-proxy model` or `PI_VISION_PROXY_MODEL`) can no longer route a media turn to a model that would receive image placeholders; `route()` throws the actionable `/multimodal-proxy pick` error instead.
- **Cache-hit `structuredContent.text` now matches fresh calls** — the analyze_image tool cache stores `{ fence, raw }`, so cached requests return the raw analysis text in `structuredContent` (as `AnalyzeImageOutput` advertises) while the model still sees the identical fence.

## [1.18.1] - 2026-08-30

### Fixed (post-release review of 1.18.0)

- **The stage-2 syntax gate was a silent no-op on Windows.** `tools/check-syntax.mjs` compared `walk()` paths (backslash separators) against TypeScript-normalized source-file names (forward slashes), so the `has()` filter dropped every diagnostic — a planted `await`-in-non-async probe passed the gate. Both sides are now normalized; the planted-probe test fails the gate as intended. (Linux CI paths happened to match, so releases were still protected — local/dev Windows runs were not.)
- **Default-substitution notice no longer fires when the proxy is `off`** — model resolution is irrelevant with media analysis disabled.
- **The substitution hint is now cause-aware**: when the substituted-from model is missing from the catalog the notice suggests updating pi / pinning a model, instead of the (wrong) `pi --login` key hint that only fits the no-API-key case.
- **`writePersisted`'s fire-and-forget status refresh gained a `.catch`** — a rejected key probe can no longer surface as an unhandled promise rejection in daemon processes.
- **`withModelFallback` skips the 5 async key probes for explicit configs** (`PI_VISION_PROXY_MODEL` or persisted `modelExplicit`), where resolution is a no-op by definition.

## [1.18.0] - 2026-08-30

### Added

- **Key-aware default model resolution.** The implicit vision default now resolves to a model the user can actually call: when the configured default (`zai/glm-5.3-flash`) is not usable — missing from the catalog **or its provider has no API key** — `applyDefaultModelFallback` walks a preference-ordered candidate chain and picks the first entry that is both in the registry and keyed. `DEFAULT_MODEL_FALLBACKS` gained `deepseek/deepseek-v4-flash-vision-exp` (vision-capable via the built-in DeepSeek provider since Pi 0.84.4, ≈$0.22/M in) ahead of the Claude fallbacks. Safety rules: a keyed legacy default is never traded for an unkeyed model; explicit choices (`modelExplicit`, `PI_VISION_PROXY_MODEL`) are never rewritten; when nothing is keyed the catalog-only behavior applies so first use still surfaces the actionable "No API key — pi --login" notice. `withModelFallback` became async and probes keys via `ModelRegistry.getApiKeyAndHeaders` with a per-session cache; substitutions are announced once per session (`notifyDefaultSubstitution`) from `session_start` / `before_agent_start`.
- **Content-sniffed image validation** (Pi ≥ 0.84.4, graceful on older runtimes). `readImageFileWithReason` accepts an injectable sniffer backed by Pi's newly exported `detectSupportedImageMimeTypeFromFile`; new pure helper `decideImageMime` merges the extension map with the sniff: sniffed type wins (corrects mis-typed files), a sniff that finds no image rejects files whose extension is inside the sniffer's coverage (new reason `invalid-image`), PNG-signature files the sniffer rejects as animated still pass as `image/png` (APNG passthrough), formats outside coverage (tiff/ico/avif) and sniffer-unavailable runtimes keep the extension-only path, and extensionless files with recognizable contents are now accepted. The sniffer fails open: a throwing sniffer degrades to extension-only.
- **`/multimodal-proxy doctor`** — one-shot setup diagnostics covering effective model resolution (explicit / implicit / substituted), catalog presence, API keys, data-egress consent, fallback and video model, yt-dlp/ffmpeg availability (with versions), path-detection/allowlist state, and in-memory recall-store usage. Also available from the interactive menu.
- **`/multimodal-proxy test`** — end-to-end self-test: generates a tiny gradient PNG locally (ImageScript, no fixture file), runs it through the full describe pipeline (model resolution → key check → consent → retry/backoff → upload), and reports the model, latency, and description (or the failure pointer to `doctor`). Also available from the interactive menu.
- **Hardened syntax gate** (`tools/check-syntax.mjs` stage 2): beside the existing parse-only check, a `ts.createProgram` pass filtered to syntax-range diagnostic codes (< 2000) catches constructs the parser alone accepts but the runtime rejects — most notably `await` inside a non-async function (introduced and caught during this release's review; it crash-loops every pi loading the package, the exact 1.16.1 incident class). Type-level noise (TS2xxx) stays out of the gate, so the baseline is zero.

## [1.17.0] - 2026-08-27

### Changed

- **Default vision model is now GLM 5.3 Flash (`zai/glm-5.3-flash`).** `DEFAULT_CONFIG` ships `zai/glm-5.3-flash` (image input, 1M context, $0.075/M input — $0.25/M output) as the default image-description model, replacing `anthropic/claude-sonnet-5`. Implicit configs keep tracking the package default: `anthropic/claude-sonnet-5` was added to `LEGACY_DEFAULT_MODELS` (so configs that merely inherited Sonnet 5 upgrade to GLM 5.3 Flash once it's in the catalog), `DEFAULT_MODEL_FALLBACKS` now tries `anthropic/claude-sonnet-5` and then `anthropic/claude-sonnet-4-5` on catalogs without GLM 5.3 Flash, and explicit choices (`modelExplicit`, `PI_VISION_PROXY_MODEL`) are never rewritten. README (What's new, env-table default, privacy note, requirements) and the `/multimodal-proxy model` usage example updated to the new default.

## [1.16.1] - 2026-08-22

### Fixed

- **Syntax error in the interactive config menu** (v1.16.0 regression): the "Fallback model" handler opened `ctx.ui.input(` with a stray trailing quote, making the whole `vision-proxy.ts` extension unparseable for pi's jiti/oxc loader (`Unterminated string constant` at `vision-proxy.ts:3790`). Every pi process loading the package crashed at startup — daemons crash-looped until the extension was removed or the file hand-patched. `node --check` (swc) accepts the broken construct, so it slipped through the existing gates.
- The shipped file is now byte-identical to the hand-patched copy that has been running in production.

### Added

- **Syntax gate for shipped extensions** (`npm run check`, `tools/check-syntax.mjs`): parses every `.ts` under `extensions/` with the TypeScript parser and fails on any parse diagnostic — a parser that actually rejects the class of error that shipped. Wired into `release.yml` before `npm test`, so an unparseable extension can no longer reach npm.

## [1.16.0] - 2026-08-17

### Added

- **Transient-error retry with backoff for all vision calls** (borrowed from a survey of atlas-vision-mcp). `completeCompat` call sites (auto-proxy, analyze_image tool, joint comparison, describe command, tool-result describe, video/audio) now go through a `completeVision` wrapper that retries transient failures — 429, 5xx, network errors (ECONNRESET/ETIMEDOUT/fetch failed/…) — up to `retryMax` times (default 2, range 0–5) with exponential backoff + jitter (1s·2^attempt capped at 8s, 0–30% jitter), abort-aware (a user cancel stops retries immediately, never fails over). Hard errors (401/403/413/…) and aborts are never retried. New tested pure helpers: `isTransientVisionError`, `isAbortError`, `retryDelayMs`, `sleepWithAbort`.
- **Upload downscale for oversized images.** Images above the configured long-edge (default 2048 px) or byte budget (default 5 MB raw) are downscaled locally before upload — reusing the terminable ImageScript worker infrastructure (the crop worker now serves a `resize` op too, pooling and hard timeouts unchanged) — and re-encoded as JPEG q88. Dimension-triggered resizes are accepted even when the re-encode grows slightly (flat PNGs compress better than JPEG); byte-budget-triggered resizes only apply when the result is genuinely smaller. Description hashing, caching, and session recall still key on the ORIGINAL bytes — only the upload payload shrinks. New tested pure helper: `downscaleTargetDim`; new integration-tested helpers: `downscaleImage`, `downscaleForUpload`.
- **Configurable fallback vision model.** When the primary vision model exhausts its retries (or hard-fails), the call re-runs once with `fallbackProvider/fallbackModelId` — only when it resolves in the registry, supports the required input kind (image, or video for the video pipeline), has an API key, and **its provider has data-egress consent** (a non-consented fallback is skipped silently; configuring one now prints a consent hint). Both fallback halves are validated together by `sanitize` (canonicalized provider, pattern-checked). Set via `/multimodal-proxy fallback-model provider/model-id|clear` (also in the interactive menu) or `PI_VISION_PROXY_FALLBACK_MODEL` (`none`/`off` clears).
- **New commands**: `/multimodal-proxy retry <0-5>`, `/multimodal-proxy max-upload <dim|n mb|off>`, `/multimodal-proxy fallback-model <provider/model-id>|clear` — all reflected in the status summary, the interactive config menu, and the no-UI command list; all lockable via env (`PI_VISION_PROXY_RETRY_MAX`, `PI_VISION_PROXY_MAX_UPLOAD_DIM`, `PI_VISION_PROXY_MAX_UPLOAD_MB`, `PI_VISION_PROXY_FALLBACK_MODEL`).

### Fixed (pre-release review, PR #27)

- **Fallback model was retried forever.** `completeVision` re-resolved the same fallback candidate on every outer-loop iteration, so a failing fallback repeated its attempts, backoffs, and notifications indefinitely instead of being tried once. The fallback now gets exactly one round.
- **Cancel during a backoff sleep surfaced the wrong error.** Aborting mid-retry threw the last transient provider error (e.g. a 429) instead of an abort-shaped error, so callers reported a vision failure rather than a user cancel. Cancels racing a provider failure are now normalized through the new tested helper `createAbortError()` (name `AbortError`, message `aborted` — matching call sites' cancelled-path checks).
- **`max-upload off` didn't fully disable downscaling.** "off" previously clamped to 8192 px / 20 MB, so e.g. a 9000 px image was still resized and JPEG-re-encoded despite the opt-out. `maxUploadDim = 0` is now a true disable sentinel honored by `sanitize`, `downscaleTargetDim`, `downscaleForUpload`, the env parser (`PI_VISION_PROXY_MAX_UPLOAD_DIM=0`), and the command's "off" form.
- **Invalid env values locked commands without overriding anything.** `PI_VISION_PROXY_RETRY_MAX=9`, an unparsable `PI_VISION_PROXY_MAX_UPLOAD_DIM`, or a malformed `PI_VISION_PROXY_FALLBACK_MODEL` made `envFlags` report an override (locking the matching `/multimodal-proxy` subcommand) while `readEnvOverrides` silently ignored the value. Parsing is now shared between the two (`parseRetryMaxEnv`, `parseUploadDimEnv`, `parseUploadMbEnv`, `parseFallbackModelEnv`), so only values that actually apply count as env overrides — matching the existing `statusLine`/`pathDetection` convention.

- **Fallback-attributed telemetry (CodeRabbit round 2).** `completeVision` now also returns `usedProvider`/`usedModelId` of the candidate that actually answered; the `analyze_image` tool and `describe` telemetry entries record that model instead of always naming the primary, so fallback output is no longer misattributed.
- **`sanitize` guards non-string fallback halves.** Both `fallbackProvider` and `fallbackModelId` must be real strings before canonicalization/pattern checks — `RegExp.test()` coerces its argument, so a numeric modelId could previously slip through.
- **Shared `overUploadDim` helper.** `downscaleTargetDim` and `downscaleForUpload` now share one threshold decision so the two cannot drift; README jitter wording corrected (`±30%` → `0–30%`).

## [1.15.0] - 2026-08-11

### Added

- **Vision-model picker respects the session's model scope.** `/multimodal-proxy pick` now honors `ctx.scopedModels` (pi ≥ 0.83.0): when a scope is configured via `--models` or `enabledModels`, the picker lists only scoped vision-capable models, mirroring the built-in `/model` selector instead of enumerating the whole catalogue. Falls back to the full registry when no scope is set, and on runtimes that predate `scopedModels` (gracefully undefined). When the persisted provider is excluded by the configured scope, the picker opens on the first in-scope provider instead of an empty model list. New tested pure helper `selectVisionModels`.

### Fixed

- **Forward-compat with pi 0.84.0 `null` header-deletion markers.** Since pi 0.84.0, `ModelRegistry.getApiKeyAndHeaders()` returns `ProviderHeaders` (`Record<string, string | null>`) where `null` marks a header for deletion. The xAI native video path (STT / file-upload / `/v1/responses`) builds raw `fetch()` calls that cannot carry `null` — undici throws `TypeError` on a non-string header value, or sends a literal `"null"`. Those headers are now stripped at the call boundary (and at the `xaiHeaders` choke point as defense-in-depth). An explicit `Authorization: null` deletion marker is now honored — the header is suppressed rather than re-filled with the API key — so a credential deliberately suppressed by a provider/header hook is not forwarded. The pi-ai `complete()` paths continue to pass headers through unchanged, as required. New tested pure helper `sanitizeProviderHeaders`.

## [1.14.0] - 2026-08-09

### Added

- **Tool-result images are now described via the vision model.** When a tool returns an image content block (e.g. `read` on a PNG, or a screenshot tool), non-vision models previously lost it entirely — pi-core strips image blocks they can't consume — and vision models received it as raw base64. A new `tool_result` handler describes those images through the configured vision model and replaces the block with the same `[Image - vision-proxy description (UNTRUSTED…)]` fence text the `context` hook emits, so the description reaches the active model and is cached for `analyze_image` recall. The flow mirrors `before_agent_start`: it fast-paths tool results with no image, respects `shouldStripImages` (vision models and `off` mode pass the block through unchanged), gates on data-egress consent (no consent leaves the block untouched, preserving prior stripping behaviour), and stores image metadata + bytes for later session recall. New tested pure helpers in `internal.ts`: `collectToolImageBlocks`, `replaceToolImageBlocks`, `AnalysisResult`, `ToolContentBlock`.

## [1.13.0] - 2026-08-09

### Fixed
- Migrated to `ModelRegistry.complete`.

## [1.12.1] - 2026-08-07

### Fixed

- **Downloaded videos now save to the real Downloads folder.** The post-analysis "Save downloaded video?" prompt hardcoded `join(os.homedir(), "Downloads")` and wrapped `copyFile` in a silent `catch {}`. On machines where the Windows Downloads folder is relocated (e.g. `D:\Downloads`) or OneDrive-redirected, the default path doesn't exist, so `copyFile` threw `ENOENT`, the error was swallowed, and the user saw no file and no message after clicking **Yes**. `vision-proxy.ts` now resolves the real Downloads folder via the Windows Shell known-folder API (`FOLDERID_Downloads` / `shell:Downloads`, which respects relocation and OneDrive redirection), creates it on demand (`mkdir -p`), and surfaces any save failure with the target path. The success notification now includes the full saved path. New helpers: `resolveDownloadsDir`, `pathExists`.

### Added

- **yt-dlp auth knobs to defeat YouTube 403s.** YouTube increasingly returns `HTTP Error 403: Forbidden` on the media fetch even with the latest `yt-dlp`; the proxy previously passed no credentials. Two opt-in, persisted settings now forward to yt-dlp: `ytdlpCookiesFromBrowser` (`/multimodal-proxy ytdlp cookies <browser|off>`, validated against `chrome|firefox|edge|brave|opera|safari|vivaldi|chromium|whale`) reuses a logged-in browser session, and `ytdlpExtractorArgs` (`/multimodal-proxy ytdlp extractor-args "<text>|off>`) forwards arbitrary `--extractor-args` (e.g. `youtube:player_client=web_safari,web`). A 403 download failure now appends a hint pointing at the cookies knob. Env overrides: `PI_VISION_PROXY_YTDLP_COOKIES_FROM_BROWSER`, `PI_VISION_PROXY_YTDLP_EXTRACTOR_ARGS`. New sanitizers + tests: `sanitizeYtdlpCookiesFromBrowser`, `sanitizeYtdlpExtractorArgs`, `YTDLP_COOKIES_BROWSERS`.

## [1.11.0] - 2026-07-29

### Added

- **Global consent wildcard** — `/multimodal-proxy allowed-providers add *` (or `all`) now grants consent for **all providers** globally, so you can consent once and never be prompted again. The wildcard (`*`) appears in the pre-consented list as "* (all providers)" and can be removed with `/multimodal-proxy allowed-providers remove *`. An explicit in-session `consent no` still beats the wildcard and applies only to the revoked provider.

## [1.10.1] - 2026-07-08

### Fixed

- **Source-code files with overloaded media extensions are no longer sent to video models.** The `.ts` extension is mapped to both TypeScript (source code) and MPEG-TS (`video/mp2t`) video. Previously, a file like `store.ts` mentioned in a prompt was matched by the video-path extractor, read as a 200 MB media file, and shipped to the configured video provider (e.g. "Analyzing store.ts via Grok 4.3…"). `readMediaFileWithReason` now sniffs the file contents for extensions whose primary meaning is source code (`.ts`, `.mts`, `.m2ts`): it validates the MPEG-TS sync byte (`0x47`) at the start of the first few 188-byte packets and rejects the file as `not-a-media` when the signature is absent. Genuine MPEG-TS streams continue to work; TypeScript files no longer leak source code to a video model. The `not-a-media` skip message in `vision-proxy.ts` was updated to describe the new content-sniffing behavior.

## [1.10.0] - 2026-07-07

### Added

- **Configurable allowed folders** ([#15](https://github.com/pungggi/pi-multimodal-proxy/issues/15)) — the file-access allowlist is now a persisted config setting instead of env-var-only. `/multimodal-proxy folders add <path>` (also `remove`, `list`, `reset`) grants media reads from custom absolute folders (`~` is expanded), and `/multimodal-proxy allow-home on|off` is the persisted equivalent of `PI_VISION_PROXY_ALLOW_HOME=1`. Both are stored in `~/.pi/agent/multimodal-proxy.json` alongside the other settings and survive new sessions. Also manageable from the interactive `/multimodal-proxy` menu.
- **New env var**: `PI_VISION_PROXY_ALLOWED_FOLDERS` — platform-delimiter-separated list of absolute folders (`:` on Unix, `;` on Windows); like other env vars it overrides and locks the persisted setting. `PI_VISION_PROXY_ALLOW_HOME` keeps working and now also accepts `0`/`false` to override a persisted `allow-home on`.
- The allowlist applies uniformly to auto-proxied prompt paths (images, video, audio), the `analyze_image` tool, and `/multimodal-proxy describe`. Allowlisted folders are canonicalized via `realpath` before comparison; relative entries are rejected and the list is capped at 100 folders. New tested helpers: `expandLeadingTilde`, `sanitizeAllowedFolders`, `pathAccessFromConfig`, and the `access` parameter on `isPathAllowed` / `readImageFileWithReason` / `readMediaFileWithReason`.
- **Hide-able status line** ([#16](https://github.com/pungggi/pi-multimodal-proxy/issues/16)) — new persisted `statusLine` setting. `/multimodal-proxy status off` hides the steady-state footer status (`multimodal-proxy: fallback → … | video: …`), `/multimodal-proxy status on` restores it, and the interactive config menu gets a matching toggle. The transient analysis progress spinner still shows while a call is in flight and clears when it finishes. New env override: `PI_VISION_PROXY_STATUS_LINE=on|off`.

### Fixed

- Changing any setting via `/multimodal-proxy` refreshed the status line under the stale `vision-proxy` key with an outdated text format, leaving a second, never-updated status entry alongside the real one. The refresh now uses the same `multimodal-proxy` key and steady-state text (including the video model and registry fallback) as session start.
- The interactive `/multimodal-proxy` summary now lists every active env override (previously only shown when mode/model/context was set, hiding overrides like `tool`, `cacheSize`, or `statusLine`), and an invalid env value (e.g. `PI_VISION_PROXY_STATUS_LINE=hidden`) no longer locks the matching subcommand without actually overriding anything.

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
