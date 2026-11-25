import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  HostServices,
  ProfileContext,
} from "@vibecontrols/plugin-sdk/contract";
import type { DeskBackend } from "@vibecontrols/plugin-sdk/desk";
import type { BrowserContext } from "playwright-core";

import createPlugin, {
  BROWSER_ACTIONS,
  createDeskBrowserPlugin,
  defaultHeadless,
  DESK_BROWSER_CONFIG,
  DESK_PROVIDER_TYPE,
  parseProxy,
} from "../index.js";
import type { LaunchOptions } from "../backend.js";
import { newRefAttribute, refSelector } from "../snapshot.js";

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

function profile(): ProfileContext {
  return {
    dataDir: mkdtempSync(join(tmpdir(), "desk-browser-idx-")),
    logger: quietLogger,
  } as unknown as ProfileContext;
}

function host(config: Record<string, string> = {}) {
  const providers: Array<{ type: string; name: string; provider: unknown }> =
    [];
  const services: HostServices = {
    serviceRegistry: {
      registerProvider: (type, provider, name) =>
        void providers.push({ type, name, provider }),
    },
    getConfig: async (key) => config[key],
  } as HostServices;
  return { services, providers };
}

/** A launcher that records its options and hands back a context that is already closed for business. */
function recordingLauncher() {
  const calls: Array<{ profile: string; options: LaunchOptions }> = [];
  let closed = 0;
  const launch = async (profileFolder: string, options: LaunchOptions) => {
    calls.push({ profile: profileFolder, options });
    const context = {
      setDefaultTimeout() {},
      setDefaultNavigationTimeout() {},
      async route() {},
      on() {},
      pages: () => [],
      async newPage() {
        throw new Error("no pages in this fake");
      },
      async close() {
        closed++;
      },
    };
    return context as unknown as BrowserContext;
  };
  return { launch, calls, closed: () => closed };
}

describe("plugin", () => {
  test("default export is the factory and describes the provider", () => {
    const plugin = createPlugin(profile());
    expect(plugin.name).toBe("desk-browser");
    expect(plugin.tags).toContain("provider");
    expect(typeof plugin.onServerStart).toBe("function");
    expect(typeof plugin.onServerStop).toBe("function");
  });

  test("registers a browser DeskBackend under the desk type with config applied", async () => {
    const rec = recordingLauncher();
    const ctx = profile();
    const plugin = createDeskBrowserPlugin({ launch: rec.launch })(ctx);
    const h = host({
      [DESK_BROWSER_CONFIG.headless]: "on",
      [DESK_BROWSER_CONFIG.proxy]: "http://172.20.0.200:3128",
      [DESK_BROWSER_CONFIG.channel]: "chrome",
      [DESK_BROWSER_CONFIG.executablePath]: " /opt/chrome ",
      [DESK_BROWSER_CONFIG.allowedHosts]: "example.com",
    });
    await plugin.onServerStart?.({}, h.services);

    expect(h.providers).toHaveLength(1);
    const reg = h.providers[0];
    expect(reg?.type).toBe(DESK_PROVIDER_TYPE);
    expect(reg?.name).toBe("desk-browser");
    const backend = reg?.provider as DeskBackend;
    expect(backend.kind).toBe("browser");
    expect([...backend.actions]).toEqual([...BROWSER_ACTIONS]);

    // The browser starts lazily: nothing launched yet.
    expect(rec.calls).toHaveLength(0);
    const r = await backend.act(
      { type: "screenshot" },
      { deskId: "d", signal: new AbortController().signal, paths: {} },
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("DESK_OFFLINE");
    expect(rec.calls[0]?.profile).toBe(
      join(ctx.dataDir, "desk-browser-profile"),
    );
    expect(rec.calls[0]?.options).toEqual({
      headless: true,
      proxy: "http://172.20.0.200:3128",
      channel: "chrome",
      executablePath: "/opt/chrome",
    });

    await plugin.onServerStop?.({ reason: "shutdown" });
    expect(rec.closed()).toBe(1);
    const after = await backend.act(
      { type: "screenshot" },
      { deskId: "d", signal: new AbortController().signal, paths: {} },
    );
    expect(after.error?.code).toBe("DESK_OFFLINE");
    expect(after.error?.message).toContain("stopped");
  });

  test("a launch failure is reported and retried on the next action", async () => {
    let attempts = 0;
    const plugin = createDeskBrowserPlugin({
      launch: async () => {
        attempts++;
        throw new Error("Executable doesn't exist at /nope\nlong call log");
      },
    })(profile());
    const h = host({ [DESK_BROWSER_CONFIG.proxy]: "socks5://x:1" });
    await plugin.onServerStart?.({}, h.services);
    const backend = h.providers[0]?.provider as DeskBackend;
    const ctx = {
      deskId: "d",
      signal: new AbortController().signal,
      paths: {},
    };
    const first = await backend.act({ type: "snapshot" }, ctx);
    expect(first.error).toEqual({
      code: "DESK_OFFLINE",
      message: "Executable doesn't exist at /nope",
    });
    await backend.act({ type: "snapshot" }, ctx);
    expect(attempts).toBe(2);
    await plugin.onServerStop?.();
  });
});

describe("config parsing", () => {
  test("parseProxy accepts http(s) without credentials only", () => {
    expect(parseProxy("http://172.20.0.200:3128")).toBe(
      "http://172.20.0.200:3128",
    );
    expect(parseProxy("https://proxy.example:8443/path")).toBe(
      "https://proxy.example:8443",
    );
    expect(parseProxy("http://user:pw@proxy:1")).toBeUndefined();
    expect(parseProxy("socks5://proxy:1")).toBeUndefined();
    expect(parseProxy("nonsense")).toBeUndefined();
    expect(parseProxy(undefined)).toBeUndefined();
  });

  test("defaultHeadless is on only for Linux without a display", () => {
    expect(defaultHeadless("linux", {})).toBe(true);
    expect(defaultHeadless("linux", { DISPLAY: ":0" })).toBe(false);
    expect(defaultHeadless("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe(
      false,
    );
    expect(defaultHeadless("darwin", {})).toBe(false);
    expect(defaultHeadless("win32", {})).toBe(false);
    expect(typeof defaultHeadless()).toBe("boolean");
  });
});

describe("snapshot refs", () => {
  test("ref attributes are random and well formed", () => {
    const a = newRefAttribute();
    const b = newRefAttribute();
    expect(a).toMatch(/^data-vc-[a-z0-9]{16}$/);
    expect(a).not.toBe(b);
    expect(newRefAttribute(() => "AB-cd")).toBe("data-vc-abcd");
  });

  test("refSelector only accepts e<number>", () => {
    expect(refSelector("data-vc-x", "e12")).toBe('[data-vc-x="e12"]');
    expect(refSelector("data-vc-x", 'e1"]*')).toBeNull();
    expect(refSelector("data-vc-x", "x1")).toBeNull();
  });
});
