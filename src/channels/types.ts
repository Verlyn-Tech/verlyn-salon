import { randomUUID } from "node:crypto";

export interface Channel {
  sendText(to: string, body: string): Promise<string>;
  sendTemplate(to: string, name: string, language: string, params: string[]): Promise<string>;
}

/** Prints instead of sending. The default everywhere except an explicit --live run. */
export class ConsoleChannel implements Channel {
  sent: { to: string; body: string; template?: string }[] = [];
  #quiet: boolean;

  constructor(quiet = false) {
    this.#quiet = quiet;
  }

  async sendText(to: string, body: string): Promise<string> {
    this.sent.push({ to, body });
    if (!this.#quiet) console.log(`\n[to ${to}]\n${body}\n`);
    return `console-${randomUUID()}`;
  }

  async sendTemplate(to: string, name: string, language: string, params: string[]): Promise<string> {
    const body = `(template ${name}/${language}) ${params.join(" | ")}`;
    this.sent.push({ to, body, template: name });
    if (!this.#quiet) console.log(`\n[to ${to}] ${body}\n`);
    return `console-${randomUUID()}`;
  }
}
