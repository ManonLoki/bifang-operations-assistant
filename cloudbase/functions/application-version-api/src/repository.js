"use strict";

const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { ApiError } = require("./errors");
const {
  validateAdCreate,
  validateAdId,
  validateCode,
  validateVersionId,
  validateVersionWrite,
} = require("./validation");
const { createVersionSortKey } = require("./version");
const { createCloudStorageRepository } = require("./storage-repository");

const COLLECTION_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;
const STORAGE_BACKEND_STORAGE = "storage";
const STORAGE_BACKEND_DATABASE = "database";

function parseApplicationResources(value) {
  let parsed = value;
  for (let depth = 0; depth < 2 && typeof parsed === "string"; depth += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100) {
    return null;
  }
  const resources = [];
  for (const item of parsed) {
    if (
      !isPlainObject(item) ||
      Object.keys(item).sort().join(",") !==
        "adCollection,appId,auditCollection,versionCollection" ||
      typeof item.appId !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(item.appId) ||
      ![item.adCollection, item.auditCollection, item.versionCollection].every(
        (name) => typeof name === "string" && COLLECTION_PATTERN.test(name),
      )
    ) {
      return null;
    }
    const collectionSuffix = item.appId.replaceAll("-", "_");
    if (
      item.versionCollection !== `versions_${collectionSuffix}` ||
      item.adCollection !== `ads_${collectionSuffix}` ||
      item.auditCollection !== `audit_${collectionSuffix}`
    ) {
      return null;
    }
    resources.push({ ...item });
  }
  if (
    new Set(resources.map(({ appId }) => appId)).size !== resources.length ||
    new Set(
      resources.flatMap(
        ({ adCollection, auditCollection, versionCollection }) => [
          adCollection,
          auditCollection,
          versionCollection,
        ],
      ),
    ).size !==
      resources.length * 3
  ) {
    return null;
  }
  return resources;
}

