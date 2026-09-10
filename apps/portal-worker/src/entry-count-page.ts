const ENTRY_COUNT_PAGE_PATH = "/level";
const ENTRY_COUNT_PAGE_SCRIPT_PATH = "/level/app.js";
const ENTRY_COUNT_PAGE_STYLE_PATH = "/level/style.css";

const ENTRY_COUNT_PAGE_PATHS = new Set([
  ENTRY_COUNT_PAGE_PATH,
  ENTRY_COUNT_PAGE_SCRIPT_PATH,
  ENTRY_COUNT_PAGE_STYLE_PATH,
]);

const ENTRY_COUNT_PAGE_HTML = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>抽選口数の確認</title>
    <link rel="stylesheet" href="/level/style.css">
    <script src="/level/app.js" defer></script>
  </head>
  <body>
    <main class="page-shell">
      <header class="page-header">
        <h1>支援者情報</h1>
      </header>
      <p id="status" class="status" role="status" aria-live="polite">読み込み中です。</p>

      <section class="current-count-hero" aria-labelledby="current-count-label">
        <p id="current-count-label" class="hero-label">抽選口数</p>
        <p id="entry-count" class="current-count">—</p>
      </section>

      <div class="summary-surface">
        <dl class="summary-list">
          <div class="summary-item">
            <dt>確認ID</dt>
            <dd id="confirmation-id">—</dd>
          </div>
          <div class="summary-item">
            <dt>最終更新</dt>
            <dd id="verified-at">—</dd>
          </div>
        </dl>
      </div>

      <section class="history-surface" aria-labelledby="history-heading">
        <h2 id="history-heading">履歴</h2>
        <div id="history" class="history-list" aria-live="polite"></div>
      </section>
    </main>
  </body>
