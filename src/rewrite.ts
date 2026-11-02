import {
  encodeDisplayName,
  headerValue,
  latin1Encode,
  parseMailbox,
  splitMessage,
  type HeaderField,
  type Mailbox,
} from "./mime.js";

/** Headers replaced on the forwarded copy, plus inbound authentication that would fail (or lie) once re-sent. */
const DROP = new Set([
  "from",
  "sender",
  "reply-to",
  "to",
  "bcc",
  "return-path",
  "delivered-to",
  "dkim-signature",
  "domainkey-signature",
  "x-google-dkim-signature",
  "authentication-results",
  "arc-seal",
  "arc-message-signature",
  "arc-authentication-results",
]);

export const DEFAULT_HEADER_PREFIX = "X-Alias-";
export const DEFAULT_LABEL = "via alias";
export const DEFAULT_FALLBACK_NAME = "Email alias";

export interface RewriteOptions {
  /** Shown after the sender's name: `"Shop (via alias)" <alias>`. Default `via alias`. */
  label?: string;
  /** Prefix of the headers this forwarder adds (and strips from inbound mail so they can't be forged). Default `X-Alias-`. */
  headerPrefix?: string;
  /** The display name when the sender can't be read at all. Default `Email alias`. */
  fallbackName?: string;
}

export interface RewriteInput extends RewriteOptions {
  raw: Uint8Array;
  /** The alias the mail was sent to; becomes the From address. */
  alias: string;
  /** The real inbox. */
  destination: string;
  /** SMTP envelope sender, used when the From header can't be read. */
  envelopeFrom?: string | null;
}

export interface RewriteResult {
  raw: Uint8Array;
  /** Where replies go: the original Reply-To, else the original From. */
  replyTo: string | null;
  originalFrom: Mailbox | null;
}

const prefixOf = (o: RewriteOptions) => o.headerPrefix ?? DEFAULT_HEADER_PREFIX;
const ADDRESS = /^[^\s<>"]+@[^\s<>"]+$/;

/**
 * Builds the forwarded copy:
 *
 *     From:     "<original display name> (<label>)" <alias>
 *     Reply-To: the original Reply-To, or the original From, so replying reaches the sender
 *     To:       the destination
 *     <prefix>Alias / <prefix>Forwarded: loop guard and filtering
 *
 * Subject and every other header stay; inbound DKIM signatures and authentication results are removed; the body is
 * copied byte for byte.
 */
export function rewriteMessage(input: RewriteInput): RewriteResult {
  const prefix = prefixOf(input);
  const label = input.label ?? DEFAULT_LABEL;
  const { headers, body, eol } = splitMessage(input.raw);
  const from = parseMailbox(headerValue(headers, "from")) ?? parseMailbox(input.envelopeFrom);
  const replyTo = parseMailbox(headerValue(headers, "reply-to"))?.address ?? from?.address ?? null;
  const shown = from?.name ?? (from ? from.address.replace("@", " at ") : null);
  const display = shown ? `${shown} (${label})` : (input.fallbackName ?? DEFAULT_FALLBACK_NAME);

  const strip = prefix.toLowerCase();
  const kept = headers.filter((h) => {
    const n = h.name.toLowerCase();
    return !DROP.has(n) && !n.startsWith(strip);
  });
  const added = [
    `From: ${encodeDisplayName(display, eol)} <${input.alias}>`,
    ...(replyTo && ADDRESS.test(replyTo) ? [`Reply-To: <${replyTo}>`] : []),
    `To: <${input.destination}>`,
    `${prefix}Alias: ${input.alias}`,
    `${prefix}Forwarded: 1`,
  ];
  const head = latin1Encode([...added, ...kept.map((h) => h.raw)].join(eol) + eol + eol);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return { raw: out, replyTo, originalFrom: from };
}

/** Mail this forwarder already sent (or anything from the alias domain) must not be forwarded again. */
export function isLoop(
  headers: readonly HeaderField[],
  aliasDomain: string,
  envelopeFrom?: string | null,
  headerPrefix: string = DEFAULT_HEADER_PREFIX,
): boolean {
  if (headerValue(headers, `${headerPrefix}Forwarded`)) return true;
  return (envelopeFrom ?? "").toLowerCase().endsWith(`@${aliasDomain.toLowerCase()}`);
}
