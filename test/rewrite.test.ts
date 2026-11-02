import { describe, expect, test } from "vitest";
import {
  decodeWords,
  encodeDisplayName,
  isLoop,
  parseMailbox,
  parseRecord,
  rewriteMessage,
  spamVerdict,
  splitMessage,
  toBase64,
} from "../src/index.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const ALIAS = "k7mz3q9a@alias.example.com";
const DEST = "me@example.org";

const MESSAGE = [
  'From: "Shop News" <news@shop.example>',
  "To: k7mz3q9a@alias.example.com",
  "Subject: Your order",
  "DKIM-Signature: v=1; a=rsa-sha256; d=shop.example;",
  "\tb=abc123",
  "Authentication-Results: mx.cloudflare.net; spf=pass",
  "ARC-Seal: i=1; cv=none",
  "Return-Path: <bounce@shop.example>",
  "X-Alias-Forwarded: forged",
  "Message-ID: <1@shop.example>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain",
  "",
  "Hello",
  "--b1--",
  "",
].join("\r\n");

const headerLines = (raw: Uint8Array) => (dec(raw).split("\r\n\r\n")[0] ?? "").split("\r\n");

test("rewrites From, Reply-To and To, and keeps Subject and MIME headers", () => {
  const out = rewriteMessage({ raw: enc(MESSAGE), alias: ALIAS, destination: DEST });
  const lines = headerLines(out.raw);
  expect(lines).toContain(`From: "Shop News (via alias)" <${ALIAS}>`);
  expect(lines).toContain("Reply-To: <news@shop.example>");
  expect(lines).toContain(`To: <${DEST}>`);
  expect(lines).toContain(`X-Alias-Alias: ${ALIAS}`);
  expect(lines).toContain("X-Alias-Forwarded: 1");
  expect(lines).toContain("Subject: Your order");
  expect(lines).toContain("Message-ID: <1@shop.example>");
  expect(lines).toContain('Content-Type: multipart/mixed; boundary="b1"');
  expect(out.replyTo).toBe("news@shop.example");
});

test("removes inbound DKIM, authentication results, ARC, Return-Path and forged X-Alias- headers", () => {
  const text = dec(rewriteMessage({ raw: enc(MESSAGE), alias: ALIAS, destination: DEST }).raw);
  for (const gone of ["DKIM-Signature", "b=abc123", "Authentication-Results", "ARC-Seal", "Return-Path", "forged"])
    expect(text).not.toContain(gone);
  expect(text.match(/^From:/gm)).toHaveLength(1);
  expect(text.match(/^To:/gm)).toHaveLength(1);
});

test("copies the body byte for byte, binary included", () => {
  const body = new Uint8Array([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x41]);
  const head = enc("From: a@b.example\r\nSubject: bin\r\n\r\n");
  const raw = new Uint8Array(head.length + body.length);
  raw.set(head);
  raw.set(body, head.length);
  const out = rewriteMessage({ raw, alias: ALIAS, destination: DEST }).raw;
  expect(Array.from(out.slice(out.length - body.length))).toEqual(Array.from(body));
  expect(splitMessage(out).body).toEqual(body);
});

test("keeps 8-bit header bytes as they were", () => {
  const raw = new Uint8Array([...enc("From: x@y.example\r\nSubject: caf"), 0xe9, ...enc("\r\n\r\nhi")]);
  const out = rewriteMessage({ raw, alias: ALIAS, destination: DEST }).raw;
  const i = out.indexOf(0xe9);
  expect(i).toBeGreaterThan(0);
  expect(dec(out.slice(i - 3, i))).toBe("caf");
});

test("prefers the original Reply-To, falls back to From, then to the envelope sender", () => {
  const withReply = enc("From: A <a@x.example>\r\nReply-To: Help <help@x.example>\r\n\r\nb");
  expect(rewriteMessage({ raw: withReply, alias: ALIAS, destination: DEST }).replyTo).toBe("help@x.example");
  const noFrom = enc("Subject: s\r\n\r\nb");
  const out = rewriteMessage({ raw: noFrom, alias: ALIAS, destination: DEST, envelopeFrom: "bounce@x.example" });
  expect(out.replyTo).toBe("bounce@x.example");
  expect(headerLines(out.raw)).toContain(`From: "bounce at x.example (via alias)" <${ALIAS}>`);
});

test("a bare address becomes a readable name; nothing at all becomes the fallback name", () => {
  const bare = rewriteMessage({ raw: enc("From: news@shop.example\r\n\r\nb"), alias: ALIAS, destination: DEST });
  expect(headerLines(bare.raw)).toContain(`From: "news at shop.example (via alias)" <${ALIAS}>`);
  const none = rewriteMessage({ raw: enc("Subject: s\r\n\r\nb"), alias: ALIAS, destination: DEST });
  expect(headerLines(none.raw)).toContain(`From: "Email alias" <${ALIAS}>`);
  expect(none.replyTo).toBeNull();
});