function createCloudBaseRepository(options = {}) {
  const resources = parseApplicationResources(options.resources);
  if (!resources) throw new TypeError("invalid application version resources");
  const byAppId = new Map(resources.map((item) => [item.appId, item]));
  const appFactory = options.appFactory || createDefaultCloudBaseApp;
  const configuredBackend = normalizeStorageBackend(
    options.storageBackend === undefined
      ? process.env.STORAGE_BACKEND
      : options.storageBackend,
  );
  let appInstance;
  let database;
  let storageRepository;

  function getApp() {
    if (!appInstance) {
      appInstance = appFactory({
        runtimeContext: options.runtimeContext,
      });
    }
    return appInstance;
  }

  function resolveBackend() {
    if (configuredBackend === STORAGE_BACKEND_DATABASE) {
      return STORAGE_BACKEND_DATABASE;
    }
    if (configuredBackend === STORAGE_BACKEND_STORAGE) {
      return STORAGE_BACKEND_STORAGE;
    }
    const app = getApp();
    return app &&
      typeof app.uploadFile === "function" &&
      typeof app.getTempFileURL === "function"
      ? STORAGE_BACKEND_STORAGE
      : STORAGE_BACKEND_DATABASE;
  }

  function getStorageRepository() {
    if (!storageRepository) {
      storageRepository = createCloudStorageRepository({
        appFactory: () => getApp(),
        byAppId,
        cache: options.cache,
        cacheTtlMs: options.cacheTtlMs,
        fetch: options.fetch,
        now: options.now,
        runtimeContext: options.runtimeContext,
        storagePrefix: options.storagePrefix,
      });
    }
    return storageRepository;
  }

  function getDatabase() {
    if (!database) {
      database = getApp().database();
    }
    return database;
  }

  function select(appId) {
    const value = byAppId.get(appId);
    if (!value) throw new Error("application_version_resource_unavailable");
    return value;
  }

  const databaseRepository = {
    async createVersion(appId, record, audit) {
      const resource = select(appId);
      const database = getDatabase();
      try {
        await database.runTransaction(async (transaction) => {
          const versions = transaction.collection(resource.versionCollection);
          const key = versionKeyDocumentId(record.code, record.versionKey);
          if (await transactionDocumentExists(versions.doc(key)))
            throw conflict();
          await versions.doc(key).create({
            doc_type: "version_key",
            code: record.code,
            version_key: record.versionKey,
            version_id: record.id,
          });
          await versions
            .doc(versionDocumentId(record.id))
            .create(toVersionDocument(record));
          await transaction
            .collection(resource.auditCollection)
            .doc(auditDocumentId(audit.id))
            .create(toAuditDocument(audit));
        });
      } catch (error) {
        throw translateWriteError(error);
      }
    },

    async updateVersion(appId, id, record, audit, authorizedCodes) {
      const resource = select(appId);
      const database = getDatabase();
      try {
        return await database.runTransaction(async (transaction) => {
          const versions = transaction.collection(resource.versionCollection);
          const reference = versions.doc(versionDocumentId(id));
          const existingDocument = await readTransactionDocument(reference);
          if (!existingDocument) return null;
          const existing = fromVersionDocument(existingDocument);
          assertCodeAuthorized(authorizedCodes, existing.code);
          assertCodeAuthorized(authorizedCodes, record.code);
          const previousKey = versionKeyDocumentId(
            existing.code,
            existing.versionKey,
          );
          const nextKey = versionKeyDocumentId(record.code, record.versionKey);
          if (nextKey !== previousKey) {
            if (await transactionDocumentExists(versions.doc(nextKey))) {
              throw conflict();
            }
            await versions.doc(nextKey).create({
              doc_type: "version_key",
              code: record.code,
              version_key: record.versionKey,
              version_id: id,
            });
          }
          const updated = { ...record, id, createdAt: existing.createdAt };
          await reference.set(toVersionDocument(updated));
          if (nextKey !== previousKey) await versions.doc(previousKey).delete();
          await transaction
            .collection(resource.auditCollection)
            .doc(auditDocumentId(audit.id))
            .create(toAuditDocument(audit));
          return updated;
        });
      } catch (error) {
        throw translateWriteError(error);
      }
    },

    async listVersions(appId, codes, pagination) {
      const resource = select(appId);
      const database = getDatabase();
      const condition = {
        doc_type: "version_record",
        code: database.command.in([...codes]),
      };
      const collection = database.collection(resource.versionCollection);
      const [queryResult, countResult] = await Promise.all([
        collection
          .where(condition)
          .orderBy("created_at", pagination.direction)
          .orderBy("_id", pagination.direction)
          .skip((pagination.page - 1) * pagination.size)
          .limit(pagination.size)
          .get(),
        collection.where(condition).count(),
      ]);
      return {
        records: readRows(queryResult).map(fromVersionDocument),
        totalRecords: readCount(countResult),
      };
    },

    async listVersionsForCode(appId, code) {
      const resource = select(appId);
      const collection = getDatabase().collection(resource.versionCollection);
      const result = await collection
        .where({ doc_type: "version_record", code })
        .orderBy("version_sort_key", "desc")
        .orderBy("updated_at", "desc")
        .orderBy("_id", "desc")
        .limit(1)
        .get();
      return readRows(result).map(fromVersionDocument);
    },

    async createAd(appId, record, audit) {
      const resource = select(appId);
      const database = getDatabase();
      try {
        await database.runTransaction(async (transaction) => {
          const reference = transaction
            .collection(resource.adCollection)
            .doc(adDocumentId(record.id));
          if (await transactionDocumentExists(reference)) throw conflict();
          await reference.create(toAdDocument(record));
          await transaction
            .collection(resource.auditCollection)
            .doc(auditDocumentId(audit.id))
            .create(toAuditDocument(audit));
        });
      } catch (error) {
        throw translateWriteError(error);
      }
    },

    async updateAd(appId, code, id, changes, audit) {
      const resource = select(appId);
      const database = getDatabase();
      try {
        return await database.runTransaction(async (transaction) => {
          const reference = transaction
            .collection(resource.adCollection)
            .doc(adDocumentId(id));
          const document = await readTransactionDocument(reference);
          if (!document || document.app_code !== code) return null;
          const existing = fromAdDocument(document);
          const updated = { ...existing, ...changes, id, appCode: code };
          await reference.set(toAdDocument(updated));
          await transaction
            .collection(resource.auditCollection)
            .doc(auditDocumentId(audit.id))
            .create(toAuditDocument(audit));
          return updated;
        });
      } catch (error) {
        throw translateWriteError(error);
      }
    },

    async deleteAd(appId, code, id, audit) {
      const resource = select(appId);
      const database = getDatabase();
      try {
        return await database.runTransaction(async (transaction) => {
          const reference = transaction
            .collection(resource.adCollection)
            .doc(adDocumentId(id));
          const document = await readTransactionDocument(reference);
          if (!document || document.app_code !== code) return null;
          const existing = fromAdDocument(document);
          await reference.delete();
          await transaction
            .collection(resource.auditCollection)
            .doc(auditDocumentId(audit.id))
            .create(toAuditDocument(audit));
          return existing;
        });
      } catch (error) {
        throw translateWriteError(error);
      }
    },

    async getAd(appId, id) {
      const resource = select(appId);
      const result = await getDatabase()
        .collection(resource.adCollection)
        .doc(adDocumentId(id))
        .get();
      const document = readSingleRow(result);
      return document ? fromAdDocument(document) : null;
    },

    async listAds(appId, code, pagination) {
      const resource = select(appId);
      const collection = getDatabase().collection(resource.adCollection);
      const condition = { doc_type: "ad_record", app_code: code };
      const [queryResult, countResult] = await Promise.all([
        collection
          .where(condition)
          .orderBy("created_at", pagination.direction)
          .orderBy("_id", pagination.direction)
          .skip((pagination.page - 1) * pagination.size)
          .limit(pagination.size)
          .get(),
        collection.where(condition).count(),
      ]);
      return {
        records: readRows(queryResult).map(fromAdDocument),
        totalRecords: readCount(countResult),
      };
    },

    async showAds(appId, code) {
      const resource = select(appId);
      const result = await getDatabase()
        .collection(resource.adCollection)
        .where({ doc_type: "ad_record", app_code: code })
        .orderBy("created_at", "desc")
        .orderBy("_id", "desc")
        .limit(100)
        .get();
      return readRows(result).map(fromAdDocument);
    },
  };

  function target() {
    return resolveBackend() === STORAGE_BACKEND_STORAGE
      ? getStorageRepository()
      : databaseRepository;
  }

  return {
    createVersion: (...args) => target().createVersion(...args),
    updateVersion: (...args) => target().updateVersion(...args),
    listVersions: (...args) => target().listVersions(...args),
    listVersionsForCode: (...args) => target().listVersionsForCode(...args),
    createAd: (...args) => target().createAd(...args),
    updateAd: (...args) => target().updateAd(...args),
    deleteAd: (...args) => target().deleteAd(...args),
    getAd: (...args) => target().getAd(...args),
    listAds: (...args) => target().listAds(...args),
    showAds: (...args) => target().showAds(...args),
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

function toVersionDocument(record) {
  const document = {
    doc_type: "version_record",
    schema_version: 1,
    id: record.id,
    name: record.name,
    code: record.code,
    code_version: record.codeVersion,
    version_key: record.versionKey,
    version_sort_key: createVersionSortKey(record.codeVersion),
    download_url: record.downloadUrl,
    prompt_content: record.promptContent,
    forced_update: record.forcedUpdate,
    prompt_update: record.promptUpdate,
    stop_update: record.stopUpdate,
    update_content: record.updateContent,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
  if (record.updateCriteria !== undefined) {
    document.update_criteria = record.updateCriteria;
    document.version_criteria = record.versionCriteria;
  }
  return document;
}

function fromVersionDocument(document) {
  assertDocument(document, "version_record");
  const persistedWrite = {
    name: document.name,
    code: document.code,
    codeVersion: document.code_version,
    downloadUrl: document.download_url,
    promptContent: document.prompt_content,
    forcedUpdate: document.forced_update,
    promptUpdate: document.prompt_update,
    stopUpdate: document.stop_update,
    updateContent: document.update_content,
  };
  if (
    document.update_criteria !== undefined ||
    document.version_criteria !== undefined
  ) {
    persistedWrite.updateCriteria = document.update_criteria;
    persistedWrite.versionCriteria = document.version_criteria;
  }
  try {
    const validated = validateVersionWrite(persistedWrite);
    const { versionKey, ...validatedWrite } = validated;
    validateVersionId(document.id);
    assertPersistedTimestamp(document.created_at);
    assertPersistedTimestamp(document.updated_at);
    if (
      (document._id !== undefined &&
        document._id !== versionDocumentId(document.id)) ||
      document.updated_at < document.created_at ||
      !isDeepStrictEqual(validatedWrite, persistedWrite) ||
      document.version_key !== versionKey ||
      document.version_sort_key !== createVersionSortKey(validated.codeVersion)
    ) {
      throw new TypeError("persisted version changed during validation");
    }
    return {
      id: document.id,
      ...validated,
      createdAt: document.created_at,
      updatedAt: document.updated_at,
    };
  } catch {
    throw new Error("application_version_invalid_document");
  }
}

function toAdDocument(record) {
  return {
    doc_type: "ad_record",
    schema_version: 1,
    id: record.id,
    app_code: record.appCode,
    title: record.title,
    url: record.url,
    image: record.image,
    content: record.content,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function fromAdDocument(document) {
  assertDocument(document, "ad_record");
  const persistedWrite = {
    title: document.title,
    url: document.url,
    image: document.image,
    content: document.content,
  };
  try {
    const validated = validateAdCreate(persistedWrite);
    validateAdId(document.id);
    const appCode = validateCode(document.app_code);
    assertPersistedTimestamp(document.created_at);
    assertPersistedTimestamp(document.updated_at);
    if (
      (document._id !== undefined &&
        document._id !== adDocumentId(document.id)) ||
      document.updated_at < document.created_at ||
      !isDeepStrictEqual(validated, persistedWrite)
    ) {
      throw new TypeError("persisted advertisement changed during validation");
    }
    return {
      id: document.id,
      appCode,
      ...validated,
      createdAt: document.created_at,
      updatedAt: document.updated_at,
    };
  } catch {
    throw new Error("application_version_invalid_document");
  }
}

function toAuditDocument(audit) {
  return {
    doc_type: "audit_event",
    schema_version: 1,
    action: audit.action,
    entity: audit.entity,
    record_id: audit.recordId,
    code: audit.code,
    credential_fingerprint: audit.credentialFingerprint,
    occurred_at: audit.occurredAt,
    source_ip: audit.sourceIp,
  };
}

function versionDocumentId(id) {
  return internalDocumentId("version-record", id);
}

function adDocumentId(id) {
  return internalDocumentId("ad-record", id);
}

function auditDocumentId(id) {
  return internalDocumentId("audit-event", id);
}

function versionKeyDocumentId(code, versionKey) {
  return internalDocumentId("version-key", `${code}\u0000${versionKey}`);
}

function internalDocumentId(kind, value) {
  // Keep stable compact internal ids while the full external id/code remain
  // fields in the record.
  return createHash("sha256")
    .update(`${kind}\u0000${value}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

async function transactionDocumentExists(reference) {
  return (await readTransactionDocument(reference)) !== null;
}

async function readTransactionDocument(reference) {
  const result = await reference.get();
  return readSingleRow(result);
}

function readSingleRow(result) {
  const rows = readRows(result);
  if (rows.length > 1) throw new Error("application_version_invalid_result");
  return rows[0] || null;
}

function readRows(result) {
  if (!result || typeof result !== "object" || result.code) {
    throw new Error("application_version_database_error");
  }
  if (Array.isArray(result.data)) return result.data;
  if (result.data && Array.isArray(result.data.list)) return result.data.list;
  if (result.data && typeof result.data === "object") return [result.data];
  if (result.data === undefined || result.data === null) return [];
  throw new Error("application_version_invalid_result");
}

function readCount(result) {
  if (
    !result ||
    typeof result !== "object" ||
    result.code ||
    !Number.isSafeInteger(result.total) ||
    result.total < 0
  ) {
    throw new Error("application_version_database_error");
  }
  return result.total;
}

function assertDocument(document, expectedType) {
  if (
    !document ||
    typeof document !== "object" ||
    document.doc_type !== expectedType ||
    document.schema_version !== 1
  ) {
    throw new Error("application_version_invalid_document");
  }
}

function assertPersistedTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError("invalid persisted timestamp");
  }
}

function conflict() {
  return new ApiError(409, "resource.conflict", "资源已存在或发生冲突");
}

function assertCodeAuthorized(authorizedCodes, code) {
  if (!(authorizedCodes instanceof Set) || !authorizedCodes.has(code)) {
    throw new ApiError(403, "auth.forbidden", "没有访问权限");
  }
}

function translateWriteError(error) {
  if (error instanceof ApiError) return error;
  const details = [
    error?.code,
    error?.errCode,
    error?.errorCode,
    error?.message,
  ]
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" ");
  if (
    /(?:^|\D)11000(?:\D|$)|duplicate|already\s+exists|database_transaction_conflict|transaction\s*conflict/i.test(
      details,
    )
  ) {
    return conflict();
  }
  return error;
}

function createDefaultCloudBaseApp(options = {}) {
  const cloudbaseModule =
    options.cloudbaseModule || require("@cloudbase/node-sdk");
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

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

module.exports = {
  COLLECTION_PATTERN,
  adDocumentId,
  auditDocumentId,
  createCloudBaseRepository,
  createDefaultCloudBaseApp,
  extractRuntimeSdkContext,
  fromAdDocument,
  fromVersionDocument,
  parseApplicationResources,
  toAdDocument,
  toAuditDocument,
  toVersionDocument,
  versionDocumentId,
  versionKeyDocumentId,
};
