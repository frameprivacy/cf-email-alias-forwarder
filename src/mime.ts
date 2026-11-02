/**
 * Raw RFC 5322 message handling with no Workers APIs, so it runs (and is tested) anywhere.
 *
 * The header block is handled as latin1 (one byte per char), so 8-bit bytes in headers survive untouched. The body
 * (MIME parts, attachments) is copied byte for byte.
 */

export interface HeaderField {
  /** Field name as written, e.g. `Content-Type`. */
  name: string;
  /** The whole field, folding kept, without the final line break. */
  raw: string;
}

export interface Mailbox {
  name: string | null;
  address: string;
}

/** Bytes to string, one char per byte (Workers only promise UTF-8 for TextDecoder). */
export function latin1Decode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

export function latin1Encode(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Where the header block ends: index of the blank line and its length, or null for a headers-only message. */
function headerEnd(raw: Uint8Array): { at: number; sep: number; eol: "\r\n" | "\n" } | null {
  for (let i = 0; i < raw.length - 1; i++) {
    if (raw[i] === 0x0a && raw[i + 1] === 0x0a) return { at: i, sep: 2, eol: "\n" };
    if (raw[i] === 0x0d && raw[i + 1] === 0x0a && raw[i + 2] === 0x0d && raw[i + 3] === 0x0a)
      return { at: i, sep: 4, eol: "\r\n" };
  }
  return null;
}

/** Splits a raw message into header fields (folding kept) and the untouched body bytes. */
export function splitMessage(raw: Uint8Array): { headers: HeaderField[]; body: Uint8Array; eol: "\r\n" | "\n" } {
  const end = headerEnd(raw);
  const head = latin1Decode(end ? raw.subarray(0, end.at) : raw);
  const body = end ? raw.subarray(end.at + end.sep) : new Uint8Array(0);
  const eol = end?.eol ?? (head.includes("\r\n") ? "\r\n" : "\n");
  const headers: HeaderField[] = [];
  for (const line of head.split(/\r?\n/)) {
    const last = headers[headers.length - 1];
    if (/^[ \t]/.test(line) && last) {
      last.raw += `${eol}${line}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 1) continue; // Not a header (an mbox "From " line, junk): dropped.
    headers.push({ name: line.slice(0, colon).trim(), raw: line });
  }
  return { headers, body, eol };
}

/** A header's value with folding removed (first occurrence), or null. */
export function headerValue(headers: readonly HeaderField[], name: string): string | null {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!h) return null;
  return h.raw
    .slice(h.raw.indexOf(":") + 1)
    .replace(/\r?\n[ \t]+/g, " ")
    .trim();
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    const cs = charset.toLowerCase();
    if (cs === "iso-8859-1" || cs === "latin1" || cs === "us-ascii" || cs === "ascii") return latin1Decode(bytes);
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return latin1Decode(bytes);
  }
}

/** Decodes RFC 2047 encoded-words (B and Q). Whitespace between adjacent encoded-words is dropped, as the RFC says. */
export function decodeWords(s: string): string {
  const word = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
  return s
    .replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?)/g, "$1")
    .replace(word, (whole: string, cs: string, enc: string, text: string) => {
      const charset = cs.split("*")[0] ?? cs;
      try {
        if (enc.toUpperCase() === "B") return decodeBytes(latin1Encode(atob(text)), charset);
        const bytes: number[] = [];
        const q = text.replace(/_/g, " ");
        for (let i = 0; i < q.length; i++) {
          if (q[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(q.slice(i + 1, i + 3))) {
            bytes.push(parseInt(q.slice(i + 1, i + 3), 16));
            i += 2;
          } else bytes.push(q.charCodeAt(i) & 0xff);
        }
        return decodeBytes(new Uint8Array(bytes), charset);
      } catch {
        return whole;
      }
    });
}

/** Display names: no control characters or line breaks, whitespace collapsed, at most 64 characters. */
function cleanName(s: string): string | null {
  const out = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out ? Array.from(out).slice(0, 64).join("") : null;
}

/** The first mailbox in a From or Reply-To value: display name (decoded, cleaned) and address. */
export function parseMailbox(value: string | null | undefined): Mailbox | null {
  if (!value) return null;
  const v = value.trim();
  const angle = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(v);
  if (angle?.[2]) {
    let name = (angle[1] ?? "").trim();
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2)
      name = name.slice(1, -1).replace(/\\(.)/g, "$1");
    return { name: cleanName(decodeWords(name)), address: angle[2] };
  }
  const bare = /([^\s<>(),;:"]+@[^\s<>(),;:"]+)/.exec(v.replace(/\([^)]*\)/g, " "));
  return bare?.[1] ? { name: null, address: bare[1] } : null;
}

/**
 * A display name ready for a header: a quoted string when it is printable ASCII, otherwise UTF-8 B encoded-words
 * (each at most 75 characters, folded onto continuation lines).
 */
export function encodeDisplayName(name: string, eol = "\r\n"): string {
  if (/^[\x20-\x7e]*$/.test(name)) return `"${name.replace(/[\\"]/g, "\\$&")}"`;
  const enc = new TextEncoder();
  const words: string[] = [];
  let chunk = "";
  for (const ch of Array.from(name)) {
    if (enc.encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${btoa(latin1Decode(enc.encode(w)))}?=`).join(`${eol} `);
}

/** Base64 in chunks (String.fromCharCode on a huge array overflows the stack). */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x6000; // a multiple of 3, so chunks concatenate cleanly
  for (let i = 0; i < bytes.length; i += CHUNK) out += btoa(latin1Decode(bytes.subarray(i, i + CHUNK)));
  return out;
}
