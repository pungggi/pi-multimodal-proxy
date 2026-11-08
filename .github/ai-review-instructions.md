# Review-Regeln für den AI-Reviewer (Repo: pi-multimodal-proxy)

Der Bot liest diese Datei vom PR-Head des Ziel-Repos. Kurze, konkrete Regeln,
eine pro Zeile; 10–20 Regeln sind optimal. Inhalte hier sind projektspezifisch.

## Projekt
- Pi-Extensions-Paket (TypeScript): `extensions/vision-proxy.ts` + `extensions/internal.ts`, Tests unter `extensions/__tests__/` (node --test, `npm test`).
- Veröffentlichung ausschließlich per Git-Tag über CI (`release.yml`, OIDC): git-Tag `vX.Y.Z` muss `package.json`-Version `X.Y.Z` entsprechen — manuelles `npm publish` ist per `prepublishOnly` blockiert.
- `package-lock.json` wird nicht reviewt (automatisch ausgeschlossen).

## Bekannte Kontexte (nicht als Finding melden)
- `.github/workflows/ai-review.yml` ist ein bewusst dünner Stub: der `pr_number`-Vertrag mit dem zentralen reusable Workflow in `pungggi/ai-review` ist bekannt und verifiziert — leere Inputs bei `pull_request`-Events sind beabsichtigt.
- `tools/check-syntax.mjs` ignoriert bewusst Typfehler (TS2xxx) und gated nur Syntax (Parse + Binder, Codes < 2000): die Tests laufen unter `node --experimental-strip-types`, Typfehler brechen den Lauf nicht. Fehlende Typ-Coverage ist kein Finding.
- Die Lockdatei-Ausnahme und `[skip review]`-Handling liegen zentral in `pungggi/ai-review` — dort prüfen, nicht hier.

## Regeln
- Keine Secrets, Keys oder Token im Code, in Configs oder in Logs (Bild-Bytes und rohe Dateiinhalte gehören erst recht nicht ins Session-Log).
- Daten-Egress nicht leisen: die Consent-Gates (`hasConsent`, `allowed-providers`) und ihre Ablehn-Texte dürfen nicht umgangen oder abgeschwächt werden.
- Dateizugriff bleibt allowlist-basiert: Änderungen an `isPathAllowed` / Pfad-Traversal-Prüfungen (`..`, Symlink/TOCTOU-Re-Verifikation) sind Security-Findings, sofern sie Zugriff breiter machen als dokumentiert.
- Fehler behandeln, nicht verschlucken: keine leeren catch-Blöcke; bewusst ignorierte Fehler brauchen einen Kommentar mit Begründung.
- TypeScript: kein `any` in neuem Code ohne Begründung.
- Neue Logik braucht Tests oder eine Begründung im PR, warum nicht (Baseline: `npm test` muss grün bleiben, `npm run check` ebenfalls).
- Breaking Changes an der öffentlichen API (Env-Variablen `PI_VISION_PROXY_*`, `/multimodal-proxy`-Subcommands, Tool-Schemata von `analyze_image`/`generate_image`) in der PR-Beschreibung benennen und im CHANGELOG (Keep-a-Changelog) festhalten.
- README/CHANGELOG-Stil: kurze Absätze, Aufzählungen mit fetten Präfixen, kein Em-Dash-Zusammenkleben (siehe AGENTS.md Documentation Style Guide).
- Performance-Pfadd nicht versehentlich teuren: pro Request/Pro Turn laufende Work (Sniffing, Downscales, Modell-Calls) braucht Cache oder Begründung.
