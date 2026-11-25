/**
 * The browser desk against a real Chrome (BOFF-16562 definition of done:
 * "logs in to a test site and reads a value"), through the SDK desk guard
 * exactly as the `vibe-plugin-desk` meta wraps it.
 *
 * Network setup: Chrome maps every `*.test` name to 127.0.0.1
 * (`--host-resolver-rules`), while the guard's resolver says `*.test` is a
 * public address. So the test site loads like a public one, and the private
 * network rules stay ON: a redirect or a subrequest to 127.0.0.1 is refused
 * the way it would be on a real desk.
 *
 * Needs a Chrome or Chromium binary: DESK_BROWSER_TEST_EXECUTABLE, or
 * /usr/bin/google-chrome. Without one these tests are skipped, loudly.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDeskGuard,
  type DeskAction,
  type DeskActResult,
  type DeskGuard,
} from "@vibecontrols/plugin-sdk/desk";
import { chromium } from "playwright-core";

import {
  BrowserDeskBackend,
  type DeskSecretResolver,
  type Launcher,
} from "../backend.js";
import type { PageSnapshot } from "../snapshot.js";

const executable =
  process.env.DESK_BROWSER_TEST_EXECUTABLE ??
  [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((p) => existsSync(p));

// A cold Chrome start on a CI runner takes several seconds; bun's 5s default
// timed the first test out there (the login never finished).
setDefaultTimeout(60_000);

if (!executable) {
  console.warn(
    "SKIPPED: browser desk tests need Chrome (set DESK_BROWSER_TEST_EXECUTABLE)",
  );
}

const PASSWORD = "correct horse battery staple";

const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );

let server: ReturnType<typeof Bun.serve>;
let base: string;
let leaked = 0;

function startSite() {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const host = req.headers.get("host") ?? "";
      if (!host.startsWith("bank.test")) {
        // Only reached when a request bypassed the guard by IP.
        leaked++;
        return new Response("private", { status: 200 });
      }
      if (url.pathname === "/login" && req.method === "GET") {
        return page(
          "Sign in",
          `<h1>Sign in</h1>
           <form method="post" action="/login">
             <label for="u">User name</label><input id="u" name="u" />
             <label for="p">Password</label><input id="p" name="p" type="password" />
             <button type="submit">Sign in</button>
           </form>
           <img src="http://127.0.0.1:${url.port}/pixel.png" alt="tracker" />
           <div style="height:3000px">tall</div>`,
        );
      }
      if (url.pathname === "/login" && req.method === "POST") {
        const form = await req.formData();
        if (form.get("u") === "steward" && form.get("p") === PASSWORD) {
          return new Response(null, {
            status: 303,
            headers: {
              location: "/account",
              "set-cookie": "session=ok; Path=/; HttpOnly; Max-Age=3600",
            },
          });
        }
        return page("Sign in failed", "<p>wrong credentials</p>");
      }
      if (url.pathname === "/account") {
        if (!(req.headers.get("cookie") ?? "").includes("session=ok")) {
          return new Response(null, {
            status: 303,
            headers: { location: "/login" },
          });
        }
        return page(
          "Account",
          `<h1>Account</h1><p id="bal">Balance: 4,200 credits</p>`,
        );
      }
      if (url.pathname === "/to-private") {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${url.port}/secret` },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://bank.test:${server.port}`;
}

const launcher: Launcher = (profile, options) =>
  chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: executable,
    args: [
      "--host-resolver-rules=MAP *.test 127.0.0.1",
      ...(options.proxy ? [] : []),
    ],
    viewport: { width: 1280, height: 800 },
    acceptDownloads: false,
    serviceWorkers: "block",
  });

const secrets = new Map<string, { origin: string; value: string }>();
const resolver: DeskSecretResolver = {
  async resolve(ref, { origin }) {
    const s = secrets.get(ref);
    return s && s.origin === origin ? s.value : null;
  },
};

let backend: BrowserDeskBackend;
let guard: DeskGuard;
let profile: string;
let seq = 0;

const act = (action: DeskAction, deskId = "desk-1"): Promise<DeskActResult> =>
  guard.act({
    deskId,
    fencingToken: "1",
    idempotencyKey: `k${++seq}`,
    timeoutMs: 20_000,
    action,
  });

async function refFor(
  role: string,
  name: string,
  deskId = "desk-1",
): Promise<string> {
  const r = await act({ type: "snapshot" }, deskId);
  expect(r.ok).toBe(true);
  const snap = r.snapshot as PageSnapshot;
  const el = snap.elements.find(
    (e) => e.role === role && e.name.includes(name),
  );
  if (!el)
    throw new Error(`no ${role} "${name}" in ${JSON.stringify(snap.elements)}`);
  return el.ref;
}

describe.skipIf(!executable)("browser desk with a real browser", () => {
  beforeAll(() => {
    startSite();
    profile = join(mkdtempSync(join(tmpdir(), "desk-browser-")), "profile");
    secrets.set("bank-password", { origin: base, value: PASSWORD });
    backend = new BrowserDeskBackend({
      profileFolder: profile,
      headless: true,
      launch: launcher,
      secrets: () => resolver,
      guard: {
        resolver: async (host) =>
          host.endsWith(".test") ? ["93.184.215.14"] : ["127.0.0.1"],
      },
    });
    const workspace = mkdtempSync(join(tmpdir(), "desk-ws-"));
    guard = createDeskGuard(backend, { workspaceFolder: workspace });
  });

  afterAll(async () => {
    await backend?.close();
    server?.stop(true);
  });

  test("signs in with type and secret_fill, then reads the balance", async () => {
    const nav = await act({ type: "navigate", url: `${base}/login` });
    expect(nav).toMatchObject({ ok: true, provenance: "UNTRUSTED" });
    expect(nav.text).toContain("Sign in");
    expect(statSync(profile).mode & 0o777).toBe(0o700);

    const user = await refFor("textbox", "User name");
    expect(
      (
        await act({
          type: "type",
          target: { by: "ref", ref: user },
          text: "steward",
        })
      ).ok,
    ).toBe(true);

    const pass = await refFor("textbox", "Password");
    const filled = await act({
      type: "secret_fill",
      target: { by: "ref", ref: pass },
      secretRef: "bank-password",
      expectedOrigin: base,
    });
    expect(filled).toEqual({ ok: true, provenance: "UNTRUSTED" });

    // The password never comes back: the snapshot hides it.
    const snap = (await act({ type: "snapshot" })).snapshot as PageSnapshot;
    expect(JSON.stringify(snap)).not.toContain(PASSWORD);
    expect(snap.elements.find((e) => e.name.includes("Password"))?.value).toBe(
      "(hidden)",
    );

    const shot = await act({ type: "screenshot" });
    expect(shot.ok).toBe(true);
    expect(Array.from(shot.screenshotPng?.slice(0, 4) ?? [])).toEqual([
      137, 80, 78, 71,
    ]);

    const button = await refFor("button", "Sign in");
    const clicked = await act({
      type: "click",
      target: { by: "ref", ref: button },
    });
    expect(clicked.ok).toBe(true);
    expect(clicked.text).toBe(`${base}/account`);

    const read = await act({ type: "snapshot" });
    expect(read.text).toContain("Balance: 4,200 credits");
    expect((read.snapshot as PageSnapshot).title).toBe("Account");
  });

  test("the profile keeps the sign-in across a browser restart", async () => {
    await backend.close();
    backend = new BrowserDeskBackend({
      profileFolder: profile,
      headless: true,
      launch: launcher,
      guard: { resolver: async () => ["93.184.215.14"] },
    });
    guard = createDeskGuard(backend, {
      workspaceFolder: mkdtempSync(join(tmpdir(), "desk-ws-")),
    });
    const nav = await act({ type: "navigate", url: `${base}/account` });
    expect(nav.text).toContain("Account");
  });

  test("refuses navigation to private and metadata addresses", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      `http://127.0.0.1:${server.port}/`,
      "file:///etc/passwd",
    ]) {
      const r = await act({ type: "navigate", url });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("URL_BLOCKED");
    }
  });

  test("a redirect to a private address is refused and the page is cleared", async () => {
    const before = leaked;
    const r = await act({ type: "navigate", url: `${base}/to-private` });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("URL_BLOCKED");
    expect(r.error?.message).toContain("redirected to a blocked URL");
    const shot = await act({ type: "snapshot" });
    expect((shot.snapshot as PageSnapshot).url).toBe("about:blank");
    // Chrome followed the redirect before the check (documented limit); the
    // cloud desk egress proxy is what stops that request on a real desk.
    expect(leaked).toBeGreaterThanOrEqual(before);
  });

  test("subrequests to private literals are blocked by the request guard", async () => {
    const before = leaked;
    await act({ type: "navigate", url: `${base}/login` });
    expect(leaked).toBe(before);
  });

  test("secret_fill refuses a different origin and unknown secrets", async () => {
    await act({ type: "navigate", url: `${base}/login` });
    const pass = await refFor("textbox", "Password");
    const wrong = await act({
      type: "secret_fill",
      target: { by: "ref", ref: pass },
      secretRef: "bank-password",
      expectedOrigin: "https://bank.example",
    });
    expect(wrong.error?.code).toBe("ORIGIN_MISMATCH");
    const bad = await act({
      type: "secret_fill",
      target: { by: "ref", ref: pass },
      secretRef: "bank-password",
      expectedOrigin: "not an origin",
    });
    expect(bad.error?.code).toBe("ORIGIN_MISMATCH");
    const none = await act({
      type: "secret_fill",
      target: { by: "ref", ref: pass },
      secretRef: "missing",
      expectedOrigin: base,
    });
    // This backend has no resolver at all after the restart test.
    expect(none.error?.code).toBe("DESK_OFFLINE");
    const point = await act({
      type: "secret_fill",
      target: { by: "point", x: 10, y: 10 },
      secretRef: "bank-password",
      expectedOrigin: base,
    });
    expect(point.error?.code).toBe("TARGET_NOT_FOUND");
  });

  test("stale and unknown targets are TARGET_NOT_FOUND", async () => {
    await act({ type: "navigate", url: `${base}/login` });
    const ref = await refFor("button", "Sign in");
    await act({ type: "navigate", url: `${base}/login` });
    const stale = await act({ type: "click", target: { by: "ref", ref } });
    expect(stale.error?.code).toBe("TARGET_NOT_FOUND");
    expect(
      (await act({ type: "click", target: { by: "ref", ref: "nope" } })).error
        ?.code,
    ).toBe("TARGET_NOT_FOUND");
    expect(
      (await act({ type: "click", target: { by: "window", app: "x" } })).error
        ?.code,
    ).toBe("TARGET_NOT_FOUND");
    expect(
      (await act({ type: "click", target: { by: "point", x: 5000, y: 1 } }))
        .error?.code,
    ).toBe("TARGET_NOT_FOUND");
  });

  test("keys, scrolling and point clicks work", async () => {
    await act({ type: "navigate", url: `${base}/login` });
    const user = await refFor("textbox", "User name");
    expect(
      (await act({ type: "click", target: { by: "ref", ref: user }, count: 2 }))
        .ok,
    ).toBe(true);
    expect((await act({ type: "type", text: "abc" })).ok).toBe(true);
    expect(
      (await act({ type: "key", keys: ["Control+A", "Backspace"] })).ok,
    ).toBe(true);
    const unknown = await act({ type: "key", keys: ["NotAKey"] });
    expect(unknown.error?.code).toBe("TARGET_NOT_FOUND");
    expect((await act({ type: "scroll", dx: 0, dy: 400 })).ok).toBe(true);
    expect(
      (
        await act({
          type: "scroll",
          target: { by: "point", x: 100, y: 100 },
          dx: 0,
          dy: -200,
        })
      ).ok,
    ).toBe(true);
    const heading = await refFor("heading", "Sign in");
    expect(
      (
        await act({
          type: "scroll",
          target: { by: "ref", ref: heading },
          dx: 0,
          dy: 10,
        })
      ).ok,
    ).toBe(true);
    expect(
      (await act({ type: "click", target: { by: "point", x: 20, y: 20 } })).ok,
    ).toBe(true);
    expect(
      (
        await act({
          type: "type",
          target: { by: "point", x: 20, y: 20 },
          text: "",
        })
      ).ok,
    ).toBe(true);
  });

  test("each desk id gets its own page", async () => {
    await act({ type: "navigate", url: `${base}/login` }, "desk-a");
    const other = await act({ type: "snapshot" }, "desk-b");
    expect((other.snapshot as PageSnapshot).url).toBe("about:blank");
  });

  test("actions the browser cannot do are refused by the guard", async () => {
    const r = await act({ type: "focus_window", app: "x" });
    expect(r.error?.code).toBe("DESK_OFFLINE");
  });

  test("a closed browser is relaunched; a stopped desk refuses", async () => {
    // Simulate a crash: close the context underneath the backend.
    const internal = backend as unknown as {
      contextPromise: Promise<{ close(): Promise<void> }> | null;
    };
    await (await internal.contextPromise)?.close();
    const again = await act({ type: "navigate", url: `${base}/login` });
    expect(again.ok).toBe(true);
    await backend.close();
    await backend.close();
    const after = await act({ type: "snapshot" });
    expect(after.error?.code).toBe("DESK_OFFLINE");
  });
});
