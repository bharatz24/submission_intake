// URLs that came from outside the app (another system's API, model output) before they reach an href.

const WEB_URL = /^https?:\/\//i;

/**
 * An absolute http(s) URL, trimmed, or null for anything else: javascript:, data:, vbscript:, relative paths and
 * protocol-relative "//host" are refused, so a value from another system can never run script when clicked (FE-06).
 */
export function safeWebUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed || !WEB_URL.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}