</html>`;

const ENTRY_COUNT_PAGE_SCRIPT = String.raw`(() => {
  "use strict";

  const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
  const CONFIRMATION_ID_PATTERN = /^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/;
  const SNAPSHOT_KEYS = ["confirmationId", "entryCount", "verifiedAt", "history"];
  const HISTORY_KEYS = [
    "id",
    "monthKey",
    "entryCount",
    "reason",
    "occurredAt",
    "recordedAt",
  ];
  const HISTORY_REASONS = new Set([
    "当選",
    "抽選結果による口数増加",
    "抽選不参加による口数増加",
    "旧管理方式による履歴",
  ]);
  const HISTORY_REASON_LABELS = new Map([
    ["旧管理方式による履歴", "旧管理方式から移行"],
  ]);

  const status = document.getElementById("status");
  const confirmationId = document.getElementById("confirmation-id");
  const entryCount = document.getElementById("entry-count");
  const verifiedAt = document.getElementById("verified-at");
  const historyContainer = document.getElementById("history");

  function hasExactKeys(value, expectedKeys) {
    const actualKeys = Object.keys(value);
    return (
      actualKeys.length === expectedKeys.length &&
      expectedKeys.every((key) => actualKeys.includes(key))
    );
  }

  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function isValidEntryCount(value) {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value >= 1
    );
  }

  function isNonblankString(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function isCanonicalTimestamp(value) {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    ) {
      return false;
    }

    try {
      return new Date(value).toISOString() === value;
    } catch {
      return false;
    }
  }

  function validateHistoryEntry(value) {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, HISTORY_KEYS) ||
      !isNonblankString(value.id) ||
      typeof value.monthKey !== "string" ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.monthKey) ||
      !isValidEntryCount(value.entryCount) ||
      typeof value.reason !== "string" ||
      !HISTORY_REASONS.has(value.reason) ||
      !isCanonicalTimestamp(value.recordedAt)
    ) {
      return null;
    }

    const occurredAt = value.occurredAt;
    if (occurredAt !== null && !isCanonicalTimestamp(occurredAt)) {
      return null;
    }

    const requiresOccurredAt =
      value.reason === "当選" || value.reason === "抽選結果による口数増加";
    if ((occurredAt !== null) !== requiresOccurredAt) {
      return null;
    }

    return {
      id: value.id,
      monthKey: value.monthKey,
      entryCount: value.entryCount,
      reason: value.reason,
      occurredAt,
      recordedAt: value.recordedAt,
    };
  }

  function validateSnapshot(value) {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, SNAPSHOT_KEYS) ||
      typeof value.confirmationId !== "string" ||
      !CONFIRMATION_ID_PATTERN.test(value.confirmationId) ||
      !isValidEntryCount(value.entryCount) ||
      !isCanonicalTimestamp(value.verifiedAt) ||
      !Array.isArray(value.history)
    ) {
      return null;
    }

    const history = [];
    for (const historyValue of value.history) {
      const entry = validateHistoryEntry(historyValue);
      if (entry === null) {
        return null;
      }
      history.push(entry);
    }

    return {
      confirmationId: value.confirmationId,
      entryCount: value.entryCount,
      verifiedAt: value.verifiedAt,
      history,
    };
  }

  function showStatus(message) {
    if (status instanceof HTMLElement) {
      status.hidden = false;
      status.textContent = message;
    }
  }

  function hideStatus() {
    if (status instanceof HTMLElement) {
      status.hidden = true;
    }
  }

  function showInvalidLink() {
    showStatus("リンクが無効です。発行元にご確認ください。");
  }

  function showTemporaryLoadFailure() {
    showStatus("一時的に情報を読み込めません。時間をおいて再度お試しください。");
  }

  function formatVerifiedAt(value) {
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  function renderHistory(history) {
    if (!(historyContainer instanceof HTMLElement)) {
      throw new Error("missing history container");
    }

    const historyNodes = [];
    if (history.length === 0) {
      const emptyState = document.createElement("p");
      emptyState.className = "history-empty";
      emptyState.textContent = "表示できる履歴はありません。";
      historyNodes.push(emptyState);
    } else {
      for (const entry of history) {
        const row = document.createElement("article");
        row.className = "history-item";

        const month = document.createElement("span");
        month.className = "history-month";
        month.textContent = entry.monthKey;

        const reason = document.createElement("span");
        reason.className = "history-reason";
        reason.textContent = HISTORY_REASON_LABELS.get(entry.reason) ?? entry.reason;

        const entryCount = document.createElement("span");
        entryCount.className = "history-entry-count";
        entryCount.textContent = entry.entryCount + "口";

        row.append(month, reason, entryCount);
        historyNodes.push(row);
      }
    }

    historyContainer.replaceChildren(...historyNodes);
  }

  function renderSuccess(snapshot) {
    const finalUpdate = formatVerifiedAt(snapshot.verifiedAt);

    if (
      !(entryCount instanceof HTMLElement) ||
      !(verifiedAt instanceof HTMLElement) ||
      !(confirmationId instanceof HTMLElement)
    ) {
      throw new Error("missing summary element");
    }

    confirmationId.textContent = snapshot.confirmationId;
    entryCount.textContent = snapshot.entryCount + "口";
    verifiedAt.textContent = finalUpdate;
    renderHistory(snapshot.history);
    hideStatus();
  }

  async function loadEntryCount() {
    const hash = window.location.hash;
    const rawToken = hash.startsWith("#") ? hash.slice(1) : hash;
    if (!TOKEN_PATTERN.test(rawToken)) {
      showInvalidLink();
      return;
    }

    try {
      const response = await fetch("/api/my-level", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: rawToken }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });

      if (response.status === 400 || response.status === 401) {
        showInvalidLink();
        return;
      }
      if (response.status !== 200) {
        showTemporaryLoadFailure();
        return;
      }

      const snapshot = validateSnapshot(await response.json());
      if (snapshot === null) {
        showTemporaryLoadFailure();
        return;
      }

      renderSuccess(snapshot);
    } catch {
      showTemporaryLoadFailure();
    }
  }

  void loadEntryCount();
})();`;

const ENTRY_COUNT_PAGE_STYLE = `:root {
  color-scheme: light;
  --base: #faf4ed;
  --surface: #fffaf3;
  --overlay: #f2e9e1;
  --text: #575279;
  --muted: #9893a5;
  --border: #dfdad9;
  --pine: #286983;
  --foam: #56949f;
  --iris: #907aa9;
  --rose: #d7827e;
  --gold: #ea9d34;
  --love: #b4637a;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background-color: var(--base);
  color: var(--text);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 280px;
  min-height: 100vh;
  background-color: var(--base);
  color: var(--text);
}

.page-shell {
  width: min(calc(100% - 2rem), 44rem);
  margin: 0 auto;
  padding: clamp(1.75rem, 6vw, 4rem) 0 4rem;
}

