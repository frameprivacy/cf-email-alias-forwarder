import { describe, expect, test, vi } from "vitest";
import {
  forward,
  sesSender,
  worker,
  type ForwarderOptions,
  type IncomingMessage,
  type RawSender,
} from "../src/index.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const DOMAIN = "alias.example.com";
const ALIAS = `k7mz3q9a@${DOMAIN}`;
const DEST = "me@example.org";
const MAIL = 'From: "Shop" <news@shop.example>\r\nTo: k7mz3q9a@alias.example.com\r\nSubject: Hi\r\n\r\nHello\r\n';

function message(
  opts: { to?: string; from?: string; raw?: string; headers?: Record<string, string>; size?: number } = {},
) {
  const raw = enc(opts.raw ?? MAIL);
  const rejected: string[] = [];
  const m: IncomingMessage = {
    to: opts.to ?? ALIAS,
    from: opts.from ?? "bounce@shop.example",
    headers: { get: (n) => opts.headers?.[n.toLowerCase()] ?? null },
    raw: new Response(raw).body as ReadableStream<Uint8Array>,
    rawSize: opts.size ?? raw.length,
    setReject: (r) => rejected.push(r),
  };
  return { m, rejected };
}

function setup(records: Record<string, unknown>, send: RawSender = vi.fn<RawSender>(async () => ({ ok: true }))) {
  const events: string[] = [];
  const o: ForwarderOptions = {
    domain: DOMAIN,
    store: { get: async (k) => (k in records ? JSON.stringify(records[k]) : null) },
    send,
    log: (e) => events.push(e),
  };
  return { o, events, send };
}

