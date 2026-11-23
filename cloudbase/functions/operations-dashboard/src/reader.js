"use strict";

const { createDatabaseError } = require("./diagnostics");
const {
  createCloudStorageReader,
  enumerateDateRange,
} = require("./storage-client");

const PAGE_SIZE = 100;
const MAX_PAGES_PER_COLLECTION = 100;
const STORAGE_BACKEND_STORAGE = "storage";
const STORAGE_BACKEND_DATABASE = "database";
const HISTORICAL_DAY_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_STORAGE_SHARDS = 16;
const MAX_STORAGE_SHARDS = 64;

function createCloudBaseEventReader(options = {}) {
  const appFactory = options.appFactory || createDefaultCloudBaseApp;
  const configuredBackend = normalizeStorageBackend(
    options.storageBackend === undefined
      ? process.env.STORAGE_BACKEND
      : options.storageBackend,
  );
  const storageReader =
    options.storageReader ||
    createCloudStorageReader({
      concurrency: options.concurrency,
      fetch: options.fetch,
      storagePrefix: options.storagePrefix,
    });
  const historicalCache = options.historicalCache || new Map();
  const historicalCacheTtlMs =
    Number.isFinite(options.historicalCacheTtlMs) &&
    options.historicalCacheTtlMs >= 0
      ? options.historicalCacheTtlMs
      : HISTORICAL_DAY_CACHE_TTL_MS;
  const nowMs = options.nowMs || (() => Date.now());

  return async function readEvents({
    apps,
    startDate,
    endDate,
    receivedBefore,
    runtimeContext,
  }) {
    // Context credentials are short-lived and may change between invocations.
    // Never retain one invocation's context-backed SDK instance for the next.
    const app = await appFactory({ runtimeContext });
    if (shouldUseStorageBackend(configuredBackend, app)) {
      return readEventsFromStorage({
        app,
        apps,
        endDate,
        historicalCache,
        historicalCacheTtlMs,
        nowMs,
        receivedBefore,
        startDate,
        storageReader,
      });
    }

    const database = app.database();
    const command = database.command;
    const allEvents = [];

    for (const app of apps) {
      const collection = database.collection(app.collectionName);
      let cursor;
      for (let page = 0; page < MAX_PAGES_PER_COLLECTION; page += 1) {
        const condition = {
          app_id: app.appId,
          schema_version: 2,
          event: "daily_active",
          active_date: command.gte(startDate).and(command.lte(endDate)),
          received_at: command.lte(receivedBefore),
          ...(cursor ? { _id: command.gt(cursor) } : {}),
        };
        const result = await collection
          .where(condition)
          .orderBy("_id", "asc")
          .field({
            _id: true,
            schema_version: true,
            event: true,
            app_id: true,
            app_version: true,
            install_id: true,
            platform: true,
            arch: true,
            active_date: true,
            received_at: true,
          })
          .limit(PAGE_SIZE)
          .get();
        if (!Array.isArray(result?.data) || result.code) {
          throw createDatabaseError(result);
        }
        const rows = result.data;
        for (const row of rows) {
          if (
            !row ||
            typeof row._id !== "string" ||
            !row._id ||
            (cursor !== undefined && row._id <= cursor)
          ) {
            throw new Error("dashboard_query_invalid_cursor");
          }
          cursor = row._id;
        }
        allEvents.push(...rows);
        if (rows.length < PAGE_SIZE) break;
        if (page === MAX_PAGES_PER_COLLECTION - 1) {
          throw new Error("dashboard_query_limit_exceeded");
        }
      }
    }

    return allEvents;
  };
}

