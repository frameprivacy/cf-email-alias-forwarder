/** What the alias map says about one address. Extra fields in the stored JSON are ignored. */
export interface AliasRecord {
  destination: string;
  enabled: boolean;
}

/** The stored JSON for an alias (`{"destination":"me@example.org","enabled":true}`), or null if missing or malformed. */
export function parseRecord(json: string | null | undefined): AliasRecord | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as Record<string, unknown>;
    if (typeof r.destination !== "string" || !/^[^\s<>"@]+@[^\s<>"@]+$/.test(r.destination)) return null;
    if (typeof r.enabled !== "boolean") return null;
    return { destination: r.destination, enabled: r.enabled };
  } catch {
    return null;
  }
}

export interface SpamVerdict {
  drop: boolean;
  reason: string | null;
}

/**
 * Cloudflare's verdicts, when present:
 *  - `X-CFEmailSecurity-Disposition` (Cloudflare Email Security): MALICIOUS, UCE, SPAM and SPOOF are dropped.
 *  - `X-CF-Spamh-Score` (seen on Email Routing, undocumented): dropped only when it reaches `dropScore` (unset: never).
 */
export function spamVerdict(get: (name: string) => string | null, dropScore?: number | null): SpamVerdict {
  const disposition = (get("x-cfemailsecurity-disposition") ?? "").toUpperCase();
  for (const bad of ["MALICIOUS", "UCE", "SPAM", "SPOOF"])
    if (disposition.includes(bad)) return { drop: true, reason: `disposition ${bad}` };
  const score = Number.parseFloat(get("x-cf-spamh-score") ?? "");
  if (dropScore != null && Number.isFinite(dropScore) && Number.isFinite(score) && score >= dropScore)
    return { drop: true, reason: `spam score ${String(score)}` };
  return { drop: false, reason: null };
}
