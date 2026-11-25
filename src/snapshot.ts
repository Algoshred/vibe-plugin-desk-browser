/**
 * The desk browser's `snapshot`: a compact list of what a model can act on,
 * each with a stable ref (spec §7: "accessibility-tree ref from the last
 * snapshot (preferred)").
 *
 * Refs are written into the page as an attribute whose NAME is random per
 * snapshot (`data-vc-<nonce>`). A page cannot predict it, so it cannot plant
 * elements that answer to a ref the model will use later. Each new snapshot
 * removes the previous attribute first. Before every action the backend
 * re-resolves the ref and requires exactly one visible match
 * (TARGET_NOT_FOUND otherwise).
 *
 * The main frame only; content inside iframes is not listed. Password field
 * values are never read: they appear as `"value": "(hidden)"` when non-empty.
 */

export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  level?: number;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
  /** True when the element cap cut the list short. */
  truncated: boolean;
}

export const SNAPSHOT_LIMITS = {
  maxElements: 500,
  maxName: 120,
  maxValue: 200,
  maxText: 20_000,
} as const;

export interface SnapshotArgs {
  attr: string;
  previousAttr: string | null;
  maxElements: number;
  maxName: number;
  maxValue: number;
}

/**
 * Runs INSIDE the page (passed to `page.evaluate`). It must stay
 * self-contained: no imports, no closures over module scope.
 */
export function collectInPage(args: SnapshotArgs): {
  url: string;
  title: string;
  elements: SnapshotElement[];
  truncated: boolean;
} {
  const { attr, previousAttr, maxElements, maxName, maxValue } = args;
  if (previousAttr) {
    for (const el of Array.from(
      document.querySelectorAll(`[${previousAttr}]`),
    )) {
      el.removeAttribute(previousAttr);
    }
  }
  const clip = (s: string, n: number) => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const visible = (el: Element): boolean => {
    const h = el as HTMLElement;
    const withCheck = h as HTMLElement & { checkVisibility?: () => boolean };
    if (
      typeof withCheck.checkVisibility === "function" &&
      !withCheck.checkVisibility()
    )
      return false;
    const r = h.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const textOf = (el: Element | null): string =>
    el ? ((el as HTMLElement).innerText ?? el.textContent ?? "") : "";
  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0] ?? null;
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img" && el.getAttribute("alt")) return "img";
    if (tag === "input") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "hidden") return null;
      if (["button", "submit", "reset", "image"].includes(type))
        return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if ((el as HTMLElement).isContentEditable) return "textbox";
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && Number(tabindex) >= 0) return "generic";
    return null;
  };
  const nameOf = (el: Element): string => {
    const label = el.getAttribute("aria-label");
    if (label) return label;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    const field = el as HTMLInputElement;
    if (field.labels && field.labels.length) {
      return Array.from(field.labels)
        .map((l) => textOf(l))
        .join(" ");
    }
    for (const a of ["placeholder", "alt", "title", "value"]) {
      const v = el.getAttribute(a);
      if (
        v &&
        !(
          a === "value" &&
          el.tagName.toLowerCase() === "input" &&
          field.type !== "submit" &&
          field.type !== "button"
        )
      )
        return v;
    }
    return textOf(el);
  };

  const elements: SnapshotElement[] = [];
  let truncated = false;
  let n = 0;
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const role = roleOf(el);
    if (!role || !visible(el)) continue;
    if (elements.length >= maxElements) {
      truncated = true;
      break;
    }
    const ref = `e${++n}`;
    el.setAttribute(attr, ref);
    const item: SnapshotElement = {
      ref,
      role,
      name: clip(nameOf(el), maxName),
    };
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const f = el as HTMLInputElement;
      if (f.type === "password") {
        if (f.value) item.value = "(hidden)";
      } else if (f.type === "checkbox" || f.type === "radio") {
        item.checked = f.checked;
      } else if (f.value) {
        item.value = clip(f.value, maxValue);
      }
      if (f.disabled) item.disabled = true;
    }
    if (role === "heading") {
      const m = /^h([1-6])$/.exec(tag);
      item.level = m
        ? Number(m[1])
        : Number(el.getAttribute("aria-level") ?? 2);
    }
    elements.push(item);
  }
  return { url: location.href, title: document.title, elements, truncated };
}

/** A fresh, unguessable attribute name for one snapshot. */
export function newRefAttribute(
  random: () => string = () => crypto.randomUUID(),
): string {
  return `data-vc-${random()
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 16)
    .toLowerCase()}`;
}

/** CSS selector for a ref under a given attribute; null when the ref is malformed. */
export function refSelector(attr: string, ref: string): string | null {
  if (!/^e\d{1,6}$/.test(ref)) return null;
  return `[${attr}="${ref}"]`;
}