async function readEventsFromStorage({
  app,
  apps,
  endDate,
  historicalCache,
  historicalCacheTtlMs,
  nowMs,
  receivedBefore,
  startDate,
  storageReader,
}) {
  const dates = enumerateDateRange(startDate, endDate);
  const uncachedItems = [];
  const entries = [];
  const currentMs = nowMs();

  for (const targetApp of apps) {
    for (const date of dates) {
      const dailyPath = telemetryDailyCloudPath(targetApp.appId, date);
      const isHistorical = date < endDate;
      if (isHistorical && historicalCacheTtlMs > 0) {
        const cached = historicalCache.get(dailyPath);
        if (cached && currentMs - cached.loadedAt < historicalCacheTtlMs) {
          entries.push({
            appId: targetApp.appId,
            date,
            payload: cached.payload,
          });
          continue;
        }
      }
      uncachedItems.push({
        appId: targetApp.appId,
        dailyPath,
        manifestPath: telemetryManifestCloudPath(targetApp.appId, date),
        date,
        isHistorical,
      });
    }
  }

  if (uncachedItems.length > 0) {
    // 阶段 1：优先批量读取单日文件（已归档历史天和升级前老数据在此一步命中）
    const dailyMap = await storageReader.readJsonBatch(
      app,
      uncachedItems.map((item) => item.dailyPath),
    );

    const needsManifestCheck = [];
    for (const item of uncachedItems) {
      const dailyPayload = dailyMap.get(item.dailyPath) ?? null;
      item.dailyPayload = dailyPayload;
      if (item.isHistorical && dailyPayload?.compacted === true) {
        if (historicalCacheTtlMs > 0) {
          historicalCache.set(item.dailyPath, {
            loadedAt: currentMs,
            payload: dailyPayload,
          });
        }
        entries.push({
          appId: item.appId,
          date: item.date,
          payload: dailyPayload,
        });
      } else {
        needsManifestCheck.push(item);
      }
    }

    // 阶段 2：对未归档的日期探测是否存在分片 manifest.json
    const manifestMap =
      needsManifestCheck.length > 0
        ? await storageReader.readJsonBatch(
            app,
            needsManifestCheck.map((item) => item.manifestPath),
          )
        : new Map();

    const shardPathsToFetch = [];
    const shardedItems = [];
    for (const item of needsManifestCheck) {
      const manifest = manifestMap.get(item.manifestPath) ?? null;
      if (!manifest || typeof manifest !== "object") {
        // 无分片：直接使用单日文件（兼容旧版或空天）
        if (item.isHistorical && historicalCacheTtlMs > 0) {
          historicalCache.set(item.dailyPath, {
            loadedAt: currentMs,
            payload: item.dailyPayload,
          });
        }
        entries.push({
          appId: item.appId,
          date: item.date,
          payload: item.dailyPayload,
        });
        continue;
      }
      const shardCount = normalizeShardCount(manifest.shard_count);
      const shardPaths = [];
      for (let shard = 0; shard < shardCount; shard += 1) {
        const shardPath = telemetryShardCloudPath(item.appId, item.date, shard);
        shardPaths.push(shardPath);
        shardPathsToFetch.push(shardPath);
      }
      item.shardCount = shardCount;
      item.shardPaths = shardPaths;
      shardedItems.push(item);
    }

    // 阶段 3：批量读取所有已存在 manifest 的分片，并与旧单日文件合并去重
    const shardMap =
      shardPathsToFetch.length > 0
        ? await storageReader.readJsonBatch(app, shardPathsToFetch)
        : new Map();

    const compactTasks = [];
    for (const item of shardedItems) {
      const mergedEvents = mergeStorageEventPayloads([
        item.dailyPayload,
        ...item.shardPaths.map((shardPath) => shardMap.get(shardPath) ?? null),
      ]);
      const mergedPayload = {
        schema_version: 2,
        app_id: item.appId,
        active_date: item.date,
        compacted: item.isHistorical,
        shard_count: item.shardCount,
        updated_at: new Date(currentMs).toISOString(),
        events: mergedEvents,
      };
      if (item.isHistorical) {
        if (historicalCacheTtlMs > 0) {
          historicalCache.set(item.dailyPath, {
            loadedAt: currentMs,
            payload: mergedPayload,
          });
        }
        if (typeof storageReader.writeJson === "function") {
          compactTasks.push(
            storageReader
              .writeJson(app, item.dailyPath, mergedPayload)
              .catch(() => null),
          );
        }
      }
      entries.push({
        appId: item.appId,
        date: item.date,
        payload: mergedPayload,
      });
    }

    if (compactTasks.length > 0) {
      await Promise.all(compactTasks);
    }
  }

  const allEvents = [];
  for (const entry of entries) {
    const rawEvents = extractStorageEventRows(entry.payload);
    for (const row of rawEvents) {
      if (
        !row ||
        typeof row !== "object" ||
        row.app_id !== entry.appId ||
        row.schema_version !== 2 ||
        row.event !== "daily_active" ||
        typeof row.active_date !== "string" ||
        row.active_date < startDate ||
        row.active_date > endDate ||
        typeof row.received_at !== "string" ||
        row.received_at > receivedBefore
      ) {
        continue;
      }
      allEvents.push({
        _id: row._id,
        schema_version: row.schema_version,
        event: row.event,
        app_id: row.app_id,
        app_version: row.app_version,
        install_id: row.install_id,
        platform: row.platform,
        arch: row.arch,
        active_date: row.active_date,
        received_at: row.received_at,
      });
    }
  }

  return allEvents;
}

