import { AwsClient } from "aws4fetch";
import { toBase64 } from "./mime.js";

/** Sends one raw message. Resolves with the HTTP status and a short detail on failure. */
export type RawSender = (message: { from: string; to: string; raw: Uint8Array }) => Promise<SendResult>;

export type SendResult = { ok: true } | { ok: false; status: number; detail: string };

export interface SesOptions {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Optional SES configuration set (bounce and complaint events). */
  configurationSet?: string | undefined;
  /** Override for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** A RawSender backed by Amazon SES v2 `SendEmail` with raw content, signed with SigV4 (aws4fetch). */
export function sesSender(o: SesOptions): RawSender {
  const aws = new AwsClient({
    accessKeyId: o.accessKeyId,
    secretAccessKey: o.secretAccessKey,
    region: o.region,
    service: "ses",
  });
  return async ({ from, to, raw }) => {
    const req = await aws.sign(`https://email.${o.region}.amazonaws.com/v2/email/outbound-emails`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        Content: { Raw: { Data: toBase64(raw) } },
        ...(o.configurationSet ? { ConfigurationSetName: o.configurationSet } : {}),
      }),
    });
    const res = await (o.fetch ?? fetch)(req);
    if (res.ok) return { ok: true };
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    return { ok: false, status: res.status, detail };
  };
}
