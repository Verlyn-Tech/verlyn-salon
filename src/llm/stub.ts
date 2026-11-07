import { LLMUnavailableError, type JsonRequest, type JsonResult, type LLM } from "./types.ts";

/**
 * Keyword-based stand-in for trying the pipeline with no API key. It isn't AI and
 * says nothing about real model quality. Only `sim --stub` and `demo` use it.
 */
export class StubLLM implements LLM {
  async completeJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    const message = /<customer_message>\n([\s\S]*?)\n<\/customer_message>/.exec(req.user)?.[1] ?? "";
    const ar = /[؀-ۿ]/.test(message);
    const t = message.toLowerCase();
    const wantsBooking = /book|appointment|slot|حجز|موعد/.test(t);
    const isChange = /cancel|reschedule|move my|تغيير|إلغاء موعد/.test(t);
    const isWinbackContext = req.system.includes("This customer recently received");
    let answer: unknown;
    switch (req.agent) {
      case "router":
        answer = {
          intent: isChange ? "reschedule_or_cancel"
            : wantsBooking ? "booking"
            : isWinbackContext ? "winback_reply"
            : /price|how much|cost|open|hours|كم|سعر/.test(t) ? "enquiry"
            : /person|human|manager/.test(t) ? "human_request"
            : /poem|homework|ignore/.test(t) ? "off_topic"
            : "unclear",
          language: ar ? "ar" : "en",
          confidence: 0.9,
        };
        break;
      case "enquiry":
        answer = {
          reply: ar ? "سعر صبغة الجذور 280 درهم وتستغرق 90 دقيقة." : "A root colour is 280 AED and takes about 90 minutes.",
          needs_human: false,
          handoff_reason: null,
        };
        break;
      case "booking":
        answer = {
          reply: ar ? "يسعدنا استقبالك، سيتواصل معك الفريق للتأكيد." : "Happy to help. The team will check and get back to you.",
          action: isChange ? "request_reschedule" : /\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday/.test(t) ? "request_new" : "send_booking_link",
          service_id: /colou?r|root/.test(t) ? "root_colour" : null,
          preferred_time: /\d/.test(t) ? message.slice(0, 40) : null,
          needs_human: false,
        };
        break;
      case "retention": {
        const moved = /moved|relocat|another salon/.test(t);
        answer = {
          reason: moved ? "moved" : /forgot|busy/.test(t) ? "forgot" : "wants_to_book",
          wants_no_more_messages: false,
          reply: moved ? "Thanks for letting us know, wishing you all the best." : "No problem at all, we'd love to see you again.",
          action: moved ? "close" : "offer_booking",
        };
        break;
      }
      case "guard":
        answer = { pass: true, issues: [] };
        break;
      case "reporter":
        throw new LLMUnavailableError("no_free_models", "the stub doesn't write summaries");
    }
    return { data: req.schema.parse(answer), model: "stub (not AI)", attempts: 1 };
  }
}
