import type { SalonProfile } from "../config.ts";
import { containsContactDetail, normalizeDigits } from "../privacy/redact.ts";

const lower = (s: string) => normalizeDigits(s).toLowerCase();

const OPT_OUT = new Set([
  "stop", "unsubscribe", "opt out", "optout", "remove me", "cancel messages",
  "الغاء", "إلغاء", "الغاء الاشتراك", "إلغاء الاشتراك", "توقف", "وقف",
]);

/** A timing request like "don't text me before 5" isn't an opt-out. */
const NOT_TIMING = "(?!\\s+(?:before|until|till|after|at|on|in|during)\\b)";
const OPT_OUT_PHRASES = [
  new RegExp(`\\b(?:stop|quit)\\s+(?:messag\\w*|text\\w*|contact\\w*|spam\\w*|send\\w*\\s+(?:me\\s+)?(?:messages|texts|these|this|offers|promos))(?:\\s+me)?${NOT_TIMING}`, "iu"),
  new RegExp(`\\b(?:do not|don't|dont)\\s+(?:message|text|contact|whatsapp)\\s+me\\b${NOT_TIMING}`, "iu"),
  /\b(?:do not|don't|dont)\s+send\s+(?:me\s+)?(?:any\s*more|more|messages|texts|offers|promos)\b/iu,
  /\bno more (?:messages|texts|offers|promos)\b/iu,
  /\b(?:unsubscribe|opt(?:-| )?out)\b/iu,
  /\b(?:remove|delete)\s+(?:me|my number)\b/iu,
  /\btake me off\b/iu,
  /لا\s+(?:تراسل|تتواصل)\S*/u,
  /لا\s+ترسل\S*\s+(?:لي\s+)?(?:أي\s+|اي\s+)?(?:رسائل|رسالة)/u,
  /(?:توقف\S*|وقف\S*|أوقف\S*|اوقف\S*)\s+(?:عن\s+)?(?:الرسائل|إرسال|ارسال|مراسلتي)/u,
  /(?:إلغاء|الغاء)\s+الاشتراك/u,
  /(?:احذف|امسح)\S*\s+رقمي/u,
];

export function isOptOut(text: string): boolean {
  const t = lower(text).replace(/[‘’]/g, "'");
  return OPT_OUT.has(t.replace(/[.!؟?،,]/g, "").trim()) || OPT_OUT_PHRASES.some((p) => p.test(t));
}

/** These go to a person without ever reaching a model. */
const HARD_HANDOFF: { reason: string; pattern: RegExp }[] = [
  {
    reason: "health_or_reaction",
    pattern:
      /\b(allerg\w*|reaction|rash|burn(t|ed|ing)?|bleeding|infection|swollen|swelling|pregnan\w*|breastfeeding|doctor|hospital)\b|حساسية|حرق|حروق|التهاب|تورم|حامل|رضاعة|دكتور|مستشفى/iu,
  },
  {
    reason: "refund_or_legal",
    pattern: /\b(refund|chargeback|money back|lawyer|legal action|sue you|suing|police|consumer protection)\b|استرجاع|استرداد|محامي|شرطة|قضية/iu,
  },
];

export function hardHandoffReason(text: string): string | null {
  return HARD_HANDOFF.find((r) => r.pattern.test(text))?.reason ?? null;
}

export function hasArabic(text: string): boolean {
  return /[؀-ۿ]/.test(text);
}

export interface RuleResult {
  ok: boolean;
  violations: string[];
}

const DISCOUNT = /\d+\s*%|\bdiscount|\bpromo\b|\bpromotion|\bcomplimentary\b|\bfor free\b|\bfree (of charge|session|service|treatment)|خصم|تخفيض|مجان/iu;
const CONFIRMED =
  /\b(confirmed|you('| a)re booked|booked you|you are all set|you're all set|reserved (a|your|you)|see you (on|at|tomorrow|today))\b|تم (تأكيد|الحجز|حجز)|حجزت ل|موعدك مؤكد/iu;
const NEGATED_CONFIRMED = /\b((not|isn't|aren't)( yet)? confirmed|until (we|the team|staff)[^.]*confirm\w*)\b/giu;
const MEDICAL = /\b(safe (for|during|to use)|pregnan\w*|allerg\w*|medical|side effects?)\b|آمن|حامل|حساسية/iu;
const CLAIMS_HUMAN = /\b(i('| a)m (a )?(real )?(human|person)|not (a )?(bot|robot|ai))\b|لست (روبوت|آلي)/iu;
const PRICE = /(?:aed|dhs?|dirhams?|درهم)\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:aed|dhs?|dirhams?|درهم)/giu;
const URL = /\bhttps?:\/\/\S+|\bwww\.\S+/giu;

/**
 * Code-level guard. It can't be talked out of its rules, and runs on every
 * model-written reply whether or not the AI reviewer is on.
 */
export function checkReply(draft: string, profile: SalonProfile): RuleResult {
  const violations: string[] = [];
  const text = normalizeDigits(draft).replace(/[‘’]/g, "'");
  if (!text.trim()) violations.push("empty");
  if (text.length > 700) violations.push("too_long");
  if (/\{\{(?!first_name\}\})/.test(text)) violations.push("unknown_placeholder");
  if (containsContactDetail(text)) violations.push("contact_detail");
  if (URL.test(text)) violations.push("link_from_model");
  URL.lastIndex = 0;
  if (DISCOUNT.test(text)) violations.push("discount_or_offer");
  if (CONFIRMED.test(text.replace(NEGATED_CONFIRMED, ""))) violations.push("claims_confirmed_booking");
  if (MEDICAL.test(text)) violations.push("medical_topic");
  if (CLAIMS_HUMAN.test(text)) violations.push("claims_human");
  const prices = new Set(profile.services.map((s) => s.price_aed));
  for (const m of text.matchAll(PRICE)) {
    const value = Number((m[1] ?? m[2] ?? "").replace(/,/g, ""));
    if (!prices.has(value)) violations.push(`unknown_price_${value}`);
  }
  return { ok: violations.length === 0, violations };
}

export const FIXED_TEXT = {
  optedOut: {
    en: "You're unsubscribed and won't get more marketing messages from us. You can still message us any time.",
    ar: "تم إلغاء اشتراكك ولن تصلك رسائل تسويقية منا بعد الآن. يمكنك مراسلتنا في أي وقت.",
  },
  holding: {
    en: "Thanks for your message. A member of our team will get back to you shortly.",
    ar: "شكراً لرسالتك. سيتواصل معك أحد أعضاء فريقنا قريباً.",
  },
  nonText: {
    en: "Thanks! I can only read text messages for now, so a member of our team will check this and reply shortly.",
    ar: "شكراً! أستطيع قراءة الرسائل النصية فقط حالياً، وسيراجع أحد أعضاء فريقنا رسالتك ويرد عليك قريباً.",
  },
  offTopic: {
    en: "I can only help with our salon's services, prices and bookings. What can I help you with?",
    ar: "يمكنني المساعدة فقط في خدمات الصالون وأسعاره ومواعيده. كيف يمكنني مساعدتك؟",
  },
  disclosure: {
    en: (name: string) => `Hi, this is the virtual assistant for ${name}. `,
    ar: (name: string) => `مرحباً، معك المساعد الافتراضي لـ ${name}. `,
  },
  bookLink: {
    en: (url: string) => `\n\nPick a time here: ${url}`,
    ar: (url: string) => `\n\nاختر الوقت المناسب من هنا: ${url}`,
  },
};
