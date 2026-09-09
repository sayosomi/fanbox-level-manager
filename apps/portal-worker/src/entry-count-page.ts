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
      <h1>抽選口数の確認</h1>
      <p id="status" class="status" role="status" aria-live="polite">読み込み中です。</p>

      <section aria-labelledby="summary-heading">
        <h2 id="summary-heading">現在の情報</h2>
        <dl class="summary-list">
          <div class="summary-item">
            <dt>確認ID</dt>
            <dd id="confirmation-id">—</dd>
          </div>
          <div class="summary-item">
            <dt>現在の口数</dt>
            <dd id="entry-count">—</dd>
          </div>
          <div class="summary-item">
            <dt>最終更新</dt>
            <dd id="verified-at">—</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">口数履歴</h2>
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
      status.textContent = message;
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
        reason.textContent = entry.reason;

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
    showStatus("情報を確認しました。");
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
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f5f5f3;
  color: #252525;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 280px;
}

.page-shell {
  width: min(100% - 2rem, 42rem);
  margin: 0 auto;
  padding: 3rem 0 4rem;
}

h1,
h2 {
  line-height: 1.3;
}

h1 {
  margin: 0 0 1rem;
  font-size: clamp(1.7rem, 5vw, 2.4rem);
}

h2 {
  margin: 0 0 1rem;
  font-size: 1.25rem;
}

section {
  margin-top: 2rem;
  padding: 1.25rem;
  border: 1px solid #d8d8d3;
  border-radius: 0.75rem;
  background: #ffffff;
}

.status {
  min-height: 1.5rem;
  margin: 0;
  color: #555555;
}

.summary-list {
  display: grid;
  gap: 1rem;
  margin: 0;
}

.summary-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid #eeeeea;
}

.summary-item:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}

dt {
  color: #555555;
}

dd {
  margin: 0;
  font-size: 1.2rem;
  font-weight: 700;
  text-align: right;
}

.history-list {
  display: grid;
  gap: 0.75rem;
}

.history-item {
  display: grid;
  grid-template-columns: 5rem 1fr auto;
  gap: 0.75rem;
  align-items: baseline;
  padding: 0.75rem 0;
  border-bottom: 1px solid #eeeeea;
}

.history-item:last-child {
  border-bottom: 0;
}

.history-month,
.history-entry-count {
  font-variant-numeric: tabular-nums;
}

.history-month,
.history-reason,
.history-empty {
  color: #555555;
}

.history-entry-count {
  font-weight: 700;
}

@media (max-width: 30rem) {
  .page-shell {
    padding-top: 2rem;
  }

  .history-item {
    grid-template-columns: 1fr auto;
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