h1,
h2 {
  line-height: 1.3;
  color: var(--text);
}

h1 {
  margin: 0;
  font-size: clamp(1.7rem, 5vw, 2.4rem);
}

h2 {
  margin: 0 0 1.1rem;
  font-size: 1.25rem;
}

.page-header {
  padding-bottom: 1.25rem;
  border-bottom: 1px solid var(--border);
}

.page-intro {
  max-width: 38rem;
  margin: 0.75rem 0 0;
  line-height: 1.7;
}

.status {
  display: inline-block;
  max-width: 100%;
  min-height: 1.5rem;
  margin: 1.25rem 0 0;
  padding: 0.45rem 0.7rem;
  overflow-wrap: anywhere;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background-color: var(--overlay);
  color: var(--text);
}

.current-count-hero,
.summary-surface,
.history-surface {
  margin-top: 1.25rem;
  border: 1px solid var(--border);
  border-radius: 1rem;
  background-color: var(--surface);
}

.current-count-hero {
  padding: clamp(1.5rem, 7vw, 2.75rem) clamp(1.25rem, 6vw, 2.5rem);
  border-color: var(--pine);
  border-inline-start: 0.35rem solid var(--foam);
  background-color: var(--pine);
  color: var(--base);
}

.hero-label {
  margin: 0;
  color: var(--base);
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.current-count {
  max-width: 100%;
  margin: 0.45rem 0 0;
  overflow-wrap: anywhere;
  color: var(--base);
  font-size: clamp(3rem, 14vw, 5.75rem);
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.summary-surface,
.history-surface {
  padding: 1.25rem;
}

.summary-surface {
  border-top: 0.25rem solid var(--iris);
}

.history-surface {
  border-top: 0.25rem solid var(--rose);
}

.summary-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
  margin: 0;
}

.summary-item {
  min-width: 0;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}

dt {
  color: var(--text);
  font-size: 0.85rem;
  font-weight: 700;
}

dd {
  margin: 0.4rem 0 0;
  overflow-wrap: anywhere;
  font-size: 1.2rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.history-list {
  display: grid;
  border-top: 1px solid var(--border);
}

.history-item {
  display: grid;
  grid-template-columns: minmax(5.5rem, 7rem) minmax(0, 1fr) auto;
  gap: 0.75rem;
  align-items: baseline;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--border);
}

.history-item:last-child {
  border-bottom: 0;
}

.history-month,
.history-entry-count {
  font-variant-numeric: tabular-nums;
}

.history-month {
  color: var(--text);
  font-weight: 700;
}

.history-reason,
.history-empty {
  min-width: 0;
  color: var(--text);
  overflow-wrap: anywhere;
}

.history-entry-count {
  color: var(--text);
  font-size: 1.1rem;
  font-weight: 700;
  white-space: nowrap;
}

@media (max-width: 30rem) {
  .page-shell {
    width: min(calc(100% - 1.5rem), 44rem);
    padding-top: 2rem;
  }

  .summary-list {
    grid-template-columns: 1fr;
  }

  .history-item {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .history-reason {
    grid-column: 1 / -1;
    grid-row: 2;
  }
}
`;

function staticResponse(
  body: string,
  contentType: string,
  additionalHeaders: Readonly<Record<string, string>> = {},
): Response {
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...additionalHeaders,
  });
  return new Response(body, { status: 200, headers });
}

export function isEntryCountPagePath(pathname: string): boolean {
  return ENTRY_COUNT_PAGE_PATHS.has(pathname);
}

export function handleEntryCountPageRequest(request: Request): Response {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET" },
    });
  }

  switch (new URL(request.url).pathname) {
    case ENTRY_COUNT_PAGE_PATH:
      return staticResponse(ENTRY_COUNT_PAGE_HTML, "text/html; charset=UTF-8", {
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
      });
    case ENTRY_COUNT_PAGE_SCRIPT_PATH:
      return staticResponse(
        ENTRY_COUNT_PAGE_SCRIPT,
        "application/javascript; charset=UTF-8",
      );
    case ENTRY_COUNT_PAGE_STYLE_PATH:
      return staticResponse(ENTRY_COUNT_PAGE_STYLE, "text/css; charset=UTF-8");
    default:
      return new Response(null, { status: 404 });
  }
}
