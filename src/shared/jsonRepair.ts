/**
 * Shared, dependency-free JSON extraction/repair for LLM outputs.
 * Gemini occasionally wraps JSON in prose or code fences, emits trailing commas,
 * or gets cut off mid-object; this recovers as much structured data as possible.
 */

/** Repairs the common LLM formatting anomalies: trailing commas and stray control characters. */
function sanitizeJsonText(candidate: string): string {
  return candidate
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, (char) =>
      char === '\n' || char === '\r' || char === '\t' ? char : ''
    );
}

/** Appends the closing brackets/braces needed to complete a truncated JSON payload. */
function closeTruncatedJson(json: string): string {
  let repaired = json;
  const openBraces = (repaired.match(/\{/g) || []).length;
  const closeBraces = (repaired.match(/\}/g) || []).length;
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/\]/g) || []).length;
  if (openBrackets > closeBrackets) {
    repaired += ']'.repeat(openBrackets - closeBrackets);
  }
  if (openBraces > closeBraces) {
    repaired += '}'.repeat(openBraces - closeBraces);
  }
  return repaired;
}

/**
 * Parses JSON from a model response, stripping markdown fences and conversational
 * wrappers and repairing trailing commas or truncated output when needed.
 */
export function cleanAndParseJson<T = any>(rawText: string): T {
  if (!rawText) throw new Error('Empty response received from Gemini.');
  let text = rawText.trim();

  // Strip code blocks if present
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    text = codeBlockMatch[1].trim();
  }

  try {
    return JSON.parse(text);
  } catch {}

  // Find the outermost JSON object or array
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  const isObjectFirst = firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket);

  const candidate =
    isObjectFirst && lastBrace > firstBrace
      ? text.slice(firstBrace, lastBrace + 1)
      : firstBracket !== -1 && lastBracket > firstBracket
        ? text.slice(firstBracket, lastBracket + 1)
        : text;

  try {
    return JSON.parse(candidate);
  } catch {}

  const repaired = sanitizeJsonText(candidate);
  try {
    return JSON.parse(repaired);
  } catch {}

  // Auto-close truncated JSON if the model output ended abruptly
  try {
    return JSON.parse(closeTruncatedJson(repaired));
  } catch {}

  throw new Error('Could not parse structured JSON from the model response.');
}
