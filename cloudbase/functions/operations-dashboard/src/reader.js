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
  const pathsToFetch = [];
  const entries = [];
  const currentMs = nowMs();

  for (const targetApp of apps) {
    for (const date of dates) {
      const cloudPath = `telemetry/${targetApp.appId}/${date}.json`;
      const isHistorical = date < endDate;
      if (isHistorical && historicalCacheTtlMs > 0) {
        const cached = historicalCache.get(cloudPath);
        if (cached && currentMs - cached.loadedAt < historicalCacheTtlMs) {
          entries.push({
            appId: targetApp.appId,
            date,
            payload: cached.payload,
          });
          continue;
        }
      }
      pathsToFetch.push({
        appId: targetApp.appId,
        cloudPath,
        date,
        isHistorical,
      });
    }
  }

  if (pathsToFetch.length > 0) {
    const fetched = await storageReader.readJsonBatch(
      app,
      pathsToFetch.map((item) => item.cloudPath),
    );
    for (const item of pathsToFetch) {
      const payload = fetched.get(item.cloudPath) ?? null;
      if (item.isHistorical && historicalCacheTtlMs > 0) {
        historicalCache.set(item.cloudPath, { loadedAt: currentMs, payload });
      }
      entries.push({ appId: item.appId, date: item.date, payload });
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
