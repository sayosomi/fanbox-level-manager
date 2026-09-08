export const ADMIN_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

export const ADMIN_PAGE = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>FANBOX抽選レベル管理</title>
    <link rel="stylesheet" href="/style.css">
  </head>
  <body>
    <main>
      <h1>FANBOX抽選レベル管理</h1>
      <p id="status" role="status">ローカル管理アプリケーションは起動しています。</p>
      <section aria-labelledby="heading">
        <h2 id="heading">支援者一覧</h2>
        <p id="list-status" role="status">支援者一覧を読み込んでいます。</p>
        <ul id="list" aria-live="polite"></ul>
      </section>
    </main>
    <script src="/app.js" defer></script>
  </body>
</html>
`;

export const ADMIN_SCRIPT = `
const SUPPORTER_KEYS = [
  "id",
  "displayName",
  "currentLevel",
  "nextLotteryEntryCount",
  "supporting",
  "latestMonthKey",
  "portalDeliveryState",
];
const PORTAL_DELIVERY_STATES = new Set([
  "not_issued",
  "issued",
  "provisioned",
  "sent",
]);
const PORTAL_DELIVERY_LABELS = {
  not_issued: "ポータル: 未発行",
  issued: "ポータル: 発行済み・未連携",
  provisioned: "ポータル: 発行済み・未送信",
  sent: "ポータル: 送信済み",
};
const MONTH_KEY_PATTERN = /^\\d{4}-(0[1-9]|1[0-2])$/;
const PORTAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CANONICAL_TIMESTAMP_PATTERN =
  /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isNonNegativeInteger(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPortalDeliveryState(value) {
  return typeof value === "string" && PORTAL_DELIVERY_STATES.has(value);
}

function isCanonicalTimestamp(value) {
  if (
    typeof value !== "string" ||
    !CANONICAL_TIMESTAMP_PATTERN.test(value)
  ) {
    return false;
  }

  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validateSupporterResponse(value) {
  if (!isRecord(value) || !hasExactKeys(value, ["supporters"])) {
    throw new TypeError("invalid supporter response");
  }

  if (!Array.isArray(value.supporters)) {
    throw new TypeError("invalid supporter list");
  }

  return value.supporters.map((supporter) => {
    if (!isRecord(supporter) || !hasExactKeys(supporter, SUPPORTER_KEYS)) {
      throw new TypeError("invalid supporter item");
    }

    if (
      !isNonBlankString(supporter.id) ||
      !isNonBlankString(supporter.displayName) ||
      !isNonNegativeInteger(supporter.currentLevel) ||
      !isNonNegativeInteger(supporter.nextLotteryEntryCount) ||
      supporter.nextLotteryEntryCount !== supporter.currentLevel + 1 ||
      typeof supporter.supporting !== "boolean" ||
      !(
        supporter.latestMonthKey === null ||
        (typeof supporter.latestMonthKey === "string" &&
          supporter.latestMonthKey.length === 7 &&
          MONTH_KEY_PATTERN.test(supporter.latestMonthKey))
      ) ||
      !isPortalDeliveryState(supporter.portalDeliveryState)
    ) {
      throw new TypeError("invalid supporter item");
    }

    return supporter;
  });
}

function validatePortalLinkResponse(value) {
  if (!isRecord(value) || !hasExactKeys(value, ["portalUrl", "verifiedAt"])) {
    throw new TypeError("invalid portal link response");
  }
  if (!isCanonicalTimestamp(value.verifiedAt)) {
    throw new TypeError("invalid portal link timestamp");
  }
  if (typeof value.portalUrl !== "string") {
    throw new TypeError("invalid portal link URL");
  }

  let portalUrl;
  try {
    portalUrl = new URL(value.portalUrl);
  } catch {
    throw new TypeError("invalid portal link URL");
  }

  const token = portalUrl.hash.startsWith("#")
    ? portalUrl.hash.slice(1)
    : "";
  if (
    portalUrl.protocol !== "https:" ||
    portalUrl.username !== "" ||
    portalUrl.password !== "" ||
    portalUrl.pathname !== "/level" ||
    portalUrl.search !== "" ||
    portalUrl.hash === "" ||
    !PORTAL_TOKEN_PATTERN.test(token)
  ) {
    throw new TypeError("invalid portal link URL");
  }

  return value.portalUrl;
}

function validatePortalSentResponse(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["portalDeliveryState"]) ||
    value.portalDeliveryState !== "sent"
  ) {
    throw new TypeError("invalid portal sent response");
  }

  return "sent";
}

function showPortalFailure(status, message) {
  status.textContent = message;
}

function showPortalSuccess(status, portalUrl) {
  const success = document.createElement("p");
  const warning = document.createElement("p");
  const secretUrl = document.createElement("code");

  success.textContent = "ポータルURLを発行しました。";
  warning.textContent =
    "この秘密のURLは保存されません。今すぐコピーしてください。";
  secretUrl.textContent = portalUrl;
  status.replaceChildren(success, warning, secretUrl);
}

