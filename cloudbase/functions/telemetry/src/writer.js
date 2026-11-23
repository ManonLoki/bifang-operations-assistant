"use strict";

const { createHash } = require("node:crypto");

const {
  createCloudStorageClient,
  createDailySeenCache,
} = require("./storage-client");

const COLLECTION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;
const STORAGE_BACKEND_STORAGE = "storage";
const STORAGE_BACKEND_DATABASE = "database";
const DEFAULT_STORAGE_SHARDS = 16;
const MAX_STORAGE_SHARDS = 64;

/**
 * 创建生产环境遥测写入器：
 * - 默认优先走 CloudBase 云存储（按应用 + 北京日期 + 哈希分片写入，配合同实例分片批合并与内存并集兜底），
 *   避免触发 PostgreSQL 5 分钟 CU 计费并大幅降低高并发覆写风险；
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
  const shardCount = normalizeShardCount(
    options.shardCount === undefined
      ? process.env.TELEMETRY_STORAGE_SHARDS
      : options.shardCount,
  );
  const appFactory = options.appFactory || createDefaultCloudBaseApp;
  const storageClient =
    options.storageClient ||
    createCloudStorageClient({
      fetch: options.fetch,
      retryAttempts: options.retryAttempts,
      retryBaseDelayMs: options.retryBaseDelayMs,
      sleep: options.sleep,
      storagePrefix: options.storagePrefix,
    });
  const seenCache = options.seenCache || createDailySeenCache();
  const shardQueues = new Map();
  const manifestWrittenKeys = new Set();
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
      return enqueueShardWrite({
        app,
        collectionName,
        document,
        manifestWrittenKeys,
        seenCache,
        shardCount,
        shardQueues,
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

function enqueueShardWrite({
  app,
  collectionName,
  document,
  manifestWrittenKeys,
  seenCache,
  shardCount,
  shardQueues,
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

  const shardIndex = selectTelemetryShard(document._id, shardCount);
  const shardPath = telemetryShardCloudPath(appId, activeDate, shardIndex);

  return new Promise((resolve, reject) => {
    let state = shardQueues.get(shardPath);
    if (!state) {
      state = { running: false, pending: [] };
      shardQueues.set(shardPath, state);
    }
    state.pending.push({ document, resolve, reject });
    if (!state.running) {
      state.running = true;
      void drainShardQueue({
        app,
        appId,
        activeDate,
        manifestWrittenKeys,
        seenCache,
        shardCount,
        shardIndex,
        shardPath,
        shardQueues,
        state,
        storageClient,
      });
    }
  });
}

async function drainShardQueue({
  app,
  appId,
  activeDate,
  manifestWrittenKeys,
  seenCache,
  shardCount,
  shardIndex,
  shardPath,
  shardQueues,
  state,
  storageClient,
}) {
  try {
    while (state.pending.length > 0) {
      const batch = state.pending.splice(0, state.pending.length);
      try {
        const results = await flushShardBatch({
          app,
          appId,
          activeDate,
          batch,
          manifestWrittenKeys,
          seenCache,
          shardCount,
          shardIndex,
          shardPath,
          storageClient,
        });
        for (let index = 0; index < batch.length; index += 1) {
          batch[index].resolve(results[index]);
        }
      } catch (error) {
        for (const item of batch) {
          item.reject(error);
        }
      }
    }
  } finally {
    state.running = false;
    if (state.pending.length === 0) {
      shardQueues.delete(shardPath);
    }
  }
}

async function flushShardBatch({
  app,
  appId,
  activeDate,
  batch,
  manifestWrittenKeys,
  seenCache,
  shardCount,
  shardIndex,
  shardPath,
  storageClient,
}) {
  const results = new Array(batch.length);
  const toCheck = [];

  for (let index = 0; index < batch.length; index += 1) {
    const doc = batch[index].document;
    if (seenCache.has(activeDate, doc._id)) {
      results[index] = { duplicate: true, cached: true };
    } else {
      toCheck.push({ index, doc });
    }
  }

  if (toCheck.length === 0) {
    return results;
  }

  const existing = await storageClient.readJson(app, shardPath);
  const remoteEvents =
    existing &&
    typeof existing === "object" &&
    existing.events &&
    typeof existing.events === "object" &&
    !Array.isArray(existing.events)
      ? existing.events
      : {};

  // 合并本实例该分片已写入事件，跨实例偶发覆盖时可在下次写入自动自愈。
  const localShardEvents =
    typeof seenCache.getShardEvents === "function"
      ? seenCache.getShardEvents(activeDate, shardIndex, (id) =>
          selectTelemetryShard(id, shardCount),
        )
      : {};
  const mergedEvents = { ...localShardEvents, ...remoteEvents };

  let needsUpload = false;
  let latestReceivedAt = null;
  const newlyAdded = [];

  for (const [id, localEvent] of Object.entries(localShardEvents)) {
    if (!Object.hasOwn(remoteEvents, id)) {
      mergedEvents[id] = localEvent;
      needsUpload = true;
    }
  }

  for (const { index, doc } of toCheck) {
    if (Object.hasOwn(mergedEvents, doc._id)) {
      seenCache.add(activeDate, doc._id, mergedEvents[doc._id]);
      results[index] = { duplicate: true };
      continue;
    }
    const serialized = serializeTelemetryDocument(doc);
    mergedEvents[doc._id] = serialized;
    newlyAdded.push({ id: doc._id, serialized });
    if (
      typeof doc.received_at === "string" &&
      (!latestReceivedAt || doc.received_at > latestReceivedAt)
    ) {
      latestReceivedAt = doc.received_at;
    }
    needsUpload = true;
    results[index] = { duplicate: false };
  }

  if (needsUpload) {
    await storageClient.writeJson(app, shardPath, {
      schema_version: 2,
      app_id: appId,
      active_date: activeDate,
      shard: shardIndex,
      shard_count: shardCount,
      updated_at: latestReceivedAt || new Date().toISOString(),
      events: mergedEvents,
    });
    await ensureDailyManifest({
      app,
      appId,
      activeDate,
      manifestWrittenKeys,
      shardCount,
      storageClient,
    });
  }

  for (const item of newlyAdded) {
    seenCache.add(activeDate, item.id, item.serialized);
  }

  return results;
}

async function ensureDailyManifest({
  app,
  appId,
  activeDate,
  manifestWrittenKeys,
  shardCount,
  storageClient,
}) {
  const key = `${appId}\u0000${activeDate}\u0000${shardCount}`;
  if (manifestWrittenKeys.has(key)) {
    return;
  }
  const manifestPath = telemetryManifestCloudPath(appId, activeDate);
  await storageClient.writeJson(app, manifestPath, {
    schema_version: 2,
    app_id: appId,
    active_date: activeDate,
    shard_count: shardCount,
  });
  manifestWrittenKeys.add(key);
  if (manifestWrittenKeys.size > 8) {
    const oldestKey = manifestWrittenKeys.values().next().value;
    manifestWrittenKeys.delete(oldestKey);
  }
}

function selectTelemetryShard(documentId, shardCount = DEFAULT_STORAGE_SHARDS) {
  if (shardCount <= 1) return 0;
  const digest = createHash("sha256")
    .update(String(documentId), "utf8")
    .digest();
  return digest.readUInt32BE(0) % shardCount;
}

function telemetryDailyCloudPath(appId, activeDate) {
  return `telemetry/${appId}/${activeDate}.json`;
}

function telemetryManifestCloudPath(appId, activeDate) {
  return `telemetry/${appId}/${activeDate}/manifest.json`;
}

function telemetryShardCloudPath(appId, activeDate, shardIndex) {
  return `telemetry/${appId}/${activeDate}/shard-${String(shardIndex).padStart(2, "0")}.json`;
}

function normalizeShardCount(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_STORAGE_SHARDS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_STORAGE_SHARDS) {
    return DEFAULT_STORAGE_SHARDS;
  }
  return parsed;
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
  DEFAULT_STORAGE_SHARDS,
  MAX_STORAGE_SHARDS,
  STORAGE_BACKEND_DATABASE,
  STORAGE_BACKEND_STORAGE,
  createCloudBaseWriter,
  createDefaultCloudBaseApp,
  isDuplicateWriteError,
  normalizeCollectionName,
  normalizeShardCount,
  normalizeStorageBackend,
  selectTelemetryShard,
  telemetryDailyCloudPath,
  telemetryManifestCloudPath,
  telemetryShardCloudPath,
};
