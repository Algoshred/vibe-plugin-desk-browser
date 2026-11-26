/**
 * @vibecontrols/vibe-plugin-desk-browser
 *
 * The browser provider for BotManor Stewards desks (BOFF-16562; BotManor spec
 * `10-STEWARDS-TECH-SPEC.md` §7, plan §5.5). It registers a `DeskBackend`
 * that drives a dedicated Chromium profile with Playwright under the `desk`
 * provider type. Install it next to `@vibecontrols/vibe-plugin-desk`, which
 * routes actions to it and enforces fencing, idempotency, timeouts, local
 * consent and the kill switch.
 *
 * The browser starts on the first action, not at agent start, and closes on
 * `onServerStop`. Its profile lives in `<dataDir>/desk-browser-profile`
 * (mode 0700); on a cloud desk that folder is part of the home snapshot
 * taken at hibernation, so sign-ins survive a restore.
 *
 * Configuration (`vibe config set <key> <value>`):
 *   desk-browser.executable-path  Chromium or Chrome binary (default: Playwright's)
 *   desk-browser.channel          "chrome", "msedge", ... instead of a path
 *   desk-browser.headless         "on" or "off" (default: off when a display exists)
 *   desk-browser.proxy            http(s) proxy URL; cloud desks use the egress proxy
 *   desk-browser.proxy-username   proxy sign-in user name (a cloud desk: its desk id)
 *   desk-browser.proxy-password-file
 *                                 file holding the proxy password (a cloud desk: its
 *                                 egress token, BOFF-16574). Read at each browser
 *                                 start and checked before each action; when the
 *                                 file changes the browser restarts with it.
 *   desk-browser.allowed-hosts    comma-separated host allow-list, `*.` for subdomains
 *
 * `secret_fill` needs a secret store that registers a `DeskSecretResolver`
 * under the `desk-secret` provider type. Without one, `secret_fill` is
 * refused and nothing else changes.
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  HostServices,
  PluginStopContext,
  ProfileContext,
  VibePlugin,
  VibePluginFactory,
} from "@vibecontrols/plugin-sdk/contract";
import { createLifecycleHooks } from "@vibecontrols/plugin-sdk/lifecycle";
import { BoundLogger } from "@vibecontrols/plugin-sdk/log";

import {
  BrowserDeskBackend,
  DESK_SECRET_PROVIDER_TYPE,
  type DeskSecretResolver,
  type Launcher,
  type ProxyCredentialSource,
} from "./backend.js";
import { parseAllowedHosts } from "./url-guard.js";

const PLUGIN_NAME = "desk-browser";
const PLUGIN_PACKAGE_NAME = "@vibecontrols/vibe-plugin-desk-browser";
const PLUGIN_VERSION = getPluginVersion();

/** The provider type the `vibe-plugin-desk` meta routes to. */
export const DESK_PROVIDER_TYPE = "desk";

export const DESK_BROWSER_CONFIG = {
  executablePath: "desk-browser.executable-path",
  channel: "desk-browser.channel",
  headless: "desk-browser.headless",
  proxy: "desk-browser.proxy",
  proxyUsername: "desk-browser.proxy-username",
  proxyPasswordFile: "desk-browser.proxy-password-file",
  allowedHosts: "desk-browser.allowed-hosts",
} as const;

function getPluginVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10 && dir && dir !== dirname(dir); i++) {
      const pkgPath = joinPath(dir, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
            name?: string;
            version?: string;
          };
          if (
            pkg.name === PLUGIN_PACKAGE_NAME &&
            typeof pkg.version === "string"
          ) {
            return pkg.version;
          }
        } catch {
          /* malformed package.json: keep walking up */
        }
      }
      dir = dirname(dir);
    }
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

