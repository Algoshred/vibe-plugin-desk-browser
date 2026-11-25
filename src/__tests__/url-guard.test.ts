import { describe, expect, test } from "bun:test";

import {
  checkNavigation,
  GuardError,
  isBlockedAddress,
  parseAllowedHosts,
  quickBlockReason,
  type Resolver,
  systemResolver,
} from "../url-guard.js";

const resolveTo =
  (map: Record<string, string[]>): Resolver =>
  async (host) => {
    const hit = map[host];
    if (!hit) throw new Error("ENOTFOUND");
    return hit;
  };

describe("isBlockedAddress", () => {
  test.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::10.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "fd00:ec2::254",
    "fc00::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "100::1",
    "not-an-ip",
    "1.2.3",
    "1:2:3",
    "1::2::3",
    "gggg::1",
  ])("%s is blocked", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  test.each([
    "8.8.8.8",
    "93.184.215.14",
    "172.32.0.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
    "2002:808:808::",
  ])("%s is public", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("checkNavigation", () => {
  const resolver = resolveTo({
    "example.com": ["93.184.215.14"],
    "rebind.example": ["93.184.215.14", "10.0.0.5"],
    "meta.example": ["169.254.169.254"],
    "empty.example": [],
  });

  test("allows a public https URL", async () => {
    const url = await checkNavigation("https://example.com/path?q=1", {
      resolver,
    });
    expect(url.hostname).toBe("example.com");
  });

  test("allows a public IP literal", async () => {
    await expect(
      checkNavigation("http://8.8.8.8/", { resolver }),
    ).resolves.toBeInstanceOf(URL);
  });

  test.each([
    ["not a url", "not a valid URL"],
    ["file:///etc/passwd", "scheme file: is not allowed"],
    ["javascript:alert(1)", "scheme javascript: is not allowed"],
    ["chrome://settings", "scheme chrome: is not allowed"],
    ["https://user:pw@example.com/", "user name or password"],
    ["http://localhost:3000/", "localhost is a local name"],
    ["http://printer.local/", "is a local name"],
    ["http://db.internal/", "is a local name"],
    ["http://metadata/", "metadata is a local name"],
    ["http://intranet/", "single-label name"],
    ["http://169.254.169.254/latest/meta-data/", "not a public address"],
    ["http://2130706433/", "not a public address"],
    ["http://0x7f000001/", "not a public address"],
    ["http://[::1]/", "not a public address"],
    ["http://[::ffff:169.254.169.254]/", "not a public address"],
    ["https://rebind.example/", "resolves to a non-public address"],
    ["https://meta.example/", "resolves to a non-public address"],
    ["https://unknown.example/", "does not resolve"],
    ["https://empty.example/", "does not resolve"],
  ])("refuses %s", async (raw, message) => {
    const err = await checkNavigation(raw, { resolver }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GuardError);
    expect((err as Error).message).toContain(message);
  });

  test("applies the allow-list before resolving", async () => {
    const allowedHosts = ["example.com", "*.bank.example"];
    await expect(
      checkNavigation("https://example.com/", { resolver, allowedHosts }),
    ).resolves.toBeInstanceOf(URL);
    const other = await checkNavigation("https://evil.example/", {
      resolver,
      allowedHosts,
    }).catch((e: unknown) => e);
    expect((other as Error).message).toContain("not on this desk's allow-list");
    const sub = await checkNavigation("https://login.bank.example/", {
      resolver: resolveTo({ "login.bank.example": ["8.8.4.4"] }),
      allowedHosts,
    });
    expect(sub.hostname).toBe("login.bank.example");
    const apex = await checkNavigation("https://bank.example/", {
      resolver,
      allowedHosts,
    }).catch((e: unknown) => e);
    expect(apex).toBeInstanceOf(GuardError);
  });

  test("allowPrivateNetwork skips address checks but keeps scheme and allow-list", async () => {
    await expect(
      checkNavigation("http://127.0.0.1:8080/", { allowPrivateNetwork: true }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      checkNavigation("file:///x", { allowPrivateNetwork: true }),
    ).rejects.toBeInstanceOf(GuardError);
    await expect(
      checkNavigation("http://127.0.0.1/", {
        allowPrivateNetwork: true,
        allowedHosts: ["example.com"],
      }),
    ).rejects.toBeInstanceOf(GuardError);
  });

  test("the system resolver resolves localhost to loopback", async () => {
    const addresses = await systemResolver("localhost");
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.every(isBlockedAddress)).toBe(true);
  });
});

describe("quickBlockReason", () => {
  test.each([
    ["https://example.com/a.js", null],
    ["data:image/png;base64,AAAA", null],
    ["blob:https://example.com/1", null],
    ["about:blank", null],
    ["http://10.0.0.1/x", "10.0.0.1 is not a public address"],
    ["http://localhost/x", "localhost is a local name"],
    ["ws://example.com/socket", "scheme ws: is not allowed"],
    ["file:///etc/hosts", "scheme file: is not allowed"],
    ["::::", "not a valid URL"],
  ])("%s -> %p", (raw, reason) => {
    expect(quickBlockReason(raw)).toBe(reason);
  });

  test("allowPrivateNetwork lets private literals through but not other schemes", () => {
    expect(
      quickBlockReason("http://127.0.0.1/", { allowPrivateNetwork: true }),
    ).toBeNull();
    expect(
      quickBlockReason("ftp://127.0.0.1/", { allowPrivateNetwork: true }),
    ).toContain("scheme");
  });
});

describe("parseAllowedHosts", () => {
  test("keeps host names and wildcard subdomains, drops the rest", () => {
    expect(
      parseAllowedHosts(
        " Example.com, *.bank.example  bad_host http://x.com *.  ok.io",
      ),
    ).toEqual(["example.com", "*.bank.example", "ok.io"]);
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("")).toEqual([]);
  });
});
