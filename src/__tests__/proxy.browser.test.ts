/**
 * Proxy sign-in with a real Chrome (BOFF-16574). A cloud desk signs in to the
 * desk egress proxy with its desk id and its egress token, read from a file
 * that wspace-sandbox-svc writes and renews.
 *
 * The test proxy below asks for Basic credentials (407) like the Squid egress
 * proxy, and answers every request itself, so no outside network is needed.
 * It runs through the real `defaultLauncher`.
 *
 * Needs Chrome: DESK_BROWSER_TEST_EXECUTABLE or /usr/bin/google-chrome.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeskBackendResult } from "@vibecontrols/plugin-sdk/desk";

import { BrowserDeskBackend } from "../backend.js";
import { fileProxyCredentials } from "../index.js";
import type { PageSnapshot } from "../snapshot.js";

const executable =
  process.env.DESK_BROWSER_TEST_EXECUTABLE ??
  [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((p) => existsSync(p));

setDefaultTimeout(60_000);

if (!executable) {
  console.warn(
    "SKIPPED: proxy sign-in tests need Chrome (set DESK_BROWSER_TEST_EXECUTABLE)",
  );
}

let proxy: Server;
let proxyUrl: string;
let accepted = new Set<string>();
const seen: string[] = [];

function startProxy(): Promise<void> {
  proxy = createServer((req, res) => {
    const auth = req.headers["proxy-authorization"] ?? "";
    const creds = auth.startsWith("Basic ")
      ? Buffer.from(auth.slice(6), "base64").toString("utf8")
      : "";
    if (!accepted.has(creds)) {
      res.writeHead(407, {
        "proxy-authenticate": 'Basic realm="steward-desk"',
        "content-type": "text/plain",
      });
      res.end("sign in");
      return;
    }
    seen.push(`${creds} ${req.url ?? ""}`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><title>Shop</title></head><body><h1 id="h">Shop ${req.url ?? ""}</h1></body></html>`,
    );
  });
  return new Promise((resolve) =>
    proxy.listen(0, "127.0.0.1", () => {
      proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

const ctx = { deskId: "desk-1", signal: new AbortController().signal };

function headline(r: DeskBackendResult): string {
  const snap = r.snapshot as PageSnapshot;
  return snap.elements.find((e) => e.role === "heading")?.name ?? "";
}

describe.skipIf(!executable)("proxy sign-in with a real browser", () => {
  let backend: BrowserDeskBackend;
  let tokenFile: string;

  beforeAll(async () => {
    await startProxy();
    const dir = mkdtempSync(join(tmpdir(), "desk-browser-proxy-"));
    tokenFile = join(dir, "egress-token");
    writeFileSync(tokenFile, "token-one\n", { mode: 0o600 });
    accepted = new Set(["desk-1:token-one"]);
    backend = new BrowserDeskBackend({
      profileFolder: join(dir, "profile"),
      headless: true,
      executablePath: executable,
      proxy: proxyUrl,
      readProxyCredentials: fileProxyCredentials("desk-1", tokenFile),
      guard: { resolver: async () => ["93.184.215.14"] },
    });
  });

  afterAll(async () => {
    await backend?.close();
    proxy?.close();
  });

  test("signs in to the proxy with the desk id and the token from the file", async () => {
    const nav = await backend.act(
      { type: "navigate", url: "http://shop.test/first" },
      ctx,
    );
    expect(nav.error).toBeUndefined();
    expect(nav.ok).toBe(true);
    const snap = await backend.act({ type: "snapshot" }, ctx);
    expect(headline(snap)).toBe("Shop http://shop.test/first");
    expect(seen).toContain("desk-1:token-one http://shop.test/first");
  });

  test("a renewed token restarts the browser with it and reopens the page", async () => {
    writeFileSync(tokenFile, "token-two-renewed\n");
    accepted = new Set(["desk-1:token-two-renewed"]);

    const snap = await backend.act({ type: "snapshot" }, ctx);
    expect(snap.ok).toBe(true);
    expect(headline(snap)).toBe("Shop http://shop.test/first");
    expect(seen).toContain("desk-1:token-two-renewed http://shop.test/first");

    const nav = await backend.act(
      { type: "navigate", url: "http://shop.test/second" },
      ctx,
    );
    expect(nav.ok).toBe(true);
    expect(seen.at(-1)).toBe(
      "desk-1:token-two-renewed http://shop.test/second",
    );
  });

  test("a missing token file stops the desk without saying why", async () => {
    writeFileSync(tokenFile, "");
    const r = await backend.act({ type: "snapshot" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toEqual({
      code: "DESK_OFFLINE",
      message: "the egress proxy credentials are unavailable",
    });
  });
});
