import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The directory of the calling module, from its `import.meta.url`. Netlify bundles the functions as CommonJS, where
 * `import.meta.url` is empty and the module's own location is gone: `bundled` is then the same directory relative to
 * the function's working directory (the repo root), which must be shipped in netlify.toml `included_files`.
 */
export function moduleDir(metaUrl: string | undefined, bundled: string): string {
  return metaUrl ? path.dirname(fileURLToPath(metaUrl)) : path.resolve(bundled);
}