function renderSupporter(supporter) {
  const item = document.createElement("li");
  const name = document.createElement("h3");
  const level = document.createElement("p");
  const entries = document.createElement("p");
  const supportStatus = document.createElement("p");
  const latestMonth = document.createElement("p");
  const portalDeliveryStatus = document.createElement("p");
  const portalButton = document.createElement("button");
  const portalLinkStatus = document.createElement("p");
  const sentButton = document.createElement("button");
  const sentStatus = document.createElement("p");
  let portalDeliveryState = supporter.portalDeliveryState;
  let portalOperationActive = false;

  function updatePortalButtons() {
    portalButton.disabled = portalOperationActive;
    sentButton.disabled =
      portalOperationActive || portalDeliveryState !== "provisioned";
  }

  function updatePortalDeliveryState() {
    portalDeliveryStatus.textContent = PORTAL_DELIVERY_LABELS[portalDeliveryState];
    updatePortalButtons();
  }

  async function prepareSupporterPortalLink() {
    if (portalOperationActive) {
      return;
    }
    if (
      !window.confirm(
        "新しいポータルURLを発行します。以前のURLがある場合、以前のURLは現在のURLではなくなります。続行しますか？",
      )
    ) {
      return;
    }

    portalOperationActive = true;
    updatePortalButtons();
    portalLinkStatus.textContent = "ポータルURLを準備しています。";

    try {
      const { id: supporterId } = supporter;
      const response = await fetch("/api/portal-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ supporterId }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      if (response.status === 503) {
        showPortalFailure(portalLinkStatus, "ポータル連携が設定されていません。");
        return;
      }
      if (!response.ok) {
        throw new Error("portal link request failed");
      }

      const result = validatePortalLinkResponse(await response.json());
      portalDeliveryState = "provisioned";
      updatePortalDeliveryState();
      showPortalSuccess(portalLinkStatus, result);
    } catch {
      showPortalFailure(
        portalLinkStatus,
        "ポータルURLを準備できませんでした。",
      );
    } finally {
      portalOperationActive = false;
      updatePortalButtons();
    }
  }

  async function markPortalSent() {
    if (portalOperationActive || portalDeliveryState !== "provisioned") {
      return;
    }
    if (
      !window.confirm(
        "この操作はメッセージを送信しません。ポータルURLをすでに本人へ送信済みの場合のみ記録します。続行しますか？",
      )
    ) {
      return;
    }

    portalOperationActive = true;
    updatePortalButtons();
    sentStatus.textContent = "送信済みとして記録しています。";

    try {
      const { id: supporterId } = supporter;
      const response = await fetch("/api/portal-link/sent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ supporterId }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      if (response.status === 409) {
        sentStatus.textContent =
          "ポータル状態が更新されています。一覧を再読み込みしてください。";
        return;
      }
      if (!response.ok) {
        throw new Error("portal sent request failed");
      }

      const result = validatePortalSentResponse(await response.json());
      if (result !== "sent") {
        throw new TypeError("invalid portal sent response");
      }
      portalDeliveryState = "sent";
      updatePortalDeliveryState();
      sentStatus.textContent = "送信済みとして記録しました。";
    } catch {
      sentStatus.textContent = "ポータル送信状態を記録できませんでした。";
    } finally {
      portalOperationActive = false;
      updatePortalButtons();
    }
  }

  name.textContent = supporter.displayName;
  level.textContent = \`Lv.\${supporter.currentLevel}\`;
  entries.textContent = \`\${supporter.nextLotteryEntryCount}口\`;
  supportStatus.textContent = supporter.supporting ? "支援中" : "支援停止";
  latestMonth.textContent = \`最新処理月: \${supporter.latestMonthKey ?? "未処理"}\`;
  portalDeliveryStatus.setAttribute("role", "status");
  portalButton.type = "button";
  portalButton.textContent = "ポータルURLを発行・再発行";
  sentButton.type = "button";
  sentButton.textContent = "送信済みとして記録";
  sentStatus.setAttribute("role", "status");
  portalButton.addEventListener("click", () => {
    void prepareSupporterPortalLink();
  });
  sentButton.addEventListener("click", () => {
    void markPortalSent();
  });
  updatePortalDeliveryState();
  item.replaceChildren(
    name,
    level,
    entries,
    supportStatus,
    latestMonth,
    portalDeliveryStatus,
    portalButton,
    portalLinkStatus,
    sentButton,
    sentStatus,
  );
  return item;
}

function showListState(status, list, message) {
  status.textContent = message;
  list.replaceChildren();
}

async function loadSupporters(status, list) {
  showListState(status, list, "支援者一覧を読み込んでいます。");

  try {
    const response = await fetch("/api/supporters", {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      throw new Error("supporter list request failed");
    }

    const supporters = validateSupporterResponse(await response.json());
    if (supporters.length === 0) {
      showListState(status, list, "支援者はいません。");
      return;
    }

    status.textContent = "";
    list.replaceChildren(...supporters.map(renderSupporter));
  } catch {
    showListState(status, list, "支援者一覧を読み込めませんでした。");
  }
}

document.documentElement.dataset.adminReady = "true";
const listStatus = document.getElementById("list-status");
const supporterList = document.getElementById("list");
if (listStatus !== null && supporterList !== null) {
  void loadSupporters(listStatus, supporterList);
}
`;

export const ADMIN_STYLES = `:root {
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
  color: #252525;
  background: #f4f5f7;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
}

main {
  width: min(100% - 2rem, 56rem);
  margin: 0 auto;
  padding: clamp(2rem, 8vw, 6rem) 0;
}

h1 {
  margin: 0;
  font-size: clamp(1.6rem, 3vw, 2.4rem);
  line-height: 1.3;
}

#status {
  margin: 1.5rem 0 0;
  padding: 1rem 1.25rem;
  border: 1px solid #cfd4dc;
  border-radius: 0.5rem;
  background: #ffffff;
}

section {
  margin-top: 2rem;
}

h2 {
  margin: 0;
  font-size: 1.35rem;
}

#list-status {
  margin: 0.75rem 0 0;
}

#list {
  display: grid;
  gap: 0.75rem;
  margin: 1rem 0 0;
  padding: 0;
  list-style: none;
}

#list li {
  padding: 1rem 1.25rem;
  border: 1px solid #cfd4dc;
  border-radius: 0.5rem;
  background: #ffffff;
}

#list h3,
#list p {
  margin: 0;
}

#list p + p {
  margin-top: 0.35rem;
}
`;
