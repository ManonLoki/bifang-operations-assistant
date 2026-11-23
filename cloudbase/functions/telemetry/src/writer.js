"use strict";

const {
  createCloudStorageClient,
  createDailySeenCache,
} = require("./storage-client");

const COLLECTION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;
const STORAGE_BACKEND_STORAGE = "storage";
const STORAGE_BACKEND_DATABASE = "database";

/**
 * 创建生产环境遥测写入器：
 * - 默认优先走 CloudBase 云存储（按应用与北京日期分文件 + 热实例内存去重），避免触发 PostgreSQL 5 分钟 CU 计费；
 * - 可通过 STORAGE_BACKEND=database 回退到原数据库集合写入。
 */
function createCloudBaseWriter(options = {}) {
  const collectionName = normalizeCollectionName(
    options.collectionName === undefined
      ? process.env.TELEMETRY_COLLECTION
      : options.collectionName,
  );
  const configuredBackend = normalizeStorageBackend(
    options.storageBackend === undefined
      ? process.env.STORAGE_BACKEND
      : options.storageBackend,
  );
  const appFactory = options.appFactory || createDefaultCloudBaseApp;
  const storageClient =
    options.storageClient ||
    createCloudStorageClient({
      fetch: options.fetch,
      storagePrefix: options.storagePrefix,
    });
  const seenCache = options.seenCache || createDailySeenCache();
  let appPromise;
  let collection;

  async function getApp() {
    if (!appPromise) {
      appPromise = Promise.resolve(appFactory());
    }
    return appPromise;
  }

  return async function writeEvent(document) {
    if (
      !document ||
      typeof document !== "object" ||
      typeof document._id !== "string" ||
      document._id.length === 0
    ) {
      throw new TypeError("document._id is required");
    }
    if (collectionName === null) {
      throw new Error("telemetry_collection_not_configured");
    }

    const activeDate =
      typeof document.active_date === "string" && document.active_date
        ? document.active_date
        : null;
    if (
      configuredBackend !== STORAGE_BACKEND_DATABASE &&
      activeDate &&
      seenCache.has(activeDate, document._id)
    ) {
      return { duplicate: true, cached: true };
    }

    const app = await getApp();
    const useStorage = shouldUseStorageBackend(configuredBackend, app);

    if (useStorage) {
      return writeEventToStorage({
        app,
        collectionName,
        document,
        seenCache,
        storageClient,
      });
    }

    if (!collection) {
      collection = app.database().collection(collectionName);
    }

    try {
      await collection.add({ ...document });
      return { duplicate: false };
    } catch (error) {
      if (isDuplicateWriteError(error)) {
        return { duplicate: true };
      }
      throw error;
    }
  };
}

async function writeEventToStorage({
  app,
  collectionName,
  document,
  seenCache,
  storageClient,
}) {
  const appId =
    typeof document.app_id === "string" && document.app_id
      ? document.app_id
      : collectionName.replace(/^telemetry_/, "").replaceAll("_", "-");
  const activeDate = document.active_date;
  if (
    typeof activeDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(activeDate)
  ) {
    throw new TypeError("document.active_date must be YYYY-MM-DD");
  }

  const cloudPath = telemetryDailyCloudPath(appId, activeDate);
  const existing = await storageClient.readJson(app, cloudPath);
  const events =
    existing &&
    typeof existing === "object" &&
    existing.events &&
    typeof existing.events === "object" &&
    !Array.isArray(existing.events)
      ? { ...existing.events }
      : {};

  if (Object.hasOwn(events, document._id)) {
    seenCache.add(activeDate, document._id);
    return { duplicate: true };
  }

  events[document._id] = serializeTelemetryDocument(document);
  await storageClient.writeJson(app, cloudPath, {
    schema_version: 1,
    app_id: appId,
    active_date: activeDate,
    updated_at: document.received_at || new Date().toISOString(),
    events,
  });
  seenCache.add(activeDate, document._id);
  return { duplicate: false };
}

function telemetryDailyCloudPath(appId, activeDate) {
  return `telemetry/${appId}/${activeDate}.json`;
}

function serializeTelemetryDocument(document) {
  return {
    ...document,
    expires_at:
      document.expires_at instanceof Date
        ? document.expires_at.toISOString()
        : document.expires_at,
  };
}

function normalizeStorageBackend(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === STORAGE_BACKEND_STORAGE ||
    normalized === STORAGE_BACKEND_DATABASE
  ) {
    return normalized;
  }
  return null;
}

function shouldUseStorageBackend(configuredBackend, app) {
  if (configuredBackend === STORAGE_BACKEND_DATABASE) return false;
  if (configuredBackend === STORAGE_BACKEND_STORAGE) return true;
  return Boolean(
    app &&
    typeof app.uploadFile === "function" &&
    typeof app.getTempFileURL === "function",
  );
}

function normalizeCollectionName(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !COLLECTION_NAME_PATTERN.test(value)) {
    throw new TypeError(
      "TELEMETRY_COLLECTION must be 1-60 lowercase letters, digits, or underscores and start with a letter",
    );
  }
  return value;
}

function createDefaultCloudBaseApp(options = {}) {
  // CommonJS is intentional: normal CloudBase Event functions use a CommonJS
  // entrypoint. @cloudbase/js-sdk selects its built-in Node adapter through the
  // package's conditional export. Current-environment auth is supplied by the
  // function runtime; no public-client secret or API key is accepted here.
  const cloudbaseModule =
    options.cloudbaseModule || require("@cloudbase/js-sdk");
  const cloudbase = cloudbaseModule.default || cloudbaseModule;
  const configuredEnv =
    options.envOverride === undefined
      ? process.env.CLOUDBASE_ENV_ID
      : options.envOverride;

  // In an Event function the Node adapter resolves SYMBOL_CURRENT_ENV from the
  // runtime's TCB_ENV/SCF_NAMESPACE values. Local processes without those
  // runtime variables cannot exercise this path faithfully.
  const hasConfiguredEnv =
    typeof configuredEnv === "string" && configuredEnv.trim().length > 0;
  const currentEnv =
    cloudbase.SYMBOL_CURRENT_ENV || cloudbaseModule.SYMBOL_CURRENT_ENV;
  if (!hasConfiguredEnv && !currentEnv) {
    throw new Error("cloudbase_environment_unavailable");
  }
  const initOptions = {
    env: hasConfiguredEnv ? configuredEnv.trim() : currentEnv,
  };
  return cloudbase.init(initOptions);
}

function isDuplicateWriteError(error) {
  if (!error || typeof error !== "object") return false;
  const candidates = [error.code, error.errCode, error.errorCode, error.message]
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" ");
  return /(?:^|\D)11000(?:\D|$)|duplicate\s+(?:key|document)|already\s+exists/i.test(
    candidates,
  );
}

module.exports = {
  COLLECTION_NAME_PATTERN,
  STORAGE_BACKEND_DATABASE,
  STORAGE_BACKEND_STORAGE,
  createCloudBaseWriter,
  createDefaultCloudBaseApp,
  isDuplicateWriteError,
  normalizeCollectionName,
  normalizeStorageBackend,
  telemetryDailyCloudPath,
};
