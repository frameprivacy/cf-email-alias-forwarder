import { forward, type AliasStore, type IncomingMessage } from "./forwarder.js";
import { sesSender } from "./ses.js";

/** Bindings, variables and secrets for the ready-made Worker (see README). */
export interface Env {
  /** KV namespace: lowercased alias address → `{"destination","enabled"}`. */
  ALIAS_MAP: AliasStore;
  /** Your alias domain, e.g. `alias.example.com`. Required. */
  ALIAS_DOMAIN: string;
  SES_AWS_ACCESS_KEY_ID: string;
  SES_AWS_SECRET_ACCESS_KEY: string;
  /** The AWS region where the alias domain is a verified SES identity. Required. */
  SES_REGION: string;
  SES_CONFIGURATION_SET?: string;
  /** Default 10000000. */
  MAX_FORWARD_BYTES?: string;
  /** Drop at or above this `X-CF-Spamh-Score`. Unset: ignored. */
  SPAM_DROP_SCORE?: string;
  /** Shown after the sender's name. Default `via alias`. */
  FROM_LABEL?: string;
  /** Prefix for the headers this forwarder adds. Default `X-Alias-`. */
  HEADER_PREFIX?: string;
}

const num = (v: string | undefined) => {
  const n = Number.parseFloat(v ?? "");
  return Number.isFinite(n) ? n : null;
};

/** The Worker: point an Email Routing catch-all rule at it. */
export default {
  async email(message: IncomingMessage, env: Env): Promise<void> {
    if (!env.ALIAS_DOMAIN || !env.SES_REGION) throw new Error("ALIAS_DOMAIN and SES_REGION must be set");
    await forward(message, {
      store: env.ALIAS_MAP,
      domain: env.ALIAS_DOMAIN,
      send: sesSender({
        accessKeyId: env.SES_AWS_ACCESS_KEY_ID,
        secretAccessKey: env.SES_AWS_SECRET_ACCESS_KEY,
        region: env.SES_REGION,
        configurationSet: env.SES_CONFIGURATION_SET,
      }),
      maxBytes: num(env.MAX_FORWARD_BYTES) ?? 10_000_000,
      spamDropScore: num(env.SPAM_DROP_SCORE),
      ...(env.FROM_LABEL ? { label: env.FROM_LABEL } : {}),
      ...(env.HEADER_PREFIX ? { headerPrefix: env.HEADER_PREFIX } : {}),
      log: (event, fields = {}) => {
        console.log(JSON.stringify({ event, ...fields }));
      },
    });
  },
};
