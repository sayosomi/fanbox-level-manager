import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createPortalWorker, type PortalEnv } from "../src/index.js";

const BASE_URL = "https://portal.example";
const ADMIN_SECRET = "test-sync-secret";
const RAW_TOKEN = "A".repeat(43);
const TOKEN_HASH = "a".repeat(64);
const SUPPORTER_ID = "supporter-private-id";

function worker() {
  return createPortalWorker(() => new Date("2026-09-05T00:00:00.000Z"));
}

async function responseAt(
  path: string,
  method = "GET",
  targetEnv: PortalEnv = env,
): Promise<Response> {
  return worker().fetch(
    new Request(`${BASE_URL}${path}`, { method }),
    targetEnv,
  );
}

async function assetAt(path: string): Promise<string> {
  return (await responseAt(path)).text();
}

class FakeHTMLElement {
  readonly tagName: string;
  className = "";
  textContent = "";
  readonly children: FakeHTMLElement[] = [];

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  append(...nodes: FakeHTMLElement[]) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeHTMLElement[]) {
    this.children.splice(0, this.children.length, ...nodes);
  }
}

function createFakeDocument() {
  const elements = new Map<string, FakeHTMLElement>(
    [
      ["status", new FakeHTMLElement("p")],
      ["confirmation-id", new FakeHTMLElement("dd")],
      ["entry-count", new FakeHTMLElement("p")],
      ["verified-at", new FakeHTMLElement("dd")],
      ["history", new FakeHTMLElement("div")],
    ],
  );
  const createdElements = [...elements.values()];

  return {
    document: {
      getElementById(id: string) {
        return elements.get(id) ?? null;
      },
      createElement(tagName: string) {
        const element = new FakeHTMLElement(tagName);
        createdElements.push(element);
        return element;
      },
    },
    elements,
    createdElements,
  };
}

