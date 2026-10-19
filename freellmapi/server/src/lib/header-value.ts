// Header-value sanitizer for the diagnostics headers built out of provider and
// model names (#619).
//
// Node validates every outgoing header value against RFC 7230's field-value
// grammar and throws ERR_INVALID_CHAR ("Invalid character in header content")
// on anything outside it. Relay catalogs happily hand out ids like
// `我的模型[test] v2`, and splicing one into `X-Routed-Via` killed the response
// AFTER the upstream call had already succeeded. Worse, the throw surfaced
// inside the failover loop, so the router booked it as a provider failure and
// cooled the model down — every request to that relay failed, forever.
//
// Encoding rules, deliberately narrow so the output is safe on every surface:
//   - SP and VCHAR (0x21-0x7E) pass through, so ordinary ids like
//     `groq/llama-3.3-70b-versatile` are byte-identical to before;
//   - everything else — control characters (header injection), DEL, and every
//     non-ASCII code point — becomes its percent-encoded UTF-8 bytes, so the
//     value stays decodable with decodeURIComponent instead of being lost;
//   - a literal '%' becomes '%25', which is what makes that decode unambiguous.
// The result is capped so a pathological id cannot push a response past a
// proxy's header budget.

const MAX_HEADER_VALUE_LENGTH = 256;

function percentEncode(char: string): string {
  try {
    return encodeURIComponent(char);
  } catch {
    // Lone surrogate — encodeURIComponent refuses it. Stand in the UTF-8
    // replacement character rather than dropping the position silently.
    return '%EF%BF%BD';
  }
}

/**
 * Coerce an arbitrary string into a valid HTTP header field value. Never
 * throws, and never returns a value Node will reject.
 */
export function safeHeaderValue(value: string, maxLength = MAX_HEADER_VALUE_LENGTH): string {
  if (value == null) return '';
  let out = '';
  // Iterate by code point so astral characters (emoji in a display name) encode
  // as one UTF-8 sequence instead of two broken surrogate halves.
  for (const char of String(value)) {
    const code = char.codePointAt(0)!;
    const piece = code >= 0x20 && code <= 0x7e && char !== '%' ? char : percentEncode(char);
    if (out.length + piece.length > maxLength) break;
    out += piece;
  }
  return out;
}

/** `<platform>/<model>` for X-Routed-Via, sanitized. */
export function routedViaValue(platform: string, modelId: string): string {
  return safeHeaderValue(`${platform}/${modelId}`);
}