describe("forward", () => {
  test("re-sends an active alias from the alias to the destination", async () => {
    const send = vi.fn<RawSender>(async () => ({ ok: true }));
    const { o, events } = setup({ [ALIAS]: { destination: DEST, enabled: true } }, send);
    const { m, rejected } = message({ to: ` ${ALIAS.toUpperCase()} ` });
    await forward(m, o);
    expect(rejected).toEqual([]);
    expect(events).toEqual(["forwarded"]);
    expect(send).toHaveBeenCalledOnce();
    const arg = send.mock.calls[0]?.[0];
    expect(arg?.from).toBe(ALIAS);
    expect(arg?.to).toBe(DEST);
    const text = dec(arg?.raw ?? new Uint8Array());
    expect(text).toContain(`From: "Shop (via alias)" <${ALIAS}>`);
    expect(text).toContain(`To: <${DEST}>`);
    expect(text.endsWith("\r\n\r\nHello\r\n")).toBe(true);
  });

  test("rejects other domains and unknown or malformed aliases at SMTP time", async () => {
    const { o, events, send } = setup({ [ALIAS]: { destination: "not-an-address", enabled: true } });
    const other = message({ to: "a@elsewhere.example" });
    await forward(other.m, o);
    const unknown = message({ to: `nobody@${DOMAIN}` });
    await forward(unknown.m, o);
    const malformed = message();
    await forward(malformed.m, o);
    expect([other.rejected, unknown.rejected, malformed.rejected]).toEqual([
      ["Address not available"],
      ["Address not available"],
      ["Address not available"],
    ]);
    expect(events).toEqual(["rejected_domain", "rejected_unknown", "rejected_unknown"]);
    expect(send).not.toHaveBeenCalled();
  });

  test("drops disabled aliases, spam verdicts and loops without bouncing", async () => {
    const { o, events, send } = setup({
      [ALIAS]: { destination: DEST, enabled: true },
      [`off@${DOMAIN}`]: { destination: DEST, enabled: false },
    });
    const off = message({ to: `off@${DOMAIN}` });
    await forward(off.m, o);
    const spam = message({ headers: { "x-cfemailsecurity-disposition": "MALICIOUS" } });
    await forward(spam.m, o);
    const loopHeader = message({ raw: `X-Alias-Forwarded: 1\r\n${MAIL}` });
    await forward(loopHeader.m, o);
    const loopSender = message({ from: `x@${DOMAIN}` });
    await forward(loopSender.m, o);
    expect(events).toEqual(["dropped_disabled", "dropped_spam", "dropped_loop", "dropped_loop"]);
    for (const r of [off, spam, loopHeader, loopSender]) expect(r.rejected).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  test("the spam score only drops with a threshold", async () => {
    const { o, events } = setup({ [ALIAS]: { destination: DEST, enabled: true } });
    await forward(message({ headers: { "x-cf-spamh-score": "9" } }).m, o);
    await forward(message({ headers: { "x-cf-spamh-score": "9" } }).m, { ...o, spamDropScore: 5 });
    expect(events).toEqual(["forwarded", "dropped_spam"]);
  });

  test("rejects messages over maxBytes", async () => {
    const { o, events } = setup({ [ALIAS]: { destination: DEST, enabled: true } });
    const big = message({ size: 11_000_000 });
    await forward(big.m, o);
    const small = message({ size: 200 });
    await forward(small.m, { ...o, maxBytes: 100 });
    expect([big.rejected, small.rejected]).toEqual([["Message too large"], ["Message too large"]]);
    expect(events).toEqual(["rejected_size", "rejected_size"]);
  });

  test("permanent send failures bounce; 429 and 5xx throw so the sender retries", async () => {
    const records = { [ALIAS]: { destination: DEST, enabled: true } };
    const bounce = setup(records, async () => ({ ok: false, status: 400, detail: "sandbox" }));
    const b = message();
    await forward(b.m, bounce.o);
    expect(b.rejected).toEqual(["Could not deliver"]);
    expect(bounce.events).toEqual(["bounced"]);
    for (const status of [429, 500, 503]) {
      const retry = setup(records, async () => ({ ok: false, status, detail: "" }));
      const r = message();
      await expect(forward(r.m, retry.o)).rejects.toThrow(String(status));
      expect(r.rejected).toEqual([]);
      expect(retry.events).toEqual(["send_error"]);
    }
  });
});

describe("sesSender", () => {
  test("posts a SigV4-signed SES v2 raw SendEmail", async () => {
    const seen: Request[] = [];
    const fake = vi.fn(async (req: RequestInfo | URL): Promise<Response> => {
      seen.push(req as Request);
      return new Response("{}", { status: 200 });
    });
    const send = sesSender({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "test-secret-not-real",
      region: "us-east-1",
      configurationSet: "aliases",
      fetch: fake,
    });
    expect(await send({ from: ALIAS, to: DEST, raw: enc("Subject: s\r\n\r\nb") })).toEqual({ ok: true });
    const req = seen[0];
    expect(req?.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
    expect(req?.method).toBe("POST");
    expect(req?.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ses\/aws4_request/,
    );
    const body = (await req?.json()) as Record<string, unknown>;
    expect(body).toEqual({
      FromEmailAddress: ALIAS,
      Destination: { ToAddresses: [DEST] },
      Content: { Raw: { Data: Buffer.from("Subject: s\r\n\r\nb").toString("base64") } },
      ConfigurationSetName: "aliases",
    });
  });

  test("reports the status and a short detail on failure", async () => {
    const send = sesSender({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "test-secret-not-real",
      region: "us-east-1",
      fetch: async () => new Response("x".repeat(1000), { status: 400 }),
    });
    const res = await send({ from: ALIAS, to: DEST, raw: enc("a") });
    expect(res).toEqual({ ok: false, status: 400, detail: "x".repeat(300) });
  });
});

describe("worker", () => {
  test("refuses to run without ALIAS_DOMAIN and SES_REGION", async () => {
    const { m } = message();
    await expect(
      worker.email(m, {
        ALIAS_MAP: { get: async () => null },
        ALIAS_DOMAIN: "",
        SES_REGION: "",
        SES_AWS_ACCESS_KEY_ID: "",
        SES_AWS_SECRET_ACCESS_KEY: "",
      }),
    ).rejects.toThrow("ALIAS_DOMAIN and SES_REGION must be set");
  });

  test("rejects an unknown alias using the env bindings", async () => {
    const { m, rejected } = message({ to: `nobody@${DOMAIN}` });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await worker.email(m, {
      ALIAS_MAP: { get: async () => null },
      ALIAS_DOMAIN: DOMAIN,
      SES_REGION: "us-east-1",
      SES_AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
      SES_AWS_SECRET_ACCESS_KEY: "test-secret-not-real",
    });
    expect(rejected).toEqual(["Address not available"]);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "rejected_unknown" }));
    log.mockRestore();
  });
});