describe("supporter entry-count page", () => {
  it("serves the protected static page with the required structure and headers", async () => {
    const response = await responseAt("/level");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/html; charset=UTF-8",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain("<title>抽選口数の確認</title>");
    expect(html).toContain("<h1>抽選口数の確認</h1>");
    expect(html).toContain(
      "<p class=\"page-intro\">次回の抽選で使われる口数と、これまでの履歴を確認できます。</p>",
    );
    expect(html).toContain('id="status"');
    expect((html.match(/id="entry-count"/g) ?? []).length).toBe(1);
    expect(html).toContain(
      '<section class="current-count-hero" aria-labelledby="current-count-label">',
    );
    expect(html).toContain('<p id="current-count-label" class="hero-label">次回抽選</p>');
    expect(html).toContain('<dt>確認ID</dt>');
    expect(html).toContain('id="confirmation-id"');
    expect(html).toContain('id="verified-at"');
    expect(html).toContain('id="history"');
    const heroIndex = html.indexOf('<section class="current-count-hero"');
    const confirmationIdIndex = html.indexOf('id="confirmation-id"');
    const verifiedAtIndex = html.indexOf('id="verified-at"');
    const historyIndex = html.indexOf('id="history"');
    expect(heroIndex).toBeGreaterThan(html.indexOf("<h1>"));
    expect(heroIndex).toBeLessThan(confirmationIdIndex);
    expect(confirmationIdIndex).toBeLessThan(verifiedAtIndex);
    expect(verifiedAtIndex).toBeLessThan(historyIndex);
    expect(html).not.toMatch(/>[^<]*(?:Lv\.|レベル)[^<]*</i);
    expect(html).toContain('<link rel="stylesheet" href="/level/style.css">');
    expect(html).toContain('<script src="/level/app.js" defer></script>');
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
  });

  it("does not put private data or unsafe page features in the HTML source", async () => {
    const html = await assetAt("/level");

    expect(html).not.toContain(RAW_TOKEN);
    expect(html).not.toContain(TOKEN_HASH);
    expect(html).not.toContain(SUPPORTER_ID);
    expect(html).not.toContain(ADMIN_SECRET);
    expect(html).not.toContain("fanbox.cc/manage/relationships/");
    expect(html).not.toContain("relationship");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["'](?:https?:)?\/\//i);
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(
      /analytics|telemetry|localStorage|sessionStorage|indexedDB/i,
    );
  });

  it("serves the JavaScript and stylesheet assets with private cache headers", async () => {
    const scriptResponse = await responseAt("/level/app.js");
    const styleResponse = await responseAt("/level/style.css");

    expect(scriptResponse.status).toBe(200);
    expect(scriptResponse.headers.get("Content-Type")).toBe(
      "application/javascript; charset=UTF-8",
    );
    expect(scriptResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(scriptResponse.headers.get("X-Content-Type-Options")).toBe(
      "nosniff",
    );

    expect(styleResponse.status).toBe(200);
    expect(styleResponse.headers.get("Content-Type")).toBe(
      "text/css; charset=UTF-8",
    );
    expect(styleResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(styleResponse.headers.get("X-Content-Type-Options")).toBe(
      "nosniff",
    );
  });

  it("keeps token handling and the supporter request within the settled client contract", async () => {
    const script = await assetAt("/level/app.js");

    expect(script).toContain("window.location.hash");
    expect(script).toContain(
      'hash.startsWith("#") ? hash.slice(1) : hash',
    );
    expect(script).toContain("/^[A-Za-z0-9_-]{43}$/");
    expect(script).toContain(
      "/^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/",
    );
    expect(script).toContain('fetch("/api/my-level", {');
    expect(script).toContain('method: "POST"');
    expect(script).toContain('headers: { "Content-Type": "application/json" }');
    expect(script).toContain('JSON.stringify({ token: rawToken })');
    expect(script).toContain('cache: "no-store"');
    expect(script).toContain('credentials: "omit"');
    expect(script).toContain('redirect: "error"');
    expect(script).toContain('referrerPolicy: "no-referrer"');

    expect(script).not.toContain("decodeURIComponent");
    expect(script).not.toContain("URLSearchParams");
    expect(script).not.toContain("localStorage");
    expect(script).not.toContain("sessionStorage");
    expect(script).not.toContain("indexedDB");
    expect(script).not.toContain("document.cookie");
    expect(script).not.toContain("console.");
    expect(script).not.toContain("hashchange");
    expect(script).not.toContain("replaceState");
    expect(script).not.toContain("pushState");
    expect(script).not.toMatch(/location\.hash\s*=/);
    expect(script).not.toMatch(/location\.(replace|assign)\s*\(/);
  });

  it("validates and renders the supporter snapshot using safe APIs", async () => {
    const script = await assetAt("/level/app.js");

    expect(script).toContain('entryCount.textContent = snapshot.entryCount + "口"');
    expect(script).toContain(
      "confirmationId.textContent = snapshot.confirmationId",
    );
    expect(script).toContain('timeZone: "Asia/Tokyo"');
    expect(script).toContain('new Intl.DateTimeFormat("ja-JP"');
    expect(script).toContain("for (const entry of history)");
    expect(script).not.toContain("history.sort");
    expect(script).toContain("表示できる履歴はありません。");
    expect(script).toContain("当選");
    expect(script).toContain("抽選結果による口数増加");
    expect(script).toContain("抽選不参加による口数増加");
    expect(script).toContain("旧管理方式による履歴");
    expect(script).toContain("Number.isFinite");
    expect(script).toContain("Number.isInteger");
    expect(script).toContain("toISOString() === value");
    expect(script).not.toContain("nextLotteryEntryCount");
    expect(script).not.toContain("currentLevel");
    expect(script).toContain("hasExactKeys(value, SNAPSHOT_KEYS)");
    expect(script).toContain("hasExactKeys(value, HISTORY_KEYS)");
    expect(script).toContain("historyContainer.replaceChildren");
    expect(script).toContain("document.createElement");
    expect(script).toContain("textContent");
    expect(script).not.toContain("innerHTML");
    expect(script).not.toContain("outerHTML");
    expect(script).not.toContain("insertAdjacentHTML");
    expect(script).not.toContain("document.write");
    expect(script).not.toContain("DOMParser");
  });

  it("renders the canonical current count once and keeps supporting data in order", async () => {
    const script = await assetAt("/level/app.js");
    const { document, elements, createdElements } = createFakeDocument();
    const snapshot = {
      confirmationId: "ABCD-1234-5678-9ABC",
      entryCount: 15,
      verifiedAt: "2026-09-05T00:00:00.000Z",
      history: [
        {
          id: "history-first",
          monthKey: "2026-07",
          entryCount: 9,
          reason: "当選",
          occurredAt: "2026-07-01T00:00:00.000Z",
          recordedAt: "2026-07-02T00:00:00.000Z",
        },
        {
          id: "history-second",
          monthKey: "2026-08",
          entryCount: 11,
          reason: "旧管理方式による履歴",
          occurredAt: null,
          recordedAt: "2026-08-02T00:00:00.000Z",
        },
      ],
    };

    const executeScript = new Function(
      "document",
      "HTMLElement",
      "window",
      "fetch",
      script,
    ) as (
      document: ReturnType<typeof createFakeDocument>["document"],
      HTMLElement: typeof FakeHTMLElement,
      window: { location: { hash: string } },
      fetch: () => Promise<{ status: number; json: () => Promise<unknown> }>,
    ) => void;
    executeScript(
      document,
      FakeHTMLElement,
      { location: { hash: `#${RAW_TOKEN}` } },
      () =>
        Promise.resolve({
          status: 200,
          json: () => Promise.resolve(snapshot),
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(elements.get("entry-count")?.textContent).toBe("15口");
    expect(
      createdElements.filter((element) => element.textContent === "15口"),
    ).toHaveLength(1);
    expect(elements.get("confirmation-id")?.textContent).toBe(
      "ABCD-1234-5678-9ABC",
    );
    expect(elements.get("verified-at")?.textContent).toContain(
      "2026/09/05 09:00",
    );
    expect(elements.get("history")?.children.map((row) => [
      row.children[0]?.textContent,
      row.children[1]?.textContent,
      row.children[2]?.textContent,
    ])).toEqual([
      ["2026-07", "当選", "9口"],
      ["2026-08", "旧管理方式による履歴", "11口"],
    ]);
  });

  it("uses the settled Rosé Pine Dawn palette and responsive accessible surfaces", async () => {
    const style = await assetAt("/level/style.css");
    const palette = {
      base: "#faf4ed",
      surface: "#fffaf3",
      overlay: "#f2e9e1",
      text: "#575279",
      muted: "#9893a5",
      border: "#dfdad9",
      pine: "#286983",
      foam: "#56949f",
      iris: "#907aa9",
      rose: "#d7827e",
      gold: "#ea9d34",
      love: "#b4637a",
    };

    for (const [name, value] of Object.entries(palette)) {
      expect(style).toContain(`--${name}: ${value};`);
    }
    expect(style).toMatch(/body \{[\s\S]*background-color: var\(--base\);/);
    expect(style).toContain("background-color: var(--surface);");
    expect(style).toContain(".current-count-hero {");
    expect(style).toContain("background-color: var(--pine);");
    expect(style).toContain("color: var(--text);");
    expect(style).not.toMatch(
      /color:\s*var\(--(?:muted|gold|love|rose|foam)\)/,
    );
    expect(style).toContain("@media (max-width: 30rem)");
    expect(style).toContain("overflow-wrap: anywhere;");
    expect(style).toContain("grid-template-columns: minmax(0, 1fr) auto;");
  });

  it("uses indistinguishable invalid-link handling and generic temporary failure handling", async () => {
    const script = await assetAt("/level/app.js");

    expect(script).toContain(
      "if (response.status === 400 || response.status === 401)",
    );
    expect(script).toContain("showInvalidLink();");
    expect(script).toContain("if (response.status !== 200)");
    expect(script).toContain("showTemporaryLoadFailure();");
    expect(script).toContain("catch {");
    expect(script).not.toContain("response.statusText");
    expect(script).not.toContain("response.text()");
    expect(script).not.toContain("response.body");
    expect(script).not.toContain("error.message");
  });

  it.each(["/level", "/level/app.js", "/level/style.css"])(
    "returns 405 with Allow GET for non-GET %s",
    async (path) => {
      const response = await responseAt(path, "POST");

      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET");
    },
  );

  it("preserves existing API method guards and unknown-path behavior", async () => {
    for (const path of [
      "/api/admin/sync-supporter",
      "/api/admin/set-supporter-token",
      "/api/my-level",
    ]) {
      const response = await responseAt(path);
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
    }

    const unknown = await responseAt("/unknown");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("Content-Type")).toBe("application/json");
    expect(await unknown.json()).toEqual({ error: "not_found" });
  });
});
