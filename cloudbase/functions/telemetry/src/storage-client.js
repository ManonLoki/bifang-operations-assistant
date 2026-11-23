"use strict";

const DEFAULT_MAX_RETAINED_DATES = 2;
const DEFAULT_MAX_SEEN_IDS_PER_DATE = 50_000;

/**
 * 基于 CloudBase 云存储（COS）的轻量 JSON 读写客户端。
 * 兼容 @cloudbase/js-sdk 与 @cloudbase/node-sdk 的 uploadFile / getUploadMetadata / getTempFileURL。
 */
function createCloudStorageClient(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
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

  async function resolveFileId(app, cloudPath) {
    if (storagePrefix) {
      return `${storagePrefix}${cloudPath}`;
    }
    if (typeof app.getUploadMetadata !== "function") {
      throw new Error("cloudbase_storage_metadata_unavailable");
    }
    const metadata = await app.getUploadMetadata({ cloudPath });
    const fileId = metadata?.data?.fileId || metadata?.fileId;
    if (typeof fileId !== "string" || !fileId.startsWith("cloud://")) {
      throw new Error("cloudbase_storage_file_id_unavailable");
    }
    rememberPrefixFromFileId(fileId, cloudPath);
    return fileId;
  }

  async function readJson(app, cloudPath) {
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
  }

  async function writeJson(app, cloudPath, value) {
    const fileContent = Buffer.from(JSON.stringify(value), "utf8");
    const result = await app.uploadFile({ cloudPath, fileContent });
    if (result?.code) {
      throw new Error(`cloudbase_storage_upload_failed:${result.code}`);
    }
    rememberPrefixFromFileId(result?.fileID || result?.fileId, cloudPath);
    return result;
  }

  return {
    readJson,
    resolveFileId,
    writeJson,
  };
}

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
    const set = byDate.get(activeDate);
    return Boolean(set && set.has(id));
  }

  function add(activeDate, id) {
    let set = byDate.get(activeDate);
    if (!set) {
      set = new Set();
      byDate.set(activeDate, set);
      pruneOldDates();
    }
    if (set.size < maxIdsPerDate) {
      set.add(id);
    }
  }

  function pruneOldDates() {
    if (byDate.size <= maxRetainedDates) return;
    const sortedDates = [...byDate.keys()].sort();
    while (sortedDates.length > maxRetainedDates) {
      const oldest = sortedDates.shift();
      byDate.delete(oldest);
    }
  }

  return { add, has };
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
