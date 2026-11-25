/**
 * The browser desk backend (BOFF-16562): one persistent Chromium profile,
 * one page per desk id, driven by Playwright behind the common desk
 * contract (`@vibecontrols/plugin-sdk/desk`).
 *
 * The `vibe-plugin-desk` meta wraps this backend in the SDK desk guard, so
 * fencing, idempotency, timeouts, `UNTRUSTED` provenance, local consent and
 * the kill switch are not handled here. What this backend adds:
 *
 * - the URL guard (`url-guard.ts`) on every navigation, on the final URL
 *   after redirects, and on every request the page makes;
 * - refs from the last `snapshot`, re-resolved before each action;
 * - `secret_fill`: the page origin must equal `expectedOrigin` exactly, the
 *   value comes from a `desk-secret` provider, goes straight into the field,
 *   and never appears in a result, error, log or screenshot;
 * - screenshots mask every password field.
 *
 * Downloads and service workers are off: a desk does not save files through
 * the browser (file actions go through the workspace folder), and a service
 * worker could fetch around the request guard.
 */
import { mkdir } from "node:fs/promises";

import type {
  DeskAction,
  DeskActionType,
  DeskBackend,
  DeskBackendResult,
  DeskErrorCode,
  DeskTarget,
} from "@vibecontrols/plugin-sdk/desk";
import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";

import {
  collectInPage,
  newRefAttribute,
  type PageSnapshot,
  refSelector,
  SNAPSHOT_LIMITS,
} from "./snapshot.js";
import {
  checkNavigation,
  GuardError,
  type GuardOptions,
  quickBlockReason,
} from "./url-guard.js";

/** Provider type a secret store registers under to serve `secret_fill`. */
export const DESK_SECRET_PROVIDER_TYPE = "desk-secret";

/**
 * Resolves a `secretRef` to the value to type. Returning null refuses the
 * fill. Implementations decide whether `origin` may receive that secret.
 */
export interface DeskSecretResolver {
  resolve(
    secretRef: string,
    request: { origin: string; deskId: string },
  ): Promise<string | null>;
}

export const BROWSER_ACTIONS = [
  "screenshot",
  "snapshot",
  "click",
  "type",
  "secret_fill",
  "key",
  "scroll",
  "navigate",
] as const satisfies readonly DeskActionType[];

export const BROWSER_LIMITS = {
  viewport: { width: 1280, height: 800 },
  navigationTimeoutMs: 30_000,
  actionTimeoutMs: 10_000,
} as const;

export interface LaunchOptions {
  headless: boolean;
  executablePath?: string;
  channel?: string;
  proxy?: string;
}

export type Launcher = (
  profileFolder: string,
  options: LaunchOptions,
) => Promise<BrowserContext>;

export const defaultLauncher: Launcher = (profileFolder, options) =>
  chromium.launchPersistentContext(profileFolder, {
    headless: options.headless,
    ...(options.executablePath
      ? { executablePath: options.executablePath }
      : {}),
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.proxy ? { proxy: { server: options.proxy } } : {}),
    viewport: BROWSER_LIMITS.viewport,
    acceptDownloads: false,
    serviceWorkers: "block",
  });

export interface BrowserDeskOptions extends LaunchOptions {
  /** Persistent profile folder (cookies, storage). Created with mode 0700. */
  profileFolder: string;
  guard?: GuardOptions;
  /** Looked up on every `secret_fill`, so a store installed later is used. */
  secrets?: () => DeskSecretResolver | undefined;
  launch?: Launcher;
}

interface DeskPage {
  page: Page;
  refAttr: string | null;
}

type Resolved =
  | { kind: "locator"; locator: Locator }
  | { kind: "point"; x: number; y: number };

const fail = (code: DeskErrorCode, message: string): DeskBackendResult => ({
  ok: false,
  error: { code, message },
});

