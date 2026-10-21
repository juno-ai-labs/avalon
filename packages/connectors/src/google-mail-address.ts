import { z } from "zod";
import { ConnectorError } from "./types";

/** Parse mailbox lists, preserving dot-atom addresses and never mining display names for addresses. */
export function replyMailboxes(header: string, field: string): string[] {
  const refuse = (): never => { throw new ConnectorError("invalid_payload", `${field}: the reply address uses missing or unsupported mailbox syntax. Supply explicit to recipients. No email was sent or drafted.`, { field, reason: "reply_address_unavailable" }); };
  const mailboxes: string[] = [];
  let value = "";
  let quoted = false;
  let escaped = false;
  let commentDepth = 0;
  let angle = false;
  const append = () => {
    const mailbox = value.trim();
    const enclosed = /^(?:"(?:[^"\\]|\\.)*"|[^<>"\r\n]*)\s*<([^<>]+)>$/u.exec(mailbox);
    const address = (enclosed?.[1] ?? mailbox).trim();
    // RFC 5322 dot-atom local parts, including apostrophes. Quoted local
    // parts and groups are deliberately refused instead of rewritten.
    const match = /^([A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@([^\s<>]+)$/u.exec(address);
    if (!match || !z.string().email().safeParse(`mailbox@${match[2]}`).success) refuse();
    mailboxes.push(address);
    value = "";
  };
  for (const char of header.replace(/\r?\n[ \t]+/gu, " ")) {
    if (escaped) { if (!commentDepth) value += char; escaped = false; continue; }
    if ((quoted || commentDepth > 0) && char === "\\") { if (!commentDepth) value += char; escaped = true; continue; }
    if (!quoted && char === "(") { commentDepth++; continue; }
    if (commentDepth) { if (char === ")") commentDepth--; continue; }
    if (char === '"') quoted = !quoted;
    if (!quoted) {
      if (char === "<") { if (angle) refuse(); angle = true; }
      if (char === ">") { if (!angle) refuse(); angle = false; }
      if (char === "," && !angle) { append(); continue; }
      if (char === "\r" || char === "\n" || char === ")") refuse();
    }
    value += char;
  }
  if (quoted || escaped || commentDepth || angle) refuse();
  append();
  return [...new Set(mailboxes)];
}