test("decodes encoded display names and re-encodes non-ASCII as UTF-8 B words", () => {
  expect(decodeWords("=?UTF-8?B?Q2Fmw6k=?=")).toBe("Café");
  expect(decodeWords("=?ISO-8859-1?Q?Caf=E9_Bar?=")).toBe("Café Bar");
  expect(decodeWords("=?UTF-8?Q?a?= =?UTF-8?Q?b?=")).toBe("ab");
  expect(parseMailbox('"Caf\\"e" <c@x.example>')).toEqual({ name: 'Caf"e', address: "c@x.example" });
  const out = rewriteMessage({
    raw: enc("From: =?UTF-8?B?Q2Fmw6k=?= <c@x.example>\r\n\r\nb"),
    alias: ALIAS,
    destination: DEST,
  });
  const from = headerLines(out.raw).find((l) => l.startsWith("From:"))!;
  expect(from).toMatch(/^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <k7mz3q9a@alias\.example\.com>$/);
  expect(decodeWords(from.slice(6, from.indexOf(" <")))).toBe("Café (via alias)");
});

test("long non-ASCII names fold into encoded-words of at most 75 characters", () => {
  const name = "Élise ".repeat(20).trim();
  const encoded = encodeDisplayName(name);
  for (const w of encoded.split("\r\n ")) expect(w.length).toBeLessThanOrEqual(75);
  expect(decodeWords(encoded.replace(/\r\n /g, " "))).toBe(name);
});

test("quotes and escapes ASCII names; strips line breaks a sender smuggles in", () => {
  expect(encodeDisplayName('A "B" \\ C')).toBe('"A \\"B\\" \\\\ C"');
  const m = parseMailbox("=?UTF-8?Q?Evil=0D=0ABcc:_x@y?= <e@x.example>");
  expect(m?.name).toBe("Evil Bcc: x@y");
});

test("unfolds headers and handles bare-LF messages", () => {
  const raw = enc("From: Long\n Name <l@x.example>\nSubject: s\n\nbody\n");
  const { headers, eol } = splitMessage(raw);
  expect(eol).toBe("\n");
  expect(
    parseMailbox(
      headers
        .find((h) => h.name === "From")!
        .raw.slice(5)
        .replace(/\n /, " "),
    )?.name,
  ).toBe("Long Name");
  const out = dec(rewriteMessage({ raw, alias: ALIAS, destination: DEST }).raw);
  expect(out).toContain(`From: "Long Name (via alias)" <${ALIAS}>\n`);
  expect(out.endsWith("\n\nbody\n")).toBe(true);
});

test("loop guard: our own header or an envelope sender on the alias domain", () => {
  expect(isLoop(splitMessage(enc("X-Alias-Forwarded: 1\r\n\r\n")).headers, "alias.example.com")).toBe(true);
  expect(isLoop([], "alias.example.com", "x@Alias.Example.com")).toBe(true);
  expect(isLoop([], "alias.example.com", "x@shop.example")).toBe(false);
});

test("spam verdicts: dispositions drop, the score only with a threshold", () => {
  const h = (m: Record<string, string>) => (n: string) => m[n] ?? null;
  expect(spamVerdict(h({ "x-cfemailsecurity-disposition": "MALICIOUS" })).drop).toBe(true);
  expect(spamVerdict(h({ "x-cfemailsecurity-disposition": "BULK" })).drop).toBe(false);
  expect(spamVerdict(h({ "x-cf-spamh-score": "9" })).drop).toBe(false);
  expect(spamVerdict(h({ "x-cf-spamh-score": "9" }), 5).drop).toBe(true);
  expect(spamVerdict(h({ "x-cf-spamh-score": "2" }), 5).drop).toBe(false);
});

test("stored records are validated; extra fields are ignored", () => {
  expect(parseRecord('{"destination":"me@x.example","enabled":true,"userId":"u"}')).toEqual({
    destination: "me@x.example",
    enabled: true,
  });
  expect(parseRecord('{"destination":"bad","enabled":true,"userId":"u"}')).toBeNull();
  expect(parseRecord('{"destination":"me@x.example","enabled":"yes","userId":"u"}')).toBeNull();
  expect(parseRecord("not json")).toBeNull();
  expect(parseRecord(null)).toBeNull();
});

test("base64 in chunks matches Buffer", () => {
  const bytes = new Uint8Array(100_003).map((_, i) => (i * 31) & 0xff);
  expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
});

describe("options", () => {
  test("label, fallback name and header prefix are configurable", () => {
    const opts = { label: "via Example", fallbackName: "Example alias", headerPrefix: "X-Example-" };
    const out = rewriteMessage({
      raw: enc("From: A <a@x.example>\r\nX-Example-Alias: forged\r\n\r\nb"),
      alias: ALIAS,
      destination: DEST,
      ...opts,
    });
    const lines = headerLines(out.raw);
    expect(lines).toContain(`From: "A (via Example)" <${ALIAS}>`);
    expect(lines).toContain(`X-Example-Alias: ${ALIAS}`);
    expect(lines).toContain("X-Example-Forwarded: 1");
    expect(lines).not.toContain("X-Example-Alias: forged");
    const none = rewriteMessage({ raw: enc("Subject: s\r\n\r\nb"), alias: ALIAS, destination: DEST, ...opts });
    expect(headerLines(none.raw)).toContain(`From: "Example alias" <${ALIAS}>`);
    expect(isLoop(splitMessage(out.raw).headers, "alias.example.com", null, "X-Example-")).toBe(true);
    expect(isLoop(splitMessage(out.raw).headers, "alias.example.com", null)).toBe(false);
  });
});