/** Default headless: on Linux without a display there is nothing to show. */
export function defaultHeadless(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== "linux") return false;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/** Only http(s) proxies without credentials are accepted from config. */
export function parseProxy(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

export interface DeskBrowserPluginOptions {
  /** Replaces Playwright's launcher. Tests only. */
  launch?: Launcher;
}

/**
 * Proxy credentials from a password file (a cloud desk's egress token, written
 * by wspace-sandbox-svc). The version is the file's identity, size and change
 * time, so a rewrite with a renewed token is noticed without comparing tokens.
 */
export function fileProxyCredentials(
  username: string,
  passwordFile: string,
): ProxyCredentialSource {
  return {
    async read() {
      const info = await stat(passwordFile);
      const password = (await readFile(passwordFile, "utf8")).trim();
      if (!password) throw new Error("the proxy password file is empty");
      return {
        credentials: { username, password },
        version: `${info.ino}:${info.size}:${info.mtimeMs}`,
      };
    },
  };
}

export function createDeskBrowserPlugin(
  options: DeskBrowserPluginOptions = {},
): VibePluginFactory {
  return (ctx: ProfileContext): VibePlugin => {
    const log = new BoundLogger(ctx.logger, PLUGIN_NAME);
    let backend: BrowserDeskBackend | null = null;

    const lifecycle = createLifecycleHooks({
      name: PLUGIN_NAME,
      telemetryEventName: "desk-browser.ready",
      onInit: async (host: HostServices) => {
        const read = async (key: string) =>
          (await host.getConfig?.(key))?.trim() || undefined;
        const headlessSetting = await read(DESK_BROWSER_CONFIG.headless);
        const proxySetting = await read(DESK_BROWSER_CONFIG.proxy);
        const proxy = parseProxy(proxySetting);
        if (proxySetting && !proxy) {
          log.warn(
            `${DESK_BROWSER_CONFIG.proxy} is not an http(s) URL without credentials; ignored`,
          );
        }
        const proxyUsername = await read(DESK_BROWSER_CONFIG.proxyUsername);
        const proxyPasswordFile = await read(
          DESK_BROWSER_CONFIG.proxyPasswordFile,
        );
        const readProxyCredentials =
          proxyUsername && proxyPasswordFile
            ? fileProxyCredentials(proxyUsername, proxyPasswordFile)
            : undefined;
        if ((proxyUsername || proxyPasswordFile) && !readProxyCredentials) {
          log.warn(
            `${DESK_BROWSER_CONFIG.proxyUsername} and ${DESK_BROWSER_CONFIG.proxyPasswordFile} must both be set; proxy sign-in is off`,
          );
        } else if (readProxyCredentials && !proxy) {
          log.warn(
            `${DESK_BROWSER_CONFIG.proxyUsername} is set without ${DESK_BROWSER_CONFIG.proxy}; ignored`,
          );
        }
        backend = new BrowserDeskBackend({
          profileFolder: joinPath(ctx.dataDir, "desk-browser-profile"),
          headless: headlessSetting
            ? headlessSetting === "on"
            : defaultHeadless(),
          executablePath: await read(DESK_BROWSER_CONFIG.executablePath),
          channel: await read(DESK_BROWSER_CONFIG.channel),
          proxy,
          guard: {
            allowedHosts: parseAllowedHosts(
              await read(DESK_BROWSER_CONFIG.allowedHosts),
            ),
          },
          secrets: () =>
            host.serviceRegistry?.getProvider?.<DeskSecretResolver>(
              DESK_SECRET_PROVIDER_TYPE,
            ),
          launch: options.launch,
          readProxyCredentials,
        });
        host.serviceRegistry?.registerProvider?.(
          DESK_PROVIDER_TYPE,
          backend,
          PLUGIN_NAME,
        );
        log.info("browser desk registered");
      },
      onShutdown: async (context?: PluginStopContext) => {
        const current = backend;
        backend = null;
        await current?.close();
        log.info(`browser desk stopped (${context?.reason ?? "shutdown"})`);
      },
    });

    return {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      description:
        "Steward desk provider: a dedicated browser driven through the desk API",
      tags: ["backend", "provider"],
      capabilities: {
        telemetry: true,
      },
      onServerStart: lifecycle.onServerStart,
      onServerStop: lifecycle.onServerStop,
    };
  };
}

export const createPlugin: VibePluginFactory = createDeskBrowserPlugin();

export default createPlugin;

export {
  BROWSER_ACTIONS,
  BROWSER_LIMITS,
  BrowserDeskBackend,
  DESK_SECRET_PROVIDER_TYPE,
  type DeskSecretResolver,
  type ProxyCredentials,
  type ProxyCredentialSource,
} from "./backend.js";
export {
  checkNavigation,
  isBlockedAddress,
  quickBlockReason,
} from "./url-guard.js";
