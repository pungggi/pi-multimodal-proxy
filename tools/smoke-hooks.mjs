// Module hooks: redirect relative .js specifiers to their .ts siblings so
// node's strip-types loader can run the extension (which imports "./internal.js",
// the jiti-style specifier pi uses at runtime). Smoke-test only.
import { pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
	if (specifier.endsWith(".js") && (specifier.startsWith("./") || specifier.startsWith("../"))) {
		try {
			return await nextResolve(specifier.replace(/\.js$/, ".ts"), context);
		} catch {
			// fall through to default resolution
		}
	}
	return nextResolve(specifier, context);
}