function mergeStorageEventPayloads(payloads) {
  const merged = {};
  for (const payload of payloads) {
    const rows = extractStorageEventRows(payload);
    for (const row of rows) {
      if (!row || typeof row !== "object" || typeof row._id !== "string") {
        continue;
      }
      const existing = merged[row._id];
      if (
        !existing ||
        (typeof row.received_at === "string" &&
          (typeof existing.received_at !== "string" ||
            row.received_at > existing.received_at))
      ) {
        merged[row._id] = row;
      }
    }
  }
  return merged;
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
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_STORAGE_SHARDS) {
    return DEFAULT_STORAGE_SHARDS;
  }
  return parsed;
}

function extractStorageEventRows(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.events)) return payload.events;
  if (payload.events && typeof payload.events === "object") {
    return Object.values(payload.events);
  }
  return [];
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
    typeof app.getTempFileURL === "function" &&
    typeof app.getUploadMetadata === "function",
  );
}

function createDefaultCloudBaseApp(options = {}) {
  const cloudbaseModule =
    options.cloudbaseModule || require("@cloudbase/js-sdk");
  const cloudbase = cloudbaseModule.default || cloudbaseModule;
  const configuredEnv =
    options.envOverride === undefined
      ? process.env.CLOUDBASE_ENV_ID
      : options.envOverride;
  const currentEnv =
    cloudbase.SYMBOL_CURRENT_ENV || cloudbaseModule.SYMBOL_CURRENT_ENV;
  const env =
    (typeof configuredEnv === "string" && configuredEnv.trim()) || currentEnv;
  if (!env) throw new Error("cloudbase_environment_unavailable");
  const context = extractRuntimeSdkContext(options.runtimeContext);
  return cloudbase.init({ env, ...(context ? { context } : {}) });
}

function extractRuntimeSdkContext(runtimeContext) {
  if (!runtimeContext || typeof runtimeContext !== "object") return null;
  const direct = runtimeContext.extendedContext?.tmpSecret;
  if (isSessionSecret(direct)) {
    return {
      extendedContext: {
        tmpSecret: {
          secretId: direct.secretId,
          secretKey: direct.secretKey,
          token: direct.token,
        },
      },
    };
  }
  let environment = runtimeContext.environment;
  if (typeof environment === "string" && environment.length <= 65_536) {
    try {
      environment = JSON.parse(environment);
    } catch {
      environment = null;
    }
  }
  if (
    !environment &&
    typeof runtimeContext.environ === "string" &&
    runtimeContext.environ.length <= 65_536
  ) {
    environment = Object.fromEntries(
      runtimeContext.environ
        .split(";")
        .filter((item) => item.includes("="))
        .map((item) => {
          const offset = item.indexOf("=");
          return [item.slice(0, offset), item.slice(offset + 1)];
        }),
    );
  }
  const secret = {
    secretId: environment?.TENCENTCLOUD_SECRETID,
    secretKey: environment?.TENCENTCLOUD_SECRETKEY,
    token: environment?.TENCENTCLOUD_SESSIONTOKEN,
  };
  return isSessionSecret(secret)
    ? { extendedContext: { tmpSecret: secret } }
    : null;
}

function isSessionSecret(value) {
  return (
    value &&
    [value.secretId, value.secretKey, value.token].every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 8192,
    )
  );
}

module.exports = {
  HISTORICAL_DAY_CACHE_TTL_MS,
  MAX_PAGES_PER_COLLECTION,
  PAGE_SIZE,
  STORAGE_BACKEND_DATABASE,
  STORAGE_BACKEND_STORAGE,
  createCloudBaseEventReader,
  createDefaultCloudBaseApp,
  extractRuntimeSdkContext,
  normalizeStorageBackend,
  shouldUseStorageBackend,
};