class ActionError extends Error {
  constructor(
    readonly code: DeskErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** First line of a Playwright error, without its call log. */
function shortMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (text.split("\n")[0] ?? "browser action failed").slice(0, 200);
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

export class BrowserDeskBackend implements DeskBackend {
  readonly kind = "browser";
  readonly actions: readonly DeskActionType[] = BROWSER_ACTIONS;

  private contextPromise: Promise<BrowserContext> | null = null;
  private readonly desks = new Map<string, DeskPage>();
  private closed = false;

  constructor(private readonly options: BrowserDeskOptions) {}

  async act(
    action: DeskAction,
    context: { deskId: string; signal: AbortSignal },
  ): Promise<DeskBackendResult> {
    if (this.closed) return fail("DESK_OFFLINE", "the browser desk is stopped");
    try {
      const desk = await this.deskPage(context.deskId);
      return await this.run(desk, action, context.deskId);
    } catch (err) {
      if (err instanceof ActionError) return fail(err.code, err.message);
      if (isTimeout(err)) return fail("TIMEOUT", shortMessage(err));
      // Never echo a secret_fill error: Playwright messages can include input.
      if (action.type === "secret_fill")
        return fail("DESK_OFFLINE", "secret fill failed");
      return fail("DESK_OFFLINE", shortMessage(err));
    }
  }

  /** Close the browser. Safe to call twice; later actions are refused. */
  async close(): Promise<void> {
    this.closed = true;
    const pending = this.contextPromise;
    this.contextPromise = null;
    this.desks.clear();
    if (!pending) return;
    try {
      const context = await pending;
      await context.close();
    } catch {
      /* the browser never started or is already gone */
    }
  }

  // -------------------------------------------------------------------------

  private context(): Promise<BrowserContext> {
    if (!this.contextPromise) {
      this.contextPromise = this.launchContext().catch((err: unknown) => {
        this.contextPromise = null;
        throw err;
      });
    }
    return this.contextPromise;
  }

  private async launchContext(): Promise<BrowserContext> {
    await mkdir(this.options.profileFolder, { recursive: true, mode: 0o700 });
    const launch = this.options.launch ?? defaultLauncher;
    const context = await launch(this.options.profileFolder, {
      headless: this.options.headless,
      executablePath: this.options.executablePath,
      channel: this.options.channel,
      proxy: this.options.proxy,
    });
    context.setDefaultTimeout(BROWSER_LIMITS.actionTimeoutMs);
    context.setDefaultNavigationTimeout(BROWSER_LIMITS.navigationTimeoutMs);
    await context.route("**/*", async (route) => {
      const reason = quickBlockReason(
        route.request().url(),
        this.options.guard,
      );
      if (reason) await route.abort("blockedbyclient");
      else await route.continue();
    });
    // A crashed or closed browser is relaunched on the next action.
    context.on("close", () => {
      this.contextPromise = null;
      this.desks.clear();
    });
    return context;
  }

  private async deskPage(deskId: string): Promise<DeskPage> {
    const existing = this.desks.get(deskId);
    if (existing && !existing.page.isClosed()) return existing;
    const context = await this.context();
    const taken = new Set([...this.desks.values()].map((d) => d.page));
    const spare = context.pages().find((p) => !p.isClosed() && !taken.has(p));
    const page = spare ?? (await context.newPage());
    const desk: DeskPage = { page, refAttr: null };
    this.desks.set(deskId, desk);
    page.on("close", () => {
      if (this.desks.get(deskId)?.page === page) this.desks.delete(deskId);
    });
    return desk;
  }

  private async resolve(desk: DeskPage, target: DeskTarget): Promise<Resolved> {
    if (target.by === "point") {
      const { width, height } = BROWSER_LIMITS.viewport;
      if (
        target.x < 0 ||
        target.y < 0 ||
        target.x >= width ||
        target.y >= height
      ) {
        throw new ActionError(
          "TARGET_NOT_FOUND",
          `point ${target.x},${target.y} is outside the ${width}x${height} page`,
        );
      }
      return { kind: "point", x: target.x, y: target.y };
    }
    if (target.by === "window") {
      throw new ActionError(
        "TARGET_NOT_FOUND",
        "a browser desk has no windows; use a ref or a point",
      );
    }
    const selector = desk.refAttr
      ? refSelector(desk.refAttr, target.ref)
      : null;
    if (!selector) {
      throw new ActionError(
        "TARGET_NOT_FOUND",
        `ref ${target.ref} is unknown; take a snapshot first`,
      );
    }
    const locator = desk.page.locator(selector);
    const count = await locator.count();
    if (count !== 1 || !(await locator.isVisible())) {
      throw new ActionError(
        "TARGET_NOT_FOUND",
        `ref ${target.ref} is no longer on the page; take a new snapshot`,
      );
    }
    return { kind: "locator", locator };
  }

  private async afterNavigationCheck(page: Page): Promise<void> {
    const current = page.url();
    if (current === "about:blank") return;
    try {
      await checkNavigation(current, this.options.guard);
    } catch (err) {
      await page.goto("about:blank").catch(() => undefined);
      throw new ActionError(
        "URL_BLOCKED",
        err instanceof Error
          ? `redirected to a blocked URL: ${err.message}`
          : "redirected to a blocked URL",
      );
    }
  }

  private async run(
    desk: DeskPage,
    action: DeskAction,
    deskId: string,
  ): Promise<DeskBackendResult> {
    const { page } = desk;
    switch (action.type) {
      case "screenshot": {
        const png = await page.screenshot({
          type: "png",
          animations: "disabled",
          caret: "hide",
          mask: [page.locator('input[type="password"]')],
        });
        return { ok: true, screenshotPng: new Uint8Array(png) };
      }

      case "snapshot": {
        const attr = newRefAttribute();
        const snapshot: PageSnapshot = await page.evaluate(collectInPage, {
          attr,
          previousAttr: desk.refAttr,
          maxElements: SNAPSHOT_LIMITS.maxElements,
          maxName: SNAPSHOT_LIMITS.maxName,
          maxValue: SNAPSHOT_LIMITS.maxValue,
        });
        desk.refAttr = attr;
        const text = await page
          .evaluate(() => document.body?.innerText ?? "")
          .catch(() => "");
        return {
          ok: true,
          snapshot,
          text: text.slice(0, SNAPSHOT_LIMITS.maxText),
        };
      }

      case "click": {
        const target = await this.resolve(desk, action.target);
        const button = action.button ?? "left";
        const clickCount = action.count ?? 1;
        if (target.kind === "point")
          await page.mouse.click(target.x, target.y, { button, clickCount });
        else await target.locator.click({ button, clickCount });
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await this.afterNavigationCheck(page);
        return { ok: true, text: page.url() };
      }

      case "type": {
        if (action.target) {
          const target = await this.resolve(desk, action.target);
          if (target.kind === "point")
            await page.mouse.click(target.x, target.y);
          else await target.locator.focus();
        }
        await page.keyboard.type(action.text);
        return { ok: true };
      }

      case "secret_fill": {
        let expected: string;
        try {
          expected = new URL(action.expectedOrigin).origin;
        } catch {
          return fail(
            "ORIGIN_MISMATCH",
            "expectedOrigin is not a valid origin",
          );
        }
        const actual = (() => {
          try {
            return new URL(page.url()).origin;
          } catch {
            return "null";
          }
        })();
        if (actual !== expected) {
          return fail(
            "ORIGIN_MISMATCH",
            `the page is on ${actual}, not ${expected}`,
          );
        }
        const target = await this.resolve(desk, action.target);
        if (target.kind !== "locator") {
          return fail(
            "TARGET_NOT_FOUND",
            "secret_fill needs a ref target, not a point",
          );
        }
        const resolver = this.options.secrets?.();
        if (!resolver)
          return fail(
            "DESK_OFFLINE",
            "no secret store is installed on this desk",
          );
        const value = await resolver.resolve(action.secretRef, {
          origin: expected,
          deskId,
        });
        if (value === null)
          return fail(
            "DESK_OFFLINE",
            "the secret is not available for this origin",
          );
        // Re-check the origin: the page may have navigated while we waited.
        if (new URL(page.url()).origin !== expected) {
          return fail("ORIGIN_MISMATCH", "the page left the expected origin");
        }
        await target.locator.fill(value);
        return { ok: true };
      }

      case "key": {
        for (const key of action.keys) {
          try {
            await page.keyboard.press(key);
          } catch (err) {
            if (isTimeout(err)) throw err;
            throw new ActionError(
              "TARGET_NOT_FOUND",
              `unknown key ${JSON.stringify(key).slice(0, 40)}`,
            );
          }
        }
        await this.afterNavigationCheck(page);
        return { ok: true };
      }

      case "scroll": {
        if (action.target) {
          const target = await this.resolve(desk, action.target);
          if (target.kind === "point")
            await page.mouse.move(target.x, target.y);
          else await target.locator.hover();
        }
        await page.mouse.wheel(action.dx, action.dy);
        return { ok: true };
      }

      case "navigate": {
        try {
          await checkNavigation(action.url, this.options.guard);
        } catch (err) {
          if (err instanceof GuardError)
            return fail("URL_BLOCKED", err.message);
          throw err;
        }
        await page.goto(action.url, { waitUntil: "domcontentloaded" });
        await this.afterNavigationCheck(page);
        desk.refAttr = null;
        return { ok: true, text: `${page.url()}\n${await page.title()}` };
      }

      default:
        return fail("DESK_OFFLINE", `a browser desk cannot ${action.type}`);
    }
  }
}
