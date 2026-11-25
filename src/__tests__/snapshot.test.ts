/**
 * `collectInPage` runs inside the desk's browser (page.evaluate), where test
 * coverage cannot see it. These tests run the same function against a
 * happy-dom document, with element boxes stubbed (happy-dom does no layout).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import {
  collectInPage,
  SNAPSHOT_LIMITS,
  type SnapshotArgs,
} from "../snapshot.js";

const win = new Window({ url: "https://bank.example/login" });
const saved: Record<string, unknown> = {};

beforeAll(() => {
  for (const key of ["document", "location"] as const) {
    saved[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = win[key];
  }
  // Every element is 10x10 unless it carries data-hidden.
  win.HTMLElement.prototype.getBoundingClientRect = function (this: {
    hasAttribute(n: string): boolean;
  }) {
    const size = this.hasAttribute("data-hidden") ? 0 : 10;
    return {
      width: size,
      height: size,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: size,
      bottom: size,
    } as DOMRect;
  } as never;
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved))
    (globalThis as Record<string, unknown>)[key] = value;
  void win.happyDOM.close();
});

const args = (over: Partial<SnapshotArgs> = {}): SnapshotArgs => ({
  attr: "data-vc-aaaa",
  previousAttr: null,
  maxElements: SNAPSHOT_LIMITS.maxElements,
  maxName: SNAPSHOT_LIMITS.maxName,
  maxValue: SNAPSHOT_LIMITS.maxValue,
  ...over,
});

function render(html: string) {
  win.document.title = "Sign in";
  win.document.body.innerHTML = html;
}

describe("collectInPage", () => {
  test("lists actionable elements with roles, names, values and refs", () => {
    render(`
      <h2>Welcome</h2>
      <a href="/help">Help</a>
      <span id="lbl">Account id</span><input aria-labelledby="lbl" value="acc-42" />
      <label for="u">User name</label><input id="u" />
      <label for="p">Password</label><input id="p" type="password" value="hunter2" />
      <input type="password" placeholder="Empty secret" />
      <input type="checkbox" aria-label="Remember me" checked />
      <input type="radio" title="Plan A" />
      <input type="submit" value="Go" />
      <input type="hidden" value="csrf" />
      <input type="range" aria-label="Volume" />
      <input type="search" placeholder="Search" />
      <select aria-label="Country"><option value="in" selected>India</option></select>
      <textarea aria-label="Notes" disabled>hello</textarea>
      <button>Sign in</button>
      <summary>More</summary>
      <img src="x.png" alt="Logo" />
      <img src="y.png" />
      <div role="tab button">Tab one</div>
      <div contenteditable="true" aria-label="Editor"></div>
      <div tabindex="0">Focusable</div>
      <div tabindex="-1">Not focusable</div>
      <div aria-level="3" role="heading">Aria heading</div>
      <button data-hidden>Invisible</button>
    `);
    const snap = collectInPage(args());
    expect(snap.url).toBe("https://bank.example/login");
    expect(snap.title).toBe("Sign in");
    expect(snap.truncated).toBe(false);
    const by = (name: string) => snap.elements.find((e) => e.name === name);

    expect(by("Welcome")).toMatchObject({ role: "heading", level: 2 });
    expect(by("Help")?.role).toBe("link");
    expect(by("Account id")).toMatchObject({
      role: "textbox",
      value: "acc-42",
    });
    expect(by("User name")?.role).toBe("textbox");
    expect(by("Password")).toMatchObject({
      role: "textbox",
      value: "(hidden)",
    });
    expect(by("Empty secret")?.value).toBeUndefined();
    expect(by("Remember me")).toMatchObject({
      role: "checkbox",
      checked: true,
    });
    expect(by("Plan A")).toMatchObject({ role: "radio", checked: false });
    expect(by("Go")?.role).toBe("button");
    expect(by("Volume")?.role).toBe("slider");
    expect(by("Search")?.role).toBe("searchbox");
    expect(by("Country")?.role).toBe("combobox");
    expect(by("Notes")).toMatchObject({ role: "textbox", disabled: true });
    expect(by("Sign in")?.role).toBe("button");
    expect(by("More")?.role).toBe("button");
    expect(by("Logo")?.role).toBe("img");
    expect(by("Tab one")?.role).toBe("tab");
    expect(by("Focusable")?.role).toBe("generic");
    expect(by("Aria heading")).toMatchObject({ role: "heading", level: 3 });
    expect(by("Not focusable")).toBeUndefined();
    expect(by("Invisible")).toBeUndefined();
    expect(snap.elements.some((e) => e.value === "csrf")).toBe(false);
    expect(JSON.stringify(snap)).not.toContain("hunter2");

    // Refs are written under the snapshot's attribute, numbered in order.
    expect(snap.elements[0]?.ref).toBe("e1");
    const tagged = win.document.querySelectorAll("[data-vc-aaaa]");
    expect(tagged.length).toBe(snap.elements.length);
  });

  test("a new snapshot removes the previous ref attribute", () => {
    render(`<button>One</button>`);
    collectInPage(args({ attr: "data-vc-old" }));
    expect(win.document.querySelectorAll("[data-vc-old]").length).toBe(1);
    collectInPage(args({ attr: "data-vc-new", previousAttr: "data-vc-old" }));
    expect(win.document.querySelectorAll("[data-vc-old]").length).toBe(0);
    expect(win.document.querySelectorAll("[data-vc-new]").length).toBe(1);
  });

  test("clips long names and values and stops at the element cap", () => {
    const long = "x".repeat(500);
    render(
      `<input aria-label="${long}" value="${long}" />${"<button>b</button>".repeat(5)}`,
    );
    const snap = collectInPage(
      args({ maxElements: 3, maxName: 10, maxValue: 8 }),
    );
    expect(snap.truncated).toBe(true);
    expect(snap.elements).toHaveLength(3);
    expect(snap.elements[0]?.name).toBe(`${"x".repeat(9)}…`);
    expect(snap.elements[0]?.value).toBe(`${"x".repeat(7)}…`);
  });
});
