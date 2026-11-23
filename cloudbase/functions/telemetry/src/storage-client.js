"use strict";

const DEFAULT_MAX_RETAINED_DATES = 2;
const DEFAULT_MAX_SEEN_IDS_PER_DATE = 50_000;
const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 80;

/**
 * 基于 CloudBase 云存储（COS）的轻量 JSON 读写客户端。
 * 兼容 @cloudbase/js-sdk 与 @cloudbase/node-sdk 的 uploadFile / getUploadMetadata / getTempFileURL。
 */
function createCloudStorageClient(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const retryAttempts =
    Number.isInteger(options.retryAttempts) && options.retryAttempts >= 0
      ? options.retryAttempts
      : DEFAULT_RETRY_ATTEMPTS;
  const retryBaseDelayMs =
    Number.isFinite(options.retryBaseDelayMs) && options.retryBaseDelayMs >= 0
      ? options.retryBaseDelayMs
      : DEFAULT_RETRY_BASE_DELAY_MS;
  const sleepImpl = options.sleep || defaultSleep;
  let storagePrefix = normalizeStoragePrefix(
    options.storagePrefix === undefined
      ? process.env.CLOUDBASE_STORAGE_PREFIX
      : options.storagePrefix,
  );

  function rememberPrefixFromFileId(fileId, cloudPath) {
    if (
      typeof fileId === "string" &&
      typeof cloudPath === "string" &&
      fileId.startsWith("cloud://") &&
      fileId.endsWith(`/${cloudPath}`)
    ) {
      storagePrefix = fileId.slice(0, fileId.length - cloudPath.length);
    }
  }

  async function withRetry(operation) {
    let lastError;
    for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt === retryAttempts || !isRetryableStorageError(error)) {
          throw error;
        }
        const delayMs = retryBaseDelayMs * (attempt + 1);
        if (delayMs > 0) {
          await sleepImpl(delayMs);
        }
      }
    }
    throw lastError;
  }

  async function resolveFileId(app, cloudPath) {
    if (storagePrefix) {
      return `${storagePrefix}${cloudPath}`;
    }
    if (typeof app.getUploadMetadata !== "function") {
      throw new Error("cloudbase_storage_metadata_unavailable");
    }
    const metadata = await withRetry(() =>
      app.getUploadMetadata({ cloudPath }),
    );
    const fileId = metadata?.data?.fileId || metadata?.fileId;
    if (typeof fileId !== "string" || !fileId.startsWith("cloud://")) {
      throw new Error("cloudbase_storage_file_id_unavailable");
    }
    rememberPrefixFromFileId(fileId, cloudPath);
    return fileId;
  }

  async function readJson(app, cloudPath) {
    return withRetry(async () => {
      const fileID = await resolveFileId(app, cloudPath);
      const tempResult = await app.getTempFileURL({ fileList: [fileID] });
      const item = Array.isArray(tempResult?.fileList)
        ? tempResult.fileList[0]
        : null;
      if (!item) {
        throw new Error("cloudbase_storage_temp_url_missing");
      }
      if (isNotFoundCode(item.code)) {
        return null;
      }
      if (item.code && item.code !== "SUCCESS") {
        throw new Error(`cloudbase_storage_temp_url_failed:${item.code}`);
      }
      if (typeof item.tempFileURL !== "string" || !item.tempFileURL) {
        return null;
      }
      if (typeof fetchImpl !== "function") {
        throw new Error("cloudbase_storage_fetch_unavailable");
      }
      const response = await fetchImpl(item.tempFileURL, {
        method: "GET",
        headers: { "Cache-Control": "no-cache" },
      });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`cloudbase_storage_download_failed:${response.status}`);
      }
      const text = await response.text();
      if (!text) return null;
      return JSON.parse(text);
    });
  }

  async function writeJson(app, cloudPath, value) {
    const fileContent = Buffer.from(JSON.stringify(value), "utf8");
    return withRetry(async () => {
      const result = await app.uploadFile({ cloudPath, fileContent });
      if (result?.code) {
        throw new Error(`cloudbase_storage_upload_failed:${result.code}`);
      }
      rememberPrefixFromFileId(result?.fileID || result?.fileId, cloudPath);
      return result;
    });
  }

  return {
    readJson,
    resolveFileId,
    writeJson,
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStorageError(error) {
  if (!error || typeof error !== "object") return false;
  if (error instanceof TypeError || error instanceof SyntaxError) return false;
  const message = typeof error.message === "string" ? error.message : "";
  if (
    message === "cloudbase_storage_metadata_unavailable" ||
    message === "cloudbase_storage_file_id_unavailable" ||
    message === "cloudbase_storage_fetch_unavailable"
  ) {
    return false;
  }
  return true;
}

/**
 * 热实例内存缓存：按北京日期记录已见事件（支持去重 + 同分片并集自愈）。
 */
function createDailySeenCache(options = {}) {
  const maxRetainedDates =
    Number.isInteger(options.maxRetainedDates) && options.maxRetainedDates > 0
      ? options.maxRetainedDates
      : DEFAULT_MAX_RETAINED_DATES;
  const maxIdsPerDate =
    Number.isInteger(options.maxIdsPerDate) && options.maxIdsPerDate > 0
      ? options.maxIdsPerDate
      : DEFAULT_MAX_SEEN_IDS_PER_DATE;
  const byDate = new Map();

  function has(activeDate, id) {
    const entries = byDate.get(activeDate);
    return Boolean(entries && entries.has(id));
  }

  function add(activeDate, id, serializedEvent = null) {
    let entries = byDate.get(activeDate);
    if (!entries) {
      entries = new Map();
      byDate.set(activeDate, entries);
      pruneOldDates();
    }
    if (entries.has(id)) {
      if (serializedEvent && entries.get(id) === null) {
        entries.set(id, serializedEvent);
      }
      return;
    }
    if (entries.size < maxIdsPerDate) {
      entries.set(id, serializedEvent);
    }
  }

  function getShardEvents(activeDate, shardIndex, shardSelector) {
    const entries = byDate.get(activeDate);
    if (!entries || entries.size === 0) return {};
    const matched = {};
    for (const [id, event] of entries) {
      if (event && shardSelector(id) === shardIndex) {
        matched[id] = event;
      }
    }
    return matched;
  }

  function pruneOldDates() {
    if (byDate.size <= maxRetainedDates) return;
    const sortedDates = [...byDate.keys()].sort();
    while (sortedDates.length > maxRetainedDates) {
      const oldest = sortedDates.shift();
      byDate.delete(oldest);
    }
  }

  return { add, getShardEvents, has };
}

function normalizeStoragePrefix(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("cloud://")) return null;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function isNotFoundCode(code) {
  if (typeof code !== "string") return false;
  return /NONEXIST|NOT_FOUND|NO_SUCH_KEY|404/i.test(code);
}

module.exports = {
  createCloudStorageClient,
  createDailySeenCache,
  isNotFoundCode,
  normalizeStoragePrefix,
};
