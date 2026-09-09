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
      <section aria-labelledby="backup-destination-heading">
        <h2 id="backup-destination-heading">バックアップ設定</h2>
        <p id="backup-destination-current" role="status" aria-live="polite">
          バックアップ先を読み込んでいます。
        </p>
        <button id="backup-destination-button" type="button">バックアップ先フォルダを選択</button>
        <p id="backup-destination-status" role="status" aria-live="polite"></p>
      </section>
      <section aria-labelledby="pdf-inspection-heading">
        <h2 id="pdf-inspection-heading">FANBOX PDF確認</h2>
        <p>
          <label for="pdf-inspection-file">PDFファイル</label>
          <input id="pdf-inspection-file" type="file" accept="application/pdf">
        </p>
        <button id="pdf-inspection-button" type="button">PDFを確認</button>
        <button id="pdf-import-button" type="button" disabled>このPDFを支援者状態に反映</button>
        <p id="pdf-inspection-status" role="status" aria-live="polite"></p>
        <div id="pdf-inspection-result" aria-live="polite"></div>
      </section>
      <section aria-labelledby="heading">
        <h2 id="heading">支援者一覧</h2>
        <p id="list-status" role="status">支援者一覧を読み込んでいます。</p>
        <ul id="list" aria-live="polite"></ul>
      </section>
      <section aria-labelledby="lottery-result-heading">
        <h2 id="lottery-result-heading">抽選結果登録</h2>
        <p>
          <label for="lottery-occurred-at">抽選実施日時（日本時間）</label>
          <input id="lottery-occurred-at" type="datetime-local" step="60">
        </p>
        <p id="lottery-result-status" role="status" aria-live="polite"></p>
        <p id="lottery-participant-status" role="status" aria-live="polite">
          抽選対象の支援者を読み込んでいます。
        </p>
        <ul id="lottery-participant-list" aria-live="polite"></ul>
        <button id="lottery-result-button" type="button" disabled>抽選結果を反映</button>
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
const PDF_IMPORT_BLOCKED_REASONS = new Set([
  "empty_relationships",
  "duplicate_relationship_id",
  "new_display_name_unavailable",
]);
const PDF_IMPORT_BLOCKED_MESSAGES = {
  empty_relationships: "支援者情報がないため、反映できません。",
  duplicate_relationship_id:
    "PDF内に重複した関係情報があるため、反映できません。",
  new_display_name_unavailable:
    "新規支援者の表示名を確認できないため、反映できません。",
};
const BACKUP_DESTINATION_KEYS = ["directory"];

function isValidBackupDestinationDirectory(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.startsWith("/") &&
    !value.includes("\\u0000")
  );
}

function validateBackupDestinationGetResponse(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, BACKUP_DESTINATION_KEYS) ||
    !(value.directory === null ||
      isValidBackupDestinationDirectory(value.directory))
  ) {
    throw new TypeError("invalid backup destination response");
  }

  return value.directory;
}

function validateBackupDestinationSelectResponse(value) {
  if (!isRecord(value)) {
    throw new TypeError("invalid backup destination selection response");
  }
  if (
    hasExactKeys(value, ["status"]) &&
    value.status === "cancelled"
  ) {
    return { status: "cancelled" };
  }
  if (
    hasExactKeys(value, ["status", "directory"]) &&
    value.status === "selected" &&
    isValidBackupDestinationDirectory(value.directory)
  ) {
    return { status: "selected", directory: value.directory };
  }

  throw new TypeError("invalid backup destination selection response");
}

const backupDestinationState = {
  active: false,
  loaded: false,
  directory: null,
};
let backupDestinationUi = null;

function renderBackupDestinationDirectory() {
  if (backupDestinationUi === null) {
    return;
  }

  if (!backupDestinationState.loaded) {
    backupDestinationUi.current.textContent = "バックアップ先を確認できません。";
    return;
  }
  backupDestinationUi.current.textContent =
    backupDestinationState.directory === null
      ? "バックアップ先が未設定です。"
      : "バックアップ先: " + backupDestinationState.directory;
}

function updateBackupDestinationButton() {
  if (backupDestinationUi !== null) {
    backupDestinationUi.button.disabled = backupDestinationState.active;
  }
}

