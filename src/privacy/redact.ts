/**
 * Free model endpoints may log prompts, so customer identifiers are removed
 * before any text reaches a model. The client's name becomes {{first_name}} and
 * is only filled back in by code just before sending.
 *
 * This reduces exposure but can't catch everything a customer might type, such
 * as another person's name or a home address.
 */

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

export function normalizeDigits(text: string): string {
  return text.replace(ARABIC_DIGITS, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMIRATES_ID = /\b784[-\s]?\d{4}[-\s]?\d{7}[-\s]?\d\b/g;
const LONG_NUMBER = /\+?\d[\d\s().-]{7,}\d/g;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redact(text: string, firstName?: string | null): string {
  let out = normalizeDigits(text).replace(EMAIL, "[email]").replace(EMIRATES_ID, "[id]");
  out = out.replace(LONG_NUMBER, (m) => {
    const digits = m.replace(/\D/g, "").length;
    if (digits < 9) return m; // dates and short numbers stay readable
    return digits >= 13 ? "[card-or-id]" : "[phone]";
  });
  if (firstName && firstName.length >= 2) {
    const name = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(firstName)}(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(name, "{{first_name}}");
  }
  return out;
}

export function containsContactDetail(text: string): boolean {
  const t = normalizeDigits(text);
  if (new RegExp(EMAIL.source).test(t)) return true;
  return (t.match(LONG_NUMBER) ?? []).some((m) => m.replace(/\D/g, "").length >= 9);
}

/** Customer text is data for the model; strip anything that could close its delimiter. */
export function asUntrusted(text: string): string {
  return text.replace(/[<>]/g, " ").slice(0, 2000);
}

export function fillName(text: string, firstName: string | null): string {
  if (firstName) return text.replaceAll("{{first_name}}", firstName);
  return text
    .replace(/\s*,?\s*\{\{first_name\}\}/g, "")
    .replace(/\s+([,.!?،])/g, "$1")
    .trim();
}
