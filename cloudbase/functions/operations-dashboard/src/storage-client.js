"use strict";

const TEMP_URL_BATCH_SIZE = 50;
const DEFAULT_FETCH_CONCURRENCY = 8;

/**
 * 基于 CloudBase 云存储（COS）的批量 JSON 读取客户端。
 * 使用批量 getTempFileURL（每次最多 50 个文件）+ 限流并发 fetch，避免串行拉取超时并完全绕开 PostgreSQL。
 */
function createCloudStorageReader(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const concurrency =
    Number.isInteger(options.concurrency) && options.concurrency > 0
      ? options.concurrency
      : DEFAULT_FETCH_CONCURRENCY;
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

  async function resolveStoragePrefix(app, samplePath) {
    if (storagePrefix) return storagePrefix;
    if (typeof app.getUploadMetadata !== "function") {
      throw new Error("cloudbase_storage_metadata_unavailable");
    }
    const metadata = await app.getUploadMetadata({ cloudPath: samplePath });
    const fileId = metadata?.data?.fileId || metadata?.fileId;
    if (typeof fileId !== "string" || !fileId.startsWith("cloud://")) {
      throw new Error("cloudbase_storage_file_id_unavailable");
    }
    rememberPrefixFromFileId(fileId, samplePath);
    if (!storagePrefix) {
      throw new Error("cloudbase_storage_prefix_unavailable");
    }
    return storagePrefix;
  }

  async function readJsonBatch(app, cloudPaths) {
    const results = new Map();
    if (!Array.isArray(cloudPaths) || cloudPaths.length === 0) {
      return results;
    }
    const prefix = await resolveStoragePrefix(app, cloudPaths[0]);
    const pathByFileId = new Map();
    const fileIds = [];
    for (const cloudPath of cloudPaths) {
      const fileId = `${prefix}${cloudPath}`;
      pathByFileId.set(fileId, cloudPath);
      fileIds.push(fileId);
    }

    const downloadTasks = [];
    for (
      let offset = 0;
      offset < fileIds.length;
      offset += TEMP_URL_BATCH_SIZE
    ) {
      const batch = fileIds.slice(offset, offset + TEMP_URL_BATCH_SIZE);
      const response = await app.getTempFileURL({ fileList: batch });
      if (!Array.isArray(response?.fileList)) {
        throw new Error("cloudbase_storage_temp_url_invalid");
      }
      for (const item of response.fileList) {
        const cloudPath = pathByFileId.get(item.fileID);
        if (!cloudPath) continue;
        if (isNotFoundCode(item.code) || !item.tempFileURL) {
          results.set(cloudPath, null);
          continue;
        }
        if (item.code && item.code !== "SUCCESS") {
          throw new Error(`cloudbase_storage_temp_url_failed:${item.code}`);
        }
        downloadTasks.push({ cloudPath, url: item.tempFileURL });
      }
    }

    if (downloadTasks.length > 0 && typeof fetchImpl !== "function") {
      throw new Error("cloudbase_storage_fetch_unavailable");
    }

    await runWithConcurrency(downloadTasks, concurrency, async (task) => {
      const response = await fetchImpl(task.url, {
        method: "GET",
        headers: { "Cache-Control": "no-cache" },
      });
      if (response.status === 404) {
        results.set(task.cloudPath, null);
        return;
      }
      if (!response.ok) {
        throw new Error(`cloudbase_storage_download_failed:${response.status}`);
      }
      const text = await response.text();
      results.set(task.cloudPath, text ? JSON.parse(text) : null);
    });

    for (const cloudPath of cloudPaths) {
      if (!results.has(cloudPath)) {
        results.set(cloudPath, null);
      }
    }
    return results;
  }

  return {
    readJsonBatch,
  };
}

async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  const workerCount = Math.min(limit, items.length);
  const runners = Array.from({ length: workerCount }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await worker(current);
    }
  });
  await Promise.all(runners);
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

function enumerateDateRange(startDate, endDate) {
  const dates = [];
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return dates;
  }
  for (
    let cursor = start.getTime();
    cursor <= end.getTime();
    cursor += 24 * 60 * 60 * 1000
  ) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

module.exports = {
  DEFAULT_FETCH_CONCURRENCY,
  TEMP_URL_BATCH_SIZE,
  createCloudStorageReader,
  enumerateDateRange,
  isNotFoundCode,
  normalizeStoragePrefix,
};
