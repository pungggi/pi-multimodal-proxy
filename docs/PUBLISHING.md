# Publishing `pi-multimodal-proxy`

Tag-driven CI publish with npm provenance.

```bash
npm version patch -m "release: %s"
git push origin main --follow-tags
gh run watch
```

## Auth (one-time) — Trusted Publisher / OIDC

1. npmjs.com → `pi-multimodal-proxy` → **Settings → Trusted Publisher**
2. Add GitHub Actions:
   - **Organization or user:** `pungggi`
   - **Repository:** `pi-multimodal-proxy`
   - **Workflow filename:** `release.yml`
3. Leave `NPM_TOKEN` unset for pure OIDC.

Fallback: Classic **Automation** token as `NPM_TOKEN` repo secret.
