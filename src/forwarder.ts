import { splitMessage } from "./mime.js";
import { parseRecord, spamVerdict } from "./policy.js";
import { isLoop, rewriteMessage, type RewriteOptions } from "./rewrite.js";
import type { RawSender } from "./ses.js";

/** The parts of Cloudflare's `ForwardableEmailMessage` the forwarder uses. */
export interface IncomingMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: { get(name: string): string | null };
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

/** The parts of a Workers KV namespace the forwarder uses (any `get(key)` store works). */
export interface AliasStore {
  get(key: string): Promise<string | null>;
}

export type ForwardEvent =
  | "rejected_domain"
  | "rejected_unknown"
  | "rejected_size"
  | "dropped_disabled"
  | "dropped_spam"
  | "dropped_loop"
  | "forwarded"
  | "bounced"
  | "send_error";

export interface ForwarderOptions extends RewriteOptions {
  /** Where aliases live, keyed by the lowercased full address. */
  store: AliasStore;
  /** Sends the rewritten message (see `sesSender`). */
  send: RawSender;
  /** The alias domain, e.g. `alias.example.com`. Mail to any other domain is rejected. */
  domain: string;
  /** Larger messages are rejected. Default 10 MB. */
  maxBytes?: number;
  /** Drop when `X-CF-Spamh-Score` reaches this. Unset: the score is ignored. */
  spamDropScore?: number | null;
  /** Structured log hook. Gets an event name and fields; never message content or addresses. */
  log?: (event: ForwardEvent, fields?: Record<string, unknown>) => void;
}

/**
 * Handles one message from Cloudflare Email Routing:
 *
 *     other domain / unknown alias → rejected at SMTP time ("Address not available")
 *     alias turned off             → accepted and dropped
 *     loop or spam verdict         → dropped
 *     too large                    → rejected ("Message too large")
 *     active                       → headers rewritten and re-sent from the alias
 *
 * A permanent send failure (4xx other than 429) bounces with "Could not deliver". A temporary one (429, 5xx) throws,
 * so Email Routing answers with a temporary failure and the sending server retries.
 */
export async function forward(message: IncomingMessage, o: ForwarderOptions): Promise<void> {
  const log = o.log ?? (() => undefined);
  const alias = message.to.trim().toLowerCase();
  const domain = o.domain.toLowerCase();
  if (!alias.endsWith(`@${domain}`)) {
    log("rejected_domain");
    message.setReject("Address not available");
    return;
  }
  const record = parseRecord(await o.store.get(alias));
  if (!record) {
    log("rejected_unknown");
    message.setReject("Address not available");
    return;
  }
  if (!record.enabled) {
    log("dropped_disabled");
    return;
  }
  const verdict = spamVerdict((n) => message.headers.get(n), o.spamDropScore ?? null);
  if (verdict.drop) {
    log("dropped_spam", { reason: verdict.reason });
    return;
  }
  if (message.rawSize > (o.maxBytes ?? 10_000_000)) {
    log("rejected_size", { bytes: message.rawSize });
    message.setReject("Message too large");
    return;
  }

  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  if (isLoop(splitMessage(raw).headers, domain, message.from, o.headerPrefix)) {
    log("dropped_loop");
    return;
  }
  const out = rewriteMessage({
    raw,
    alias,
    destination: record.destination,
    envelopeFrom: message.from,
    ...(o.label !== undefined ? { label: o.label } : {}),
    ...(o.headerPrefix !== undefined ? { headerPrefix: o.headerPrefix } : {}),
    ...(o.fallbackName !== undefined ? { fallbackName: o.fallbackName } : {}),
  });
  const res = await o.send({ from: alias, to: record.destination, raw: out.raw });
  if (res.ok) {
    log("forwarded", { bytes: out.raw.length });
    return;
  }
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    log("bounced", { status: res.status, detail: res.detail });
    message.setReject("Could not deliver");
    return;
  }
  log("send_error", { status: res.status, detail: res.detail });
  throw new Error(`send failed with status ${String(res.status)}`);
}