async function loadBackupDestination() {
  if (backupDestinationUi === null) {
    return;
  }

  try {
    const response = await fetch("/api/backup-destination", {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (response.status !== 200) {
      throw new Error("backup destination request failed");
    }

    backupDestinationState.directory = validateBackupDestinationGetResponse(
      await response.json(),
    );
    backupDestinationState.loaded = true;
    renderBackupDestinationDirectory();
  } catch {
    backupDestinationState.loaded = false;
    renderBackupDestinationDirectory();
    backupDestinationUi.status.textContent =
      "バックアップ先を読み込めませんでした。";
  }
}

async function selectBackupDestination() {
  if (backupDestinationUi === null || backupDestinationState.active) {
    return;
  }

  backupDestinationState.active = true;
  updateBackupDestinationButton();
  backupDestinationUi.status.textContent =
    "バックアップ先フォルダを選択しています。";

  try {
    const response = await fetch("/api/backup-destination/select", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (response.status !== 200) {
      throw new Error("backup destination selection request failed");
    }

    const result = validateBackupDestinationSelectResponse(
      await response.json(),
    );
    if (result.status === "cancelled") {
      backupDestinationUi.status.textContent =
        "バックアップ先フォルダの選択をキャンセルしました。";
      return;
    }

    backupDestinationState.directory = result.directory;
    backupDestinationState.loaded = true;
    renderBackupDestinationDirectory();
    backupDestinationUi.status.textContent = "バックアップ先を変更しました。";
  } catch {
    backupDestinationUi.status.textContent =
      "バックアップ先を変更できませんでした。";
  } finally {
    backupDestinationState.active = false;
    updateBackupDestinationButton();
  }
}

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

function validatePdfImportResponse(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["importedAt", "presentSupporterCount"]) ||
    !isCanonicalTimestamp(value.importedAt) ||
    !isNonNegativeInteger(value.presentSupporterCount)
  ) {
    throw new TypeError("invalid PDF import response");
  }

  return {
    importedAt: value.importedAt,
    presentSupporterCount: value.presentSupporterCount,
  };
}

function validatePdfImportBlockedResponse(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["error", "reason"]) ||
    value.error !== "fanbox_import_blocked" ||
    typeof value.reason !== "string" ||
    !PDF_IMPORT_BLOCKED_REASONS.has(value.reason)
  ) {
    throw new TypeError("invalid PDF import blocked response");
  }

  return value.reason;
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

const lotteryState = {
  active: false,
  loaded: false,
  supporters: [],
  controls: [],
};
let lotteryUi = null;
const JAPAN_TIME_OFFSET_MILLISECONDS = 9 * 60 * 60 * 1000;
const LOTTERY_RESULT_OPTIONS = [
  { value: "none", label: "不参加" },
  { value: "win", label: "当選" },
  { value: "loss", label: "落選" },
];

function updateLotteryActionButtons() {
  if (lotteryUi === null) {
    return;
  }

  lotteryUi.occurredAtInput.disabled = lotteryState.active;
  for (const control of lotteryState.controls) {
    control.select.disabled = lotteryState.active;
  }
  lotteryUi.submitButton.disabled =
    lotteryState.active ||
    !lotteryState.loaded ||
    lotteryState.supporters.length === 0;
}

function setLotteryParticipantState(message) {
  if (lotteryUi === null) {
    return;
  }

  lotteryUi.participantStatus.textContent = message;
  lotteryUi.participantList.replaceChildren();
}

