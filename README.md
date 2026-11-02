# cf-email-alias-forwarder

[![CI](https://github.com/frameprivacy/cf-email-alias-forwarder/actions/workflows/ci.yml/badge.svg)](https://github.com/frameprivacy/cf-email-alias-forwarder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Email aliases on your own domain, built on Cloudflare Email Routing, Workers KV and Amazon SES.**

Give every site its own address on a domain you own (`k7mz3q9a@alias.example.com`). Mail sent to an alias is looked
up in Workers KV and forwarded to the real inbox, with headers rewritten so it delivers cleanly and replies still
reach the sender. Turn an alias off and its mail stops, without touching your real address.

This is the forwarder behind the email aliases in [Frame](https://frameprivacy.com), with the product-specific parts
taken out and the settings made configurable.

```
sender ──SMTP──▶ Cloudflare Email Routing (catch-all on alias.example.com)
                  └─▶ this Worker ── KV lookup (ALIAS_MAP) ──▶ Amazon SES v2 SendEmail (raw) ──▶ real inbox
```

| Alias in KV         | What happens                                                    |
| ------------------- | --------------------------------------------------------------- |
| missing / malformed | rejected at SMTP time: `Address not available`                  |
| `enabled: false`    | accepted, dropped silently                                      |
| `enabled: true`     | headers rewritten, re-sent through SES from the alias's address |

Also dropped: mail this forwarder already sent (its `X-Alias-Forwarded` header, or an envelope sender on the alias
domain) and mail Cloudflare marks as malicious or spam (see [Spam](#spam)). Messages over `MAX_FORWARD_BYTES` are
rejected.

## Why SES and not `message.forward()`?

Email Routing's built-in `forward()` only sends to destination addresses verified on your Cloudflare account, which
does not work when each person brings their own inbox. Re-sending through SES from the alias itself works for any
destination, and the copy is DKIM-signed for your own domain.

## Quick start

1. **Domain and SES.** Verify your alias domain as an SES identity (with DKIM) in one region. Until SES grants
   production access it only delivers to verified addresses.
2. **IAM.** Create a user allowed only `ses:SendEmail` and `ses:SendRawEmail` on that identity.
3. **KV.** `npx wrangler kv namespace create ALIAS_MAP` and note the id.
4. **Configure.** Clone this repo, `npm ci`, then `cp wrangler.example.toml wrangler.toml` and fill in the KV id,
   `ALIAS_DOMAIN` and `SES_REGION`.
5. **Secrets.**
   ```sh
   npx wrangler secret put SES_AWS_ACCESS_KEY_ID
   npx wrangler secret put SES_AWS_SECRET_ACCESS_KEY
   npx wrangler deploy
   ```
6. **Route mail.** In the Cloudflare dashboard: Email > Email Routing for your alias domain > Routing rules >
   Catch-all > Send to a Worker > `email-alias-forwarder`. Email Routing manages the MX records. Keep SPF as
   `v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all` plus the SES DKIM CNAMEs.

No secrets go in `wrangler.toml`. For `wrangler dev`, put them in `.dev.vars` (git-ignored).

## The alias map

Your app owns the aliases and writes each one to KV:

- key: the lowercased full address, e.g. `k7mz3q9a@alias.example.com`
- value: `{"destination":"person@example.org","enabled":true}` (extra fields are ignored, so you can store an owner id)

```sh
npx wrangler kv key put --binding ALIAS_MAP "k7mz3q9a@alias.example.com" '{"destination":"me@example.org","enabled":true}'
```

KV is eventually consistent (up to about 60 seconds at the edge), so a just-disabled alias can still forward briefly.
If your database is the source of truth, run a periodic job that reconciles KV with it.

## What the forwarded copy looks like

- `From: "<original display name> (via alias)" <alias>` (RFC 2047 encoded when not ASCII; a bare address becomes
  `news at shop.example`; nothing readable becomes `Email alias`)
- `Reply-To:` the original Reply-To, else the original From, so replying reaches the sender
- `To: <destination>`, `X-Alias-Alias: <alias>`, `X-Alias-Forwarded: 1`
- removed: the original From, Sender, Reply-To, To, Bcc, Return-Path and Delivered-To, inbound `DKIM-Signature`,
  `Authentication-Results`, `ARC-*`, and any header with your prefix that the sender added (so it can't be forged)
- kept: Subject, Date, Message-ID, MIME headers, and the body byte for byte (attachments included)

Replies from the real inbox go straight to the sender and reveal the real address. Reverse aliasing (replying as the
alias) is not included.

## Settings

| Name                        | Kind                 | Notes                                                             |
| --------------------------- | -------------------- | ----------------------------------------------------------------- |
| `ALIAS_MAP`                 | KV namespace binding | Alias address to `{"destination","enabled"}`.                     |
| `ALIAS_DOMAIN`              | var, required        | e.g. `alias.example.com`. Mail to any other domain is rejected.   |
| `SES_REGION`                | var, required        | The region where the alias domain is a verified SES identity.     |
| `SES_AWS_ACCESS_KEY_ID`     | secret               | The SES-only IAM user.                                            |
| `SES_AWS_SECRET_ACCESS_KEY` | secret               |                                                                   |
| `MAX_FORWARD_BYTES`         | var                  | Default `10000000`.                                               |
| `SPAM_DROP_SCORE`           | var, optional        | Drop when `X-CF-Spamh-Score` is at or above this. Unset: ignored. |
| `SES_CONFIGURATION_SET`     | var, optional        | SES configuration set for bounce and complaint events.            |
| `FROM_LABEL`                | var, optional        | Text after the sender's name. Default `via alias`.                |
| `HEADER_PREFIX`             | var, optional        | Prefix for the added headers. Default `X-Alias-`.                 |

## Use it as a library

The Worker in `src/worker.ts` is a thin wrapper. To plug in another store, another sender, or your own logging, call
`forward` yourself:

```ts
import { forward, sesSender } from "cf-email-alias-forwarder";

export default {
  async email(message, env) {
    await forward(message, {
      store: env.ALIAS_MAP, // anything with get(key): Promise<string | null>
      domain: "alias.example.com",
      send: sesSender({ accessKeyId: env.KEY_ID, secretAccessKey: env.SECRET, region: "us-east-1" }),
      label: "via Example",
      log: (event, fields) => console.log(event, fields),
    });
  },
};
```

`send` is any `({ from, to, raw }) => Promise<{ ok: true } | { ok: false; status; detail }>`, so another provider
works too. The rewriting helpers (`rewriteMessage`, `splitMessage`, `parseMailbox`, `encodeDisplayName`,
`decodeWords`) are pure and have no Workers dependencies.

Logged events: `forwarded`, `bounced`, `send_error`, `dropped_disabled`, `dropped_spam`, `dropped_loop`,
`rejected_domain`, `rejected_unknown`, `rejected_size`. They never include addresses or message content.

## Spam

Cloudflare doesn't document a spam verdict for Email Routing. When present:

- `X-CFEmailSecurity-Disposition` (Cloudflare Email Security only): `MALICIOUS`, `UCE`, `SPAM` and `SPOOF` are
  dropped.
- `X-CF-Spamh-Score` (seen on Email Routing, undocumented): dropped only at or above `SPAM_DROP_SCORE`.

Everything else is forwarded and left to the destination's own filtering.

## Limits

- **SES sandbox**: until production access is granted, SES only delivers to verified addresses.
- **CPU**: the Workers Free plan's 10 ms CPU per invocation is tight for base64-encoding large messages. Use Workers
  Paid for real traffic. `MAX_FORWARD_BYTES` bounds the work.
- **Send errors**: a 4xx from the sender (other than 429) bounces the message with `Could not deliver`. 429 and 5xx
  throw, so the sending server gets a temporary failure and retries.

## Development

```sh
npm ci
npm test              # vitest
npm run typecheck
npm run lint
npm run format:check
```

## License

[MIT](LICENSE)
