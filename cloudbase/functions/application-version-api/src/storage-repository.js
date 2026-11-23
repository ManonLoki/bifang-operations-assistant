"use strict";

const { ApiError } = require("./errors");

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_AUDIT_RECORDS = 2_000;

/**
 * 基于 CloudBase 云存储（COS）+ 热实例内存缓存的应用版本与广告仓库。
 * 按 appId 隔离 JSON 文件，读请求走短 TTL 缓存，写请求强读最新文件并刷新缓存，彻底避免唤醒 PostgreSQL。
 */
function createCloudStorageRepository(options = {}) {
  const {
    appFactory,
    byAppId,
    cache = new Map(),
    cacheTtlMs = resolveCacheTtlMs(options.cacheTtlMs),
    fetchImpl = options.fetch || globalThis.fetch,
    now = options.now || (() => Date.now()),
    runtimeContext,
    storagePrefix: initialPrefix = process.env.CLOUDBASE_STORAGE_PREFIX,
  } = options;

  let appInstance;
  let storagePrefix = normalizeStoragePrefix(initialPrefix);

  function getApp() {
    if (!appInstance) {
      appInstance = appFactory({ runtimeContext });
    }
    return appInstance;
  }

  function select(appId) {
    const value = byAppId.get(appId);
    if (!value) throw new Error("application_version_resource_unavailable");
    return value;
  }

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

  async function resolveFileId(cloudPath) {
    if (storagePrefix) {
      return `${storagePrefix}${cloudPath}`;
    }
    const app = getApp();
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

  async function readJsonFile(cloudPath) {
    const app = getApp();
    const fileID = await resolveFileId(cloudPath);
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
    return text ? JSON.parse(text) : null;
  }

  async function writeJsonFile(cloudPath, payload) {
    const app = getApp();
    const result = await app.uploadFile({
      cloudPath,
      fileContent: Buffer.from(JSON.stringify(payload), "utf8"),
    });
    if (result?.code) {
      throw new Error(`cloudbase_storage_upload_failed:${result.code}`);
    }
    rememberPrefixFromFileId(result?.fileID || result?.fileId, cloudPath);
  }

  async function loadRecords(appId, kind, { bypassCache = false } = {}) {
    select(appId);
    const cloudPath = versionControlCloudPath(appId, kind);
    const cacheKey = cloudPath;
    if (!bypassCache && cacheTtlMs > 0) {
      const entry = cache.get(cacheKey);
      if (entry && now() - entry.loadedAt < cacheTtlMs) {
        return entry.records.map((record) => structuredClone(record));
      }
    }
    const data = await readJsonFile(cloudPath);
    const records = Array.isArray(data?.records) ? data.records : [];
    if (cacheTtlMs > 0) {
      cache.set(cacheKey, {
        loadedAt: now(),
        records: records.map((record) => structuredClone(record)),
      });
    }
    return records.map((record) => structuredClone(record));
  }

  async function saveRecords(appId, kind, records) {
    select(appId);
    const cloudPath = versionControlCloudPath(appId, kind);
    const cloned = records.map((record) => structuredClone(record));
    await writeJsonFile(cloudPath, {
      schema_version: 1,
      app_id: appId,
      updated_at: new Date(now()).toISOString(),
      records: cloned,
    });
    if (cacheTtlMs > 0 && kind !== "audit") {
      cache.set(cloudPath, {
        loadedAt: now(),
        records: cloned.map((record) => structuredClone(record)),
      });
    }
  }

  async function appendAudit(appId, audit) {
    const existing = await loadRecords(appId, "audit", { bypassCache: true });
    existing.push(structuredClone(audit));
    const trimmed =
      existing.length > MAX_AUDIT_RECORDS
        ? existing.slice(existing.length - MAX_AUDIT_RECORDS)
        : existing;
    await saveRecords(appId, "audit", trimmed);
  }

  return {
    async createVersion(appId, record, audit) {
      const records = await loadRecords(appId, "versions", {
        bypassCache: true,
      });
      if (
        records.some(
          (item) =>
            item.id === record.id ||
            (item.code === record.code &&
              item.versionKey === record.versionKey),
        )
      ) {
        throw conflict();
      }
      records.push(structuredClone(record));
      await saveRecords(appId, "versions", records);
      await appendAudit(appId, audit);
    },

    async updateVersion(appId, id, record, audit, authorizedCodes) {
      const records = await loadRecords(appId, "versions", {
        bypassCache: true,
      });
      const index = records.findIndex((item) => item.id === id);
      if (index === -1) return null;
      const existing = records[index];
      assertCodeAuthorized(authorizedCodes, existing.code);
      assertCodeAuthorized(authorizedCodes, record.code);
      if (
        records.some(
          (item) =>
            item.id !== id &&
            item.code === record.code &&
            item.versionKey === record.versionKey,
        )
      ) {
        throw conflict();
      }
      const updated = {
        ...structuredClone(record),
        id,
        createdAt: existing.createdAt,
      };
      records[index] = updated;
      await saveRecords(appId, "versions", records);
      await appendAudit(appId, audit);
      return structuredClone(updated);
    },

    async listVersions(appId, codes, pagination) {
      const allowed = new Set(codes);
      const records = (await loadRecords(appId, "versions"))
        .filter((item) => allowed.has(item.code))
        .sort(compareCreated(pagination.direction));
      return paginate(records, pagination);
    },

    async listVersionsForCode(appId, code) {
      return (await loadRecords(appId, "versions")).filter(
        (item) => item.code === code,
      );
    },

    async createAd(appId, record, audit) {
      const records = await loadRecords(appId, "ads", { bypassCache: true });
      if (records.some((item) => item.id === record.id)) {
        throw conflict();
      }
      records.push(structuredClone(record));
      await saveRecords(appId, "ads", records);
      await appendAudit(appId, audit);
    },

    async updateAd(appId, code, id, changes, audit) {
      const records = await loadRecords(appId, "ads", { bypassCache: true });
      const index = records.findIndex((item) => item.id === id);
      if (index === -1 || records[index].appCode !== code) return null;
      const updated = {
        ...records[index],
        ...structuredClone(changes),
        id,
        appCode: code,
      };
      records[index] = updated;
      await saveRecords(appId, "ads", records);
      await appendAudit(appId, audit);
      return structuredClone(updated);
    },

    async deleteAd(appId, code, id, audit) {
      const records = await loadRecords(appId, "ads", { bypassCache: true });
      const index = records.findIndex((item) => item.id === id);
      if (index === -1 || records[index].appCode !== code) return null;
      const [removed] = records.splice(index, 1);
      await saveRecords(appId, "ads", records);
      await appendAudit(appId, audit);
      return structuredClone(removed);
    },

    async getAd(appId, id) {
      const records = await loadRecords(appId, "ads");
      const found = records.find((item) => item.id === id);
      return found ? structuredClone(found) : null;
    },

    async listAds(appId, code, pagination) {
      const records = (await loadRecords(appId, "ads"))
        .filter((item) => item.appCode === code)
        .sort(compareCreated(pagination.direction));
      return paginate(records, pagination);
    },

    async showAds(appId, code) {
      return (await loadRecords(appId, "ads"))
        .filter((item) => item.appCode === code)
        .sort(compareCreated("desc"))
        .slice(0, 100);
    },
  };
}

function versionControlCloudPath(appId, kind) {
  return `version-control/${appId}/${kind}.json`;
}

function resolveCacheTtlMs(override) {
  const raw =
    override === undefined ? process.env.VERSION_CACHE_TTL_MS : override;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_CACHE_TTL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CACHE_TTL_MS;
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

function conflict() {
  return new ApiError(409, "resource.conflict", "资源已存在或发生冲突");
}

function assertCodeAuthorized(authorizedCodes, code) {
  if (!(authorizedCodes instanceof Set) || !authorizedCodes.has(code)) {
    throw new ApiError(403, "auth.forbidden", "没有访问权限");
  }
}

function paginate(values, { page, size }) {
  const totalRecords = values.length;
  const start = (page - 1) * size;
  return {
    records: values.slice(start, start + size),
    totalRecords,
  };
}

function compareCreated(direction) {
  const multiplier = direction === "asc" ? 1 : -1;
  return (left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt < right.createdAt ? -multiplier : multiplier;
    }
    if (left.id === right.id) return 0;
    return left.id < right.id ? -multiplier : multiplier;
  };
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  createCloudStorageRepository,
  versionControlCloudPath,
};