function renderLotteryParticipant(supporter) {
  const item = document.createElement("li");
  const name = document.createElement("h3");
  const level = document.createElement("p");
  const entries = document.createElement("p");
  const supportStatus = document.createElement("p");
  const resultLabel = document.createElement("label");
  const resultLabelText = document.createElement("span");
  const select = document.createElement("select");
  const options = LOTTERY_RESULT_OPTIONS.map(({ value, label }) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  });

  name.textContent = supporter.displayName;
  level.textContent = \`現在のレベル: Lv.\${supporter.currentLevel}\`;
  entries.textContent = \`次回抽選口数: \${supporter.nextLotteryEntryCount}口\`;
  supportStatus.textContent = supporter.supporting
    ? "現在の支援状態: 支援中"
    : "現在の支援状態: 支援停止";
  resultLabelText.textContent = "抽選結果";
  resultLabel.replaceChildren(resultLabelText, select);
  select.value = "none";
  select.replaceChildren(...options);
  select.value = "none";

  const control = { supporter, select };
  lotteryState.controls.push(control);
  item.replaceChildren(name, level, entries, supportStatus, resultLabel);
  return item;
}

function renderLotteryParticipants(supporters) {
  if (lotteryUi === null) {
    return;
  }

  lotteryState.controls = [];
  if (supporters.length === 0) {
    setLotteryParticipantState(
      "支援者がいないため、抽選結果を登録できません。",
    );
    updateLotteryActionButtons();
    return;
  }

  lotteryUi.participantStatus.textContent = "";
  lotteryUi.participantList.replaceChildren(
    ...supporters.map(renderLotteryParticipant),
  );
  updateLotteryActionButtons();
}

function prepareLotteryParticipantLoad() {
  lotteryState.loaded = false;
  lotteryState.supporters = [];
  lotteryState.controls = [];
  setLotteryParticipantState("抽選対象の支援者を読み込んでいます。");
  updateLotteryActionButtons();
}

function serializeJapanDateTime(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})$/.exec(value);
  if (match === null) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, 0, 0);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== 0 ||
    calendar.getUTCMilliseconds() !== 0
  ) {
    return null;
  }

  const occurredAt = new Date(
    calendar.getTime() - JAPAN_TIME_OFFSET_MILLISECONDS,
  );
  if (Number.isNaN(occurredAt.getTime())) {
    return null;
  }

  return occurredAt.toISOString();
}

function collectLotteryParticipants() {
  const participants = [];
  let winCount = 0;
  let lossCount = 0;

  for (const control of lotteryState.controls) {
    const outcome = control.select.value;
    if (outcome === "none") {
      continue;
    }
    if (outcome !== "win" && outcome !== "loss") {
      return null;
    }

    participants.push({
      supporterId: control.supporter.id,
      outcome,
    });
    if (outcome === "win") {
      winCount += 1;
    } else {
      lossCount += 1;
    }
  }

  return participants.length === 0
    ? null
    : { participants, winCount, lossCount };
}

function isExactLotterySuccess(value) {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["status"]) &&
    value.status === "ok"
  );
}

function isExactLotteryConflict(value) {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["error"]) &&
    value.error === "lottery_result_conflict"
  );
}

async function submitLotteryResults(listStatus, supporterList) {
  if (
    lotteryUi === null ||
    lotteryState.active ||
    !lotteryState.loaded ||
    lotteryState.supporters.length === 0
  ) {
    return;
  }

  const occurredAtInput = lotteryUi.occurredAtInput.value;
  const occurredAt = serializeJapanDateTime(occurredAtInput);
  const selected = collectLotteryParticipants();
  if (occurredAt === null || selected === null) {
    lotteryUi.resultStatus.textContent =
      "抽選実施日時と参加者を確認してください。";
    return;
  }

  if (
    !window.confirm(
      \`参加者\${selected.participants.length}人（当選\${selected.winCount}人、落選\${selected.lossCount}人）を、抽選実施日時（日本時間）\${occurredAtInput}として反映します。抽選結果を適用しますか？\`,
    )
  ) {
    return;
  }

  lotteryState.active = true;
  updateLotteryActionButtons();
  lotteryUi.resultStatus.textContent = "抽選結果を反映しています。";

  try {
    const response = await fetch("/api/lottery-results", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        participants: selected.participants,
        occurredAt,
      }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });

    let responseBody;
    try {
      responseBody = await response.json();
    } catch {
      throw new Error("invalid lottery result response");
    }

    if (response.status === 409) {
      if (!isExactLotteryConflict(responseBody)) {
        throw new Error("invalid lottery result conflict");
      }

      await loadSupporters(listStatus, supporterList);
      lotteryUi.resultStatus.textContent =
        "支援者状態または処理月が変わっています。参加者と時刻を確認してから再試行してください。";
      return;
    }

    if (response.status !== 200 || !isExactLotterySuccess(responseBody)) {
      throw new Error("lottery result request failed");
    }

    lotteryUi.occurredAtInput.value = "";
    await loadSupporters(listStatus, supporterList);
    lotteryUi.resultStatus.textContent = "抽選結果を反映しました。";
  } catch {
    lotteryUi.resultStatus.textContent =
      "抽選結果を反映できませんでした。入力内容を確認して再試行してください。";
  } finally {
    lotteryState.active = false;
    updateLotteryActionButtons();
  }
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

const PDF_RELATIONSHIP_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const PDF_PRESENT_SUPPORTER_STATUSES = new Set([
  "new",
  "continuing",
  "returning",
]);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isFiniteNumberTuple(value, length) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every(isFiniteNumber)
  );
}

function isPdfPresentSupporterStatus(value) {
  return typeof value === "string" && PDF_PRESENT_SUPPORTER_STATUSES.has(value);
}

function validateExistingSupporterMigrationResponse(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["status"]) ||
    value.status !== "ok"
  ) {
    throw new TypeError("invalid existing supporter migration response");
  }
}

function isExistingSupporterMigrationConflictResponse(value) {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["error"]) &&
    value.error === "supporter_already_registered"
  );
}

function validatePdfInspectionResponse(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["pageCount", "relationshipLinks", "comparison"])
  ) {
    throw new TypeError("invalid PDF inspection response");
  }
  if (
    !isNonNegativeInteger(value.pageCount) ||
    !Array.isArray(value.relationshipLinks) ||
    !isRecord(value.comparison) ||
    !hasExactKeys(value.comparison, ["presentSupporters", "absentSupporters"])
  ) {
    throw new TypeError("invalid PDF inspection response");
  }

  const relationshipLinks = value.relationshipLinks.map((relationship) => {
    if (
      !isRecord(relationship) ||
      !hasExactKeys(relationship, [
        "pageNumber",
        "relationshipId",
        "displayNameCandidate",
        "rect",
        "textRuns",
      ]) ||
      !isNonNegativeInteger(relationship.pageNumber) ||
      relationship.pageNumber < 1 ||
      relationship.pageNumber > value.pageCount ||
      typeof relationship.relationshipId !== "string" ||
      relationship.relationshipId.length === 0 ||
      !PDF_RELATIONSHIP_ID_PATTERN.test(relationship.relationshipId) ||
      (relationship.displayNameCandidate !== null &&
        typeof relationship.displayNameCandidate !== "string") ||
      !isFiniteNumberTuple(relationship.rect, 4) ||
      !Array.isArray(relationship.textRuns)
    ) {
      throw new TypeError("invalid PDF inspection relationship");
    }

    const textRuns = relationship.textRuns.map((textRun) => {
      if (
        !isRecord(textRun) ||
        !hasExactKeys(textRun, [
          "text",
          "transform",
          "width",
          "height",
          "hasEol",
        ]) ||
        typeof textRun.text !== "string" ||
        !isFiniteNumberTuple(textRun.transform, 6) ||
        !isFiniteNumber(textRun.width) ||
        !isFiniteNumber(textRun.height) ||
        typeof textRun.hasEol !== "boolean"
      ) {
        throw new TypeError("invalid PDF inspection text run");
      }

      return textRun;
    });

    return {
      pageNumber: relationship.pageNumber,
      relationshipId: relationship.relationshipId,
      displayNameCandidate: relationship.displayNameCandidate,
      rect: relationship.rect,
      textRuns,
    };
  });

  if (
    !Array.isArray(value.comparison.presentSupporters) ||
    !Array.isArray(value.comparison.absentSupporters) ||
    value.comparison.presentSupporters.length !== relationshipLinks.length
  ) {
    throw new TypeError("invalid PDF comparison");
  }

  const presentSupporters = value.comparison.presentSupporters.map(
    (supporter, index) => {
      const relationship = relationshipLinks[index];
      if (
        !isRecord(supporter) ||
        !hasExactKeys(supporter, [
          "status",
          "relationshipId",
          "storedDisplayName",
        ]) ||
        !isPdfPresentSupporterStatus(supporter.status) ||
        typeof supporter.relationshipId !== "string" ||
        relationship === undefined ||
        supporter.relationshipId !== relationship.relationshipId
      ) {
        throw new TypeError("invalid PDF comparison supporter");
      }

      if (
        supporter.status === "new" &&
        supporter.storedDisplayName !== null
      ) {
        throw new TypeError("invalid PDF comparison supporter");
      }
      if (
        (supporter.status === "continuing" ||
          supporter.status === "returning") &&
        !isNonBlankString(supporter.storedDisplayName)
      ) {
        throw new TypeError("invalid PDF comparison supporter");
      }

      return supporter;
    },
  );

  const absentSupporters = value.comparison.absentSupporters.map(
    (supporter) => {
      if (
        !isRecord(supporter) ||
        !hasExactKeys(supporter, [
          "status",
          "relationshipId",
          "storedDisplayName",
          "wasSupporting",
        ]) ||
        supporter.status !== "absent" ||
        typeof supporter.relationshipId !== "string" ||
        supporter.relationshipId.length === 0 ||
        !PDF_RELATIONSHIP_ID_PATTERN.test(supporter.relationshipId) ||
        !isNonBlankString(supporter.storedDisplayName) ||
        typeof supporter.wasSupporting !== "boolean"
      ) {
        throw new TypeError("invalid PDF absent supporter");
      }

      return supporter;
    },
  );

  return {
    pageCount: value.pageCount,
    relationshipLinks,
    comparison: {
      presentSupporters,
      absentSupporters,
    },
  };
}

function renderExistingSupporterMigrationControl(
  relationship,
  pdfControls,
) {
  const migration = document.createElement("div");
  const label = document.createElement("label");
  const levelInput = document.createElement("input");
  const button = document.createElement("button");
  const status = document.createElement("p");
  const eligible = isNonBlankString(relationship.displayNameCandidate);
  const control = {
    button,
    levelInput,
    eligible,
    inFlight: false,
    succeeded: false,
  };

  label.textContent = "旧管理レベル";
  levelInput.type = "number";
  levelInput.min = "0";
  levelInput.step = "1";
  levelInput.value = "";
  button.type = "button";
  button.textContent = "旧管理レベルで登録";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  if (!eligible) {
    status.textContent =
      "表示名候補が必要なため、旧管理レベルで登録できません。";
  }

  pdfControls.state.migrationControls.push(control);
  button.addEventListener("click", () => {
    void migrateExistingSupporter(
      relationship,
      levelInput,
      status,
      control,
      pdfControls,
    );
  });
  migration.replaceChildren(label, levelInput, button, status);
  return migration;
}

function renderPdfInspectionRelationship(
  relationship,
  comparison,
  index,
  pdfControls,
) {
  const item = document.createElement("section");
  const heading = document.createElement("h3");
  const page = document.createElement("p");
  const classification = document.createElement("p");
  const storedName = document.createElement("p");
  const runs = document.createElement("ul");
  const runItems = [];

  heading.textContent = \`関係リンク \${index + 1}: \${relationship.relationshipId}\`;
  page.textContent = \`ページ: \${relationship.pageNumber}\`;
  classification.textContent =
    comparison.status === "new"
      ? "分類: 新規"
      : comparison.status === "continuing"
        ? "分類: 継続"
        : "分類: 復帰";
  storedName.textContent =
    comparison.status === "new"
      ? "登録名: なし"
      : \`登録名: \${comparison.storedDisplayName}\`;
  const displayName = document.createElement("p");
  displayName.textContent =
    relationship.displayNameCandidate === null
      ? "表示名候補を確定できません。"
      : \`表示名候補: \${relationship.displayNameCandidate}\`;
  const migrationControl =
    comparison.status === "new"
      ? renderExistingSupporterMigrationControl(relationship, pdfControls)
      : null;

  if (relationship.textRuns.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "重なるテキストはありません。";
    if (migrationControl === null) {
      item.replaceChildren(heading, page, classification, storedName, displayName, empty);
    } else {
      item.replaceChildren(
        heading,
        page,
        classification,
        storedName,
        displayName,
        empty,
        migrationControl,
      );
    }
    return item;
  }

  for (const textRun of relationship.textRuns) {
    const run = document.createElement("li");
    run.className = "pdf-inspection-text";
    run.textContent = textRun.text;
    runItems.push(run);
  }

  runs.replaceChildren(...runItems);
  if (migrationControl === null) {
    item.replaceChildren(heading, page, classification, storedName, displayName, runs);
  } else {
    item.replaceChildren(
      heading,
      page,
      classification,
      storedName,
      displayName,
      runs,
      migrationControl,
    );
  }
  return item;
}

function renderPdfAbsentSupporters(absentSupporters) {
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  heading.textContent = "PDFにいないローカル支援者";

  if (absentSupporters.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "PDFにいないローカル支援者はいません。";
    section.replaceChildren(heading, empty);
    return section;
  }

  const list = document.createElement("ul");
  const items = absentSupporters.map((supporter) => {
    const item = document.createElement("li");
    const storedName = document.createElement("p");
    const relationshipId = document.createElement("p");
    const supportState = document.createElement("p");

    storedName.textContent = \`登録名: \${supporter.storedDisplayName}\`;
    relationshipId.textContent = \`関係ID: \${supporter.relationshipId}\`;
    supportState.textContent = supporter.wasSupporting
      ? "直前の支援状態: 支援中"
      : "直前の支援状態: 非支援";
    item.replaceChildren(storedName, relationshipId, supportState);
    return item;
  });

  list.replaceChildren(...items);
  section.replaceChildren(heading, list);
  return section;
}

function showPdfInspectionResult(status, result, inspection, pdfControls) {
  const counts = {
    new: 0,
    continuing: 0,
    returning: 0,
  };
  for (const supporter of inspection.comparison.presentSupporters) {
    counts[supporter.status] += 1;
  }
  status.textContent =
    \`ページ数: \${inspection.pageCount}、関係リンク数: \${inspection.relationshipLinks.length}、新規: \${counts.new}、継続: \${counts.continuing}、復帰: \${counts.returning}、PDFにいない: \${inspection.comparison.absentSupporters.length}\`;

  const relationshipEvidence = [];
  if (inspection.relationshipLinks.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "関係リンクはありません。";
    relationshipEvidence.push(empty);
  } else {
    pdfControls.state.migrationControls = [];
    relationshipEvidence.push(
      ...inspection.relationshipLinks.map((relationship, index) =>
        renderPdfInspectionRelationship(
          relationship,
          inspection.comparison.presentSupporters[index],
          index,
          pdfControls,
        ),
      ),
    );
  }

  result.replaceChildren(
    ...relationshipEvidence,
    renderPdfAbsentSupporters(inspection.comparison.absentSupporters),
  );
}

function updatePdfActionButtons(fileInput, inspectionButton, importButton, state) {
  fileInput.disabled = state.actionActive;
  inspectionButton.disabled = state.actionActive;
  importButton.disabled =
    state.actionActive ||
    state.previewedFile === null ||
    state.previewedFile !== state.selectedFile;
  for (const control of state.migrationControls) {
    control.button.disabled =
      state.actionActive ||
      control.inFlight ||
      control.succeeded ||
      !control.eligible;
    control.levelInput.disabled =
      state.actionActive || control.inFlight || control.succeeded;
  }
}

function parseExistingSupporterMigrationLevel(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const level = Number(value);
  return isNonNegativeInteger(level) ? level : null;
}

async function migrateExistingSupporter(
  relationship,
  levelInput,
  status,
  control,
  pdfControls,
) {
  const { state, fileInput, inspectionButton, importButton, listStatus, supporterList } =
    pdfControls;
  if (
    state.actionActive ||
    control.inFlight ||
    control.succeeded ||
    !control.eligible
  ) {
    return;
  }

  const currentLevel = parseExistingSupporterMigrationLevel(levelInput.value);
  if (currentLevel === null) {
    status.textContent =
      "旧管理レベルは0以上の整数を入力してください。";
    return;
  }

  if (!isNonBlankString(relationship.displayNameCandidate)) {
    status.textContent =
      "表示名候補が必要なため、旧管理レベルで登録できません。";
    control.eligible = false;
    updatePdfActionButtons(
      fileInput,
      inspectionButton,
      importButton,
      state,
    );
    return;
  }

  if (
    !window.confirm(
      \`表示されている支援者「\${relationship.displayNameCandidate}」を、入力した旧管理用抽選レベル \${currentLevel} で登録します。続行しますか？\`,
    )
  ) {
    return;
  }

  state.actionActive = true;
  control.inFlight = true;
  updatePdfActionButtons(
    fileInput,
    inspectionButton,
    importButton,
    state,
  );
  status.textContent = "旧管理レベルで登録しています。";

  try {
    const response = await fetch("/api/supporters/migrate-existing", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fanboxRelationshipId: relationship.relationshipId,
        displayName: relationship.displayNameCandidate,
        currentLevel,
      }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    let responseBody;
    try {
      responseBody = await response.json();
    } catch {
      throw new Error("invalid existing supporter migration response");
    }

    if (response.status === 409) {
      if (isExistingSupporterMigrationConflictResponse(responseBody)) {
        status.textContent =
          "すでに登録済みの可能性があります。一覧を確認してから再試行してください。";
        return;
      }
      throw new Error("invalid existing supporter migration conflict");
    }
    if (!response.ok) {
      throw new Error("existing supporter migration request failed");
    }

    validateExistingSupporterMigrationResponse(responseBody);
    control.succeeded = true;
    status.textContent =
      "旧管理レベルで登録しました。反映時に現在のローカル状態で再判定されます。";
    if (listStatus !== null && supporterList !== null) {
      await loadSupporters(listStatus, supporterList);
    }
  } catch {
    status.textContent = "旧管理レベルで登録できませんでした。";
  } finally {
    control.inFlight = false;
    state.actionActive = false;
    updatePdfActionButtons(
      fileInput,
      inspectionButton,
      importButton,
      state,
    );
  }
}

function invalidatePdfPreview(
  fileInput,
  inspectionButton,
  importButton,
  status,
  result,
  state,
) {
  state.selectedFile = fileInput.files?.[0] ?? null;
  state.previewedFile = null;
  state.migrationControls = [];
  result.replaceChildren();
  status.textContent =
    state.selectedFile === null ? "" : "PDFを確認してください。";
  updatePdfActionButtons(
    fileInput,
    inspectionButton,
    importButton,
    state,
  );
}

async function inspectSelectedPdf(
  fileInput,
  inspectionButton,
  importButton,
  status,
  result,
  state,
  listStatus,
  supporterList,
) {
  if (state.actionActive) {
    return;
  }

  const file = fileInput.files?.[0];
  if (file === undefined) {
    invalidatePdfPreview(
      fileInput,
      inspectionButton,
      importButton,
      status,
      result,
      state,
    );
    status.textContent = "確認するPDFファイルを選択してください。";
    return;
  }

  state.selectedFile = file;
  state.previewedFile = null;
  state.migrationControls = [];
  state.actionActive = true;
  updatePdfActionButtons(
    fileInput,
    inspectionButton,
    importButton,
    state,
  );
  status.textContent = "PDFを確認しています。";
  result.replaceChildren();

  try {
    const response = await fetch("/api/fanbox-pdf/inspect", {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
      },
      body: file,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      throw new Error("PDF inspection request failed");
    }

    const inspection = validatePdfInspectionResponse(await response.json());
    if (state.selectedFile !== file || fileInput.files?.[0] !== file) {
      throw new Error("PDF selection changed during inspection");
    }

    showPdfInspectionResult(status, result, inspection, {
      fileInput,
      inspectionButton,
      importButton,
      state,
      listStatus,
      supporterList,
    });
    state.previewedFile = file;
  } catch {
    state.previewedFile = null;
    status.textContent = "PDFを確認できませんでした。";
    result.replaceChildren();
  } finally {
    state.actionActive = false;
    updatePdfActionButtons(
      fileInput,
      inspectionButton,
      importButton,
      state,
    );
  }
}

async function importSelectedPdf(
  fileInput,
  inspectionButton,
  importButton,
  status,
  result,
  state,
  listStatus,
  supporterList,
) {
  if (
    state.actionActive ||
    state.previewedFile === null ||
    state.previewedFile !== state.selectedFile
  ) {
    return;
  }

  const file = state.previewedFile;
  if (fileInput.files?.[0] !== file) {
    invalidatePdfPreview(
      fileInput,
      inspectionButton,
      importButton,
      status,
      result,
      state,
    );
    return;
  }

  state.actionActive = true;
  updatePdfActionButtons(
    fileInput,
    inspectionButton,
    importButton,
    state,
  );
  status.textContent = "支援者状態を反映しています。";

  try {
    const response = await fetch("/api/fanbox-pdf/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
      },
      body: file,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (response.status === 422) {
      const reason = validatePdfImportBlockedResponse(await response.json());
      status.textContent = PDF_IMPORT_BLOCKED_MESSAGES[reason];
      return;
    }
    if (!response.ok) {
      throw new Error("PDF import request failed");
    }

    const importResult = validatePdfImportResponse(await response.json());
    state.previewedFile = null;
    state.migrationControls = [];
    result.replaceChildren();
    status.textContent =
      \`支援者状態を反映しました。支援者数: \${importResult.presentSupporterCount}人、取込日時: \${importResult.importedAt}\`;
    updatePdfActionButtons(
      fileInput,
      inspectionButton,
      importButton,
      state,
    );
    if (listStatus !== null && supporterList !== null) {
      await loadSupporters(listStatus, supporterList);
    }
  } catch {
    status.textContent = "支援者状態を反映できませんでした。";
  } finally {
    state.actionActive = false;
    updatePdfActionButtons(
      fileInput,
      inspectionButton,
      importButton,
      state,
    );
  }
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
  prepareLotteryParticipantLoad();

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
    lotteryState.supporters = supporters;
    lotteryState.loaded = true;
    renderLotteryParticipants(supporters);
    if (supporters.length === 0) {
      showListState(status, list, "支援者はいません。");
      return;
    }

    status.textContent = "";
    list.replaceChildren(...supporters.map(renderSupporter));
  } catch {
    showListState(status, list, "支援者一覧を読み込めませんでした。");
    setLotteryParticipantState(
      "抽選結果登録を利用できません。支援者一覧を読み込めませんでした。",
    );
  }
}

document.documentElement.dataset.adminReady = "true";
const pdfInspectionFile = document.getElementById("pdf-inspection-file");
const pdfInspectionButton = document.getElementById("pdf-inspection-button");
const pdfImportButton = document.getElementById("pdf-import-button");
const pdfInspectionStatus = document.getElementById("pdf-inspection-status");
const pdfInspectionResult = document.getElementById("pdf-inspection-result");
const listStatus = document.getElementById("list-status");
const supporterList = document.getElementById("list");
const lotteryOccurredAtInput = document.getElementById("lottery-occurred-at");
const lotteryResultStatus = document.getElementById("lottery-result-status");
const lotteryParticipantStatus = document.getElementById(
  "lottery-participant-status",
);
const lotteryParticipantList = document.getElementById(
  "lottery-participant-list",
);
const lotteryResultButton = document.getElementById("lottery-result-button");
const backupDestinationCurrent = document.getElementById(
  "backup-destination-current",
);
const backupDestinationButton = document.getElementById(
  "backup-destination-button",
);
const backupDestinationStatus = document.getElementById(
  "backup-destination-status",
);
if (
  backupDestinationCurrent !== null &&
  backupDestinationButton instanceof HTMLButtonElement &&
  backupDestinationStatus !== null
) {
  backupDestinationUi = {
    current: backupDestinationCurrent,
    button: backupDestinationButton,
    status: backupDestinationStatus,
  };
  backupDestinationButton.addEventListener("click", () => {
    void selectBackupDestination();
  });
  updateBackupDestinationButton();
  void loadBackupDestination();
}
if (
  lotteryOccurredAtInput !== null &&
  lotteryResultStatus !== null &&
  lotteryParticipantStatus !== null &&
  lotteryParticipantList !== null &&
  lotteryResultButton !== null
) {
  lotteryUi = {
    occurredAtInput: lotteryOccurredAtInput,
    resultStatus: lotteryResultStatus,
    participantStatus: lotteryParticipantStatus,
    participantList: lotteryParticipantList,
    submitButton: lotteryResultButton,
  };
  lotteryResultButton.addEventListener("click", () => {
    void submitLotteryResults(listStatus, supporterList);
  });
  updateLotteryActionButtons();
}
if (
  pdfInspectionFile instanceof HTMLInputElement &&
  pdfInspectionButton instanceof HTMLButtonElement &&
  pdfImportButton instanceof HTMLButtonElement &&
  pdfInspectionStatus !== null &&
  pdfInspectionResult !== null
) {
  const pdfState = {
    actionActive: false,
    selectedFile: pdfInspectionFile.files?.[0] ?? null,
    previewedFile: null,
    migrationControls: [],
  };
  pdfInspectionFile.addEventListener("change", () => {
    invalidatePdfPreview(
      pdfInspectionFile,
      pdfInspectionButton,
      pdfImportButton,
      pdfInspectionStatus,
      pdfInspectionResult,
      pdfState,
    );
  });
  pdfInspectionButton.addEventListener("click", () => {
    void inspectSelectedPdf(
      pdfInspectionFile,
      pdfInspectionButton,
      pdfImportButton,
      pdfInspectionStatus,
      pdfInspectionResult,
      pdfState,
      listStatus,
      supporterList,
    );
  });
  pdfImportButton.addEventListener("click", () => {
    void importSelectedPdf(
      pdfInspectionFile,
      pdfInspectionButton,
      pdfImportButton,
      pdfInspectionStatus,
      pdfInspectionResult,
      pdfState,
      listStatus,
      supporterList,
    );
  });
  updatePdfActionButtons(
    pdfInspectionFile,
    pdfInspectionButton,
    pdfImportButton,
    pdfState,
  );
}

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

#lottery-participant-status,
#lottery-result-status {
  min-height: 1.5rem;
}

#lottery-participant-list {
  display: grid;
  gap: 0.75rem;
  margin: 1rem 0 0;
  padding: 0;
  list-style: none;
}

#lottery-participant-list li {
  padding: 1rem 1.25rem;
  border: 1px solid #cfd4dc;
  border-radius: 0.5rem;
  background: #ffffff;
}

#lottery-participant-list h3,
#lottery-participant-list p {
  margin: 0;
}

#lottery-participant-list p + p {
  margin-top: 0.35rem;
}

#lottery-participant-list label {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-top: 0.75rem;
}

#lottery-result-button {
  margin-top: 1rem;
}

#pdf-inspection-button {
  margin-top: 0.25rem;
}

#pdf-import-button {
  margin-top: 0.25rem;
}

#pdf-inspection-status {
  min-height: 1.5rem;
}

#pdf-inspection-result {
  display: grid;
  gap: 0.75rem;
  margin-top: 1rem;
}

#pdf-inspection-result section {
  margin-top: 0;
  padding: 1rem 1.25rem;
  border: 1px solid #cfd4dc;
  border-radius: 0.5rem;
  background: #ffffff;
}

#pdf-inspection-result h3,
#pdf-inspection-result p {
  margin: 0;
}

#pdf-inspection-result ul {
  margin: 0.75rem 0 0;
  padding-left: 1.5rem;
}

.pdf-inspection-text {
  white-space: pre-wrap;
}
`;
