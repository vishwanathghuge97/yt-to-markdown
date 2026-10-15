/**
 * Shared Gemini model list and error classification used by the browser engine,
 * the server API, and the UI. Single source of truth to avoid drift.
 */

/** Supported fast models for free & standard Gemini API keys, in preference order. */
export const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];

/** True when the error indicates the caller's API key is invalid or rejected. */
export function isInvalidApiKeyError(input: unknown): boolean {
  const message = typeof input === 'string' ? input : String((input as any)?.message || '');
  return /API_KEY_INVALID|invalid.*api.*key|api key not valid|permission denied/i.test(message);
}

/** True when the error indicates Gemini rate limiting or quota exhaustion. */
export function isQuotaError(input: unknown): boolean {
  const message = typeof input === 'string' ? input : String((input as any)?.message || '');
  return /RESOURCE_EXHAUSTED|rate limit|quota|resource exhausted/i.test(message);
}

/** True when the error indicates a transient model availability issue worth one retry. */
export function isTransientGeminiError(input: unknown): boolean {
  const message = typeof input === 'string' ? input : String((input as any)?.message || '');
  return /503|high demand|unavailable|429|rate limit|quota/i.test(message);
}

/**
 * Redacts credentials from error messages before logging or showing them,
 * then maps common Gemini failures to friendly user-facing text.
 */
export function sanitizeErrorMessage(err: unknown): string {
  if (!err) return 'An unknown error occurred during generation.';
  const raw = typeof err === 'string' ? err : String((err as any)?.message || err);
  const msg = raw
    .replace(/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED_API_KEY]')
    .replace(/ya29\.[0-9A-Za-z_-]+/g, '[REDACTED_OAUTH_TOKEN]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]');

  if (isInvalidApiKeyError(msg)) {
    return 'Your Gemini API key was rejected. Please check that your key is valid and has not expired.';
  }
  if (isQuotaError(msg)) {
    return 'Gemini API rate limit or quota exceeded. Please wait a minute or rotate your free API key.';
  }
  if (/AbortError|timed out|TimeoutError/i.test(msg)) {
    return 'The request timed out. Please check your internet connection and try again.';
  }
  return msg;
}
