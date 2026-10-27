import { createHash } from "node:crypto";
import type { IndicatorKind } from "./crdt.js";

export interface Indicator {
  kind: IndicatorKind;
  canonical: string;
  /** SHA-256 of the canonical form: shards store only this, never raw numbers or links. */
  key: string;
}

export class InvalidIndicator extends Error {}

const keyOf = (kind: IndicatorKind, canonical: string) =>
  createHash("sha256").update(`${kind}:${canonical}`).digest("hex").slice(0, 32);

/**
 * Canonicalises a phone number to E.164. Bare 10-digit numbers starting 6-9 and
 * trunk-prefixed (0XXXXXXXXXX) numbers are treated as Indian mobiles.
 */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  if (trimmed.startsWith("+") && /^\d{8,15}$/.test(digits)) return `+${digits}`;
  throw new InvalidIndicator(`not a valid phone number: ${raw}`);
}

/**
 * Reduces a link to its hostname: scam campaigns rotate paths and query strings,
 * but reuse domains. IDN hostnames are punycoded by the URL parser so look-alike
 * Unicode domains map to one stable key.
 */
export function normalizeUrl(raw: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidIndicator(`not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new InvalidIndicator(`unsupported scheme: ${url.protocol}`);
  const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!host.includes(".")) throw new InvalidIndicator(`not a public hostname: ${raw}`);
  return host;
}

export function parseIndicator(raw: string, kind?: IndicatorKind): Indicator {
  const detected: IndicatorKind = kind ?? (/^[+\d][\d\s()-]{7,}$/.test(raw.trim()) ? "phone" : "url");
  const canonical = detected === "phone" ? normalizePhone(raw) : normalizeUrl(raw);
  return { kind: detected, canonical, key: keyOf(detected, canonical) };
}
