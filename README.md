# @vibecontrols/vibe-plugin-desk-browser

The browser provider for BotManor Stewards desks. It gives a Steward a dedicated Chromium profile and drives it with Playwright behind the common desk API of [`@vibecontrols/vibe-plugin-desk`](https://github.com/Algoshred/vibe-plugin-desk).

Install it next to the desk meta plugin. The meta routes actions here and enforces fencing, idempotency, timeouts, local consent and the kill switch. This plugin does the browsing.

## Actions

| Action        | What it does                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `screenshot`  | PNG of the page. Password fields are masked.                                                                                |
| `snapshot`    | The actionable elements of the page, each with a ref (`e1`, `e2`, ...), plus the page text. Password values are never read. |
| `click`       | Clicks a ref or a point. Takes `button` and a double-click `count`.                                                         |
| `type`        | Types text, after focusing a ref or point if one is given.                                                                  |
| `secret_fill` | Fills a field from the secret store, only when the page origin equals `expectedOrigin`. The value is never returned.        |
| `key`         | Presses keys in Playwright syntax, for example `Enter` or `Control+A`.                                                      |
| `scroll`      | Scrolls by `dx`/`dy`, over a ref or point if one is given.                                                                  |
| `navigate`    | Opens an http(s) URL that passes the URL guard (below).                                                                     |

Window, shell and file actions are not browser actions. The meta refuses them for this provider.

Refs come from the last `snapshot` and are written into the page under an attribute name that is random per snapshot, so a page cannot forge them. A ref that no longer matches exactly one visible element returns `TARGET_NOT_FOUND`: take a new snapshot.

## Where the browser may go

The URL guard is the same as the FluidGrids remote browser node's:

- **Allowed:** http and https only, with no user name or password in the URL.
- **Refused:**
  - `localhost`, `*.local`, `*.internal` and single-label names;
  - every address that is not globally routable: private, loopback, CGNAT, link-local (which includes the cloud metadata address), multicast and reserved, plus IPv4-mapped and NAT64 forms of them.
- **When the guard runs:**
  - before every navigation;
  - on the final URL after redirects; a blocked final URL clears the page and returns `URL_BLOCKED`;
  - on every request the page makes, without a DNS lookup.
- **Always off:** service workers and downloads.

**Limits:**

- Chrome resolves names itself, so DNS rebinding is not caught here. A redirect is followed before its target is checked.
- On a **cloud desk**, the egress proxy covers both cases: it checks the address it actually connects to.
- On a **user's own machine**, there is no proxy. That machine's network is the user's, and the consent screen says so.

## Configuration

Set with `vibe config set <key> <value>`:

| Key                            | Default                   | Meaning                                                                            |
| ------------------------------ | ------------------------- | ---------------------------------------------------------------------------------- |
| `desk-browser.executable-path` | Playwright's Chromium     | Chrome or Chromium binary                                                          |
| `desk-browser.channel`         | none                      | `chrome`, `msedge`, ... instead of a path                                          |
| `desk-browser.headless`        | off when a display exists | `on` or `off`                                                                      |
| `desk-browser.proxy`           | none                      | http(s) proxy URL without credentials. Cloud desks use `http://172.20.0.200:3128`. |
| `desk-browser.allowed-hosts`   | any public host           | Comma-separated allow-list. `*.example.com` matches subdomains.                    |

The browser starts on the first action and closes when the agent stops. The profile lives in `<dataDir>/desk-browser-profile` with mode 0700.

On a cloud desk, that folder is part of the home snapshot taken at hibernation. Sign-ins that use persistent cookies survive a restore; session-only cookies do not, just as when a browser is closed.

## Secret fill

`secret_fill` needs a secret store that registers a resolver under the `desk-secret` provider type:

```ts
import type { DeskSecretResolver } from "@vibecontrols/vibe-plugin-desk-browser";

const store: DeskSecretResolver = {
  async resolve(secretRef, { origin, deskId }) {
    // Return the value only if this secret may be used on `origin`, else null.
    return null;
  },
};
host.serviceRegistry?.registerProvider?.(
  "desk-secret",
  store,
  "my-secret-store",
);
```

Without a store, `secret_fill` is refused and every other action works.

## Development

```bash
bun install
bun run sanity   # format, lint, type check, build, tests
```

The browser tests need Chrome or Chromium: `/usr/bin/google-chrome`, or set `DESK_BROWSER_TEST_EXECUTABLE`. Without one they are skipped, and the test run says so.

## License

MIT
