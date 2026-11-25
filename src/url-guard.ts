/**
 * Where the desk browser may go. A TypeScript port of the FluidGrids remote
 * browser node's guard (fluidgrids-nodes `remotebrowser_guard.py`, BOFF-9967),
 * so the two browser surfaces refuse the same places. Both checks fail closed.
 *
 * - {@link checkNavigation} (async, resolves DNS): every `navigate` action and
 *   the final URL after it. http(s) only, no user name or password in the URL,
 *   and every address the host resolves to must be globally routable.
 *   Loopback, private (RFC 1918), carrier-grade NAT, link-local (the cloud
 *   metadata address 169.254.169.254 among them), multicast, reserved and
 *   unspecified addresses are refused, as are IPv4-mapped forms of them and
 *   names such as `localhost`, `*.local`, `*.internal` and single-label names.
 *   An allow-list, when configured, must also match the host.
 * - {@link quickBlockReason} (sync, no DNS): every request the page makes
 *   (images, scripts, XHR, redirects it starts itself). Refuses non-web
 *   schemes and hosts that are private by their spelling, without a DNS
 *   lookup per request.
 *
 * Limits, stated plainly: Chromium resolves names itself, so a name that
 * resolves to a public address here and a private one a moment later (DNS
 * rebinding) is not caught by this guard. A cloud desk is covered by its
 * egress proxy, which checks the address it actually connects to
 * (gitops `platform/addons/steward-desks`). An own-machine desk has no proxy:
 * the user's network is theirs, and the consent screen says so (spec §8).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) => {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

const WEB_SCHEMES = new Set(["http:", "https:"]);
/** Schemes a page may load without a network request of its own. */
const LOCAL_SCHEMES = new Set(["data:", "blob:", "about:"]);
const BLOCKED_NAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "instance-data",
  "metadata.google.internal",
]);
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".lan",
  ".intranet",
  ".corp",
];

export interface GuardOptions {
  /** Hosts the desk may visit; empty means any public host. `*.example.com` matches subdomains. */
  allowedHosts?: readonly string[];
  /** Name resolution, injectable for tests. */
  resolver?: Resolver;
  /**
   * Allow private, loopback and link-local destinations. Tests only: the
   * plugin never sets it from configuration.
   */
  allowPrivateNetwork?: boolean;
}

export class GuardError extends Error {
  override name = "GuardError";
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4Blocked(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  return V4_BLOCKS.some(([base, bits]) => {
    const b = ipv4ToInt(base) as number;
    const size = 2 ** (32 - bits);
    return n >= b && n < b + size;
  });
}

/** Expand an IPv6 address to 8 hextets; null when malformed. */
function expandV6(input: string): number[] | null {
  let ip = input.toLowerCase();
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  // Trailing dotted IPv4 (::ffff:1.2.3.4) becomes two hextets.
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const n = ipv4ToInt(tail);
    if (n === null) return null;
    ip = `${ip.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const groups = [
    ...head,
    ...Array<string>(Math.max(missing, 0)).fill("0"),
    ...rest,
  ];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out.length === 8 ? out : null;
}

function v6Blocked(ip: string): boolean {
  const h = expandV6(ip);
  if (!h) return true;
  const [a, b, c, d, e, f, g, last] = h as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const zeroPrefix = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible): judge the IPv4 part.
  if (zeroPrefix && (f === 0xffff || f === 0)) {
    if (f === 0 && g === 0 && (last === 0 || last === 1)) return true; // :: and ::1
    return v4Blocked(`${g >> 8}.${g & 0xff}.${last >> 8}.${last & 0xff}`);
  }
  // 64:ff9b::/96 (NAT64 of an IPv4 address): judge the IPv4 part.
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
    return v4Blocked(`${g >> 8}.${g & 0xff}.${last >> 8}.${last & 0xff}`);
  }
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (incl. fd00:ec2::254)
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x2002) {
    // 6to4 embeds an IPv4 address.
    return v4Blocked(`${b >> 8}.${b & 0xff}.${c >> 8}.${c & 0xff}`);
  }
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return true; // discard-only
  return false;
}

/** True when `ip` is not a globally routable unicast address. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return v4Blocked(ip);
  if (family === 6) return v6Blocked(ip);
  return true;
}

// ---------------------------------------------------------------------------
// Host checks
// ---------------------------------------------------------------------------

function bareHost(hostname: string): string {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

function blockedByName(host: string): string | null {
  if (BLOCKED_NAMES.has(host)) return `${host} is a local name`;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s)))
    return `${host} is a local name`;
  if (isIP(host) === 0 && !host.includes("."))
    return `${host} is a single-label name`;
  return null;
}

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith("*.")) return host.endsWith(rule.slice(1));
    return host === rule;
  });
}

/**
 * Parse an allow-list from configuration: comma or whitespace separated
 * host names, `*.` prefix for subdomains. Anything else is dropped.
 */
export function parseAllowedHosts(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) =>
      /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
        s,
      ),
    );
}

function parseWebUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GuardError("not a valid URL");
  }
  if (!WEB_SCHEMES.has(url.protocol))
    throw new GuardError(`scheme ${url.protocol} is not allowed`);
  if (url.username || url.password)
    throw new GuardError("URLs with a user name or password are not allowed");
  if (!url.hostname) throw new GuardError("URL has no host");
  return url;
}

/**
 * Check a navigation target. Resolves the host and refuses it when any
 * address is not public. Returns the parsed URL.
 */
export async function checkNavigation(
  raw: string,
  options: GuardOptions = {},
): Promise<URL> {
  const url = parseWebUrl(raw);
  const host = bareHost(url.hostname);
  if (!hostAllowed(host, options.allowedHosts ?? [])) {
    throw new GuardError(`${host} is not on this desk's allow-list`);
  }
  if (options.allowPrivateNetwork) return url;

  const byName = blockedByName(host);
  if (byName) throw new GuardError(byName);
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host))
      throw new GuardError(`${host} is not a public address`);
    return url;
  }
  let addresses: string[];
  try {
    addresses = await (options.resolver ?? systemResolver)(host);
  } catch {
    throw new GuardError(`${host} does not resolve`);
  }
  if (addresses.length === 0) throw new GuardError(`${host} does not resolve`);
  const bad = addresses.find(isBlockedAddress);
  if (bad) throw new GuardError(`${host} resolves to a non-public address`);
  return url;
}

/**
 * Cheap per-request check (no DNS). Returns why the request must be refused,
 * or null to let it through.
 */
export function quickBlockReason(
  raw: string,
  options: GuardOptions = {},
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (LOCAL_SCHEMES.has(url.protocol)) return null;
  if (!WEB_SCHEMES.has(url.protocol))
    return `scheme ${url.protocol} is not allowed`;
  const host = bareHost(url.hostname);
  if (options.allowPrivateNetwork) return null;
  const byName = blockedByName(host);
  if (byName) return byName;
  if (isIP(host) !== 0 && isBlockedAddress(host))
    return `${host} is not a public address`;
  return null;
}
