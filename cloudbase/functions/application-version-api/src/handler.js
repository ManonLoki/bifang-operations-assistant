"use strict";

const { randomBytes, randomInt } = require("node:crypto");
const { isIP } = require("node:net");

const {
  authenticate,
  authorize,
  findHeader,
  parseCredentials,
} = require("./auth");
const {
  ApiError,
  emptyResponse,
  errorResponse,
  jsonResponse,
} = require("./errors");
const { createRateLimiter } = require("./rate-limit");
const {
  createCloudBaseRepository,
  parseApplicationResources,
} = require("./repository");
const {
  decodePathSegment,
  invalidRequest,
  parseListQuery,
  validateAdCreate,
  validateAdId,
  validateAdUpdate,
  validateCode,
  validateVersion,
  validateVersionId,
  validateVersionWrite,
} = require("./validation");
const {
  createVersionCheckResponse,
  selectHighestVersion,
} = require("./version");

const DEFAULT_BASE_PATH = "/tools/version-control/v1";
const MAX_BODY_BYTES = 65_536;

const ROUTES = [
  { name: "versions", pattern: /^\/versions$/, methods: ["GET", "POST"] },
  {
    name: "version-check",
    pattern: /^\/versions\/([^/]+)\/([^/]+)$/,
    methods: ["GET"],
  },
  {
    name: "version-item",
    pattern: /^\/versions\/([^/]+)$/,
    methods: ["PUT"],
  },
  {
    name: "ad-show",
    pattern: /^\/app\/([^/]+)\/ads\/show$/,
    methods: ["GET"],
  },
  {
    name: "ad-list",
    pattern: /^\/app\/([^/]+)\/ads$/,
    methods: ["GET", "POST"],
  },
  {
    name: "ad-item",
    pattern: /^\/app\/([^/]+)\/ads\/([^/]+)$/,
    methods: ["PUT", "DELETE"],
  },
  {
    name: "ad-detail",
    pattern: /^\/app\/ads\/([^/]+)$/,
    methods: ["GET"],
  },
];

function createHandler(options = {}) {
  const basePath = normalizeBasePath(
    options.basePath === undefined
      ? process.env.APPLICATION_VERSION_API_PATH || DEFAULT_BASE_PATH
      : options.basePath,
  );
  const applications = parseApplicationResources(
    options.applications === undefined
      ? process.env.APPLICATION_VERSION_APPS_JSON
      : options.applications,
  );
  const credentials = parseCredentials(
    options.credentials === undefined
      ? process.env.APPLICATION_VERSION_CREDENTIALS_B64
      : options.credentials,
    applications?.map(({ appId }) => appId) || [],
  );
  const fixedRepository = options.repository;
  const sharedReadCache = options.readCache || new Map();
  const repositoryFactory =
    options.repositoryFactory ||
    ((runtimeContext) =>
      createCloudBaseRepository({
        resources: applications,
        runtimeContext,
        cache: sharedReadCache,
      }));
  const checkRate = options.rateLimiter || createRateLimiter();
  const now = options.now || (() => new Date());
  const idGenerator = options.idGenerator || createNumericId;
  const auditIdGenerator =
    options.auditIdGenerator || (() => randomBytes(16).toString("hex"));
  const logger = options.logger || console;

  return async function applicationVersionApiHandler(event = {}, context = {}) {
    try {
      if (!basePath || !applications || !credentials) {
        throw new ApiError(500, "server.unavailable", "服务暂时不可用");
      }
      const request = extractRequest(event, context);
      const route = matchRoute(request.path, request.method, basePath);
      if (!route) {
        throw new ApiError(404, "resource.not_found", "资源不存在");
      }
      if (!route.methodAllowed) {
        throw new ApiError(
          405,
          "request.method_not_allowed",
          "请求方法不受支持",
          {
            headers: { Allow: route.allowedMethods.join(", ") },
          },
        );
      }

      const principal = authenticate(request.headers, credentials);
      const sourceIp = extractTrustedSourceIp(event, context);
      const rate = checkRate(
        `${principal.fingerprint}:${sourceIp || "unknown"}:${request.method}:${route.name}`,
      );
      if (!rate.allowed) {
        throw new ApiError(429, "rate.limit_exceeded", "请求过于频繁", {
          headers: { "Retry-After": String(rate.retryAfterSeconds) },
        });
      }

      const currentTime = now();
      if (
        !(currentTime instanceof Date) ||
        Number.isNaN(currentTime.getTime())
      ) {
        throw new Error("invalid_server_clock");
      }
      const repository = fixedRepository || repositoryFactory(context);
      return await dispatch({
        auditIdGenerator,
        currentTime,
        idGenerator,
        principal,
        repository,
        request,
        route,
        sourceIp,
      });
    } catch (error) {
      return errorResponse(error, logger);
    }
  };
}

async function dispatch(input) {
  const {
    auditIdGenerator,
    currentTime,
    idGenerator,
    principal,
    repository,
    request,
    route,
    sourceIp,
  } = input;
  const occurredAt = currentTime.toISOString();
  const makeAudit = (action, entity, recordId, code) => ({
    id: auditIdGenerator(),
    action,
    entity,
    recordId,
    code,
    credentialFingerprint: principal.fingerprint,
    occurredAt,
    sourceIp,
  });

  if (route.name === "versions" && request.method === "POST") {
    authorize(principal, "versions:write");
    assertNoQuery(request.url);
    const body = validateVersionWrite(parseJsonBody(request));
    authorize(principal, "versions:write", body.code);
    const id = validateVersionId(idGenerator("version", currentTime));
    const record = {
      ...body,
      id,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };
    await repository.createVersion(
      principal.appId,
      record,
      makeAudit("create", "version", id, body.code),
    );
    return emptyResponse();
  }

  if (route.name === "versions" && request.method === "GET") {
    authorize(principal, "versions:read");
    const pagination = parseListQuery(request.url, { maxPage: 100 });
    const result = await repository.listVersions(
      principal.appId,
      principal.codes,
      pagination,
    );
    return jsonResponse(
      200,
      createGrid(
        result.records.map(toVersionListRecord),
        result.totalRecords,
        pagination,
      ),
    );
  }

  if (route.name === "version-item") {
    authorize(principal, "versions:write");
    assertNoQuery(request.url);
    const id = decodePathSegment(route.params[0], validateVersionId);
    const body = validateVersionWrite(parseJsonBody(request));
    authorize(principal, "versions:write", body.code);
    const updated = await repository.updateVersion(
      principal.appId,
      id,
      { ...body, id, updatedAt: occurredAt },
      makeAudit("update", "version", id, body.code),
      principal.codes,
    );
    if (!updated) throw notFound();
    return emptyResponse();
  }

  if (route.name === "version-check") {
    authorize(principal, "versions:check");
    assertNoQuery(request.url);
    const code = decodePathSegment(route.params[0], validateCode);
    const currentVersion = decodePathSegment(route.params[1], validateVersion);
    authorize(principal, "versions:check", code);
    const selected = selectHighestVersion(
      await repository.listVersionsForCode(principal.appId, code),
    );
    if (!selected) throw notFound();
    return jsonResponse(
      200,
      createVersionCheckResponse(selected, currentVersion),
    );
  }

  if (route.name === "ad-list" && request.method === "POST") {
    authorize(principal, "ads:write");
    assertNoQuery(request.url);
    const code = decodePathSegment(route.params[0], validateCode);
    authorize(principal, "ads:write", code);
    const body = validateAdCreate(parseJsonBody(request));
    const id = validateAdId(idGenerator("ad", currentTime));
    const record = {
      ...body,
      id,
      appCode: code,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };
    await repository.createAd(
      principal.appId,
      record,
      makeAudit("create", "ad", id, code),
    );
    return emptyResponse();
  }

  if (route.name === "ad-list" && request.method === "GET") {
    authorize(principal, "ads:read");
    const code = decodePathSegment(route.params[0], validateCode);
    authorize(principal, "ads:read", code);
    const pagination = parseListQuery(request.url, {
      maxPage: 10_000,
      allowSearch: true,
    });
    const result = await repository.listAds(principal.appId, code, pagination);
    return jsonResponse(
      200,
      createGrid(
        result.records.map(toAdListItem),
        result.totalRecords,
        pagination,
      ),
    );
  }

  if (route.name === "ad-item" && request.method === "PUT") {
    authorize(principal, "ads:write");
    assertNoQuery(request.url);
    const code = decodePathSegment(route.params[0], validateCode);
    const id = decodePathSegment(route.params[1], validateAdId);
    authorize(principal, "ads:write", code);
    const changes = validateAdUpdate(parseJsonBody(request));
    const updated = await repository.updateAd(
      principal.appId,
      code,
      id,
      { ...changes, updatedAt: occurredAt },
      makeAudit("update", "ad", id, code),
    );
    if (!updated) throw notFound();
    return emptyResponse();
  }

  if (route.name === "ad-item" && request.method === "DELETE") {
    authorize(principal, "ads:write");
    assertNoQuery(request.url);
    const code = decodePathSegment(route.params[0], validateCode);
    const id = decodePathSegment(route.params[1], validateAdId);
    authorize(principal, "ads:write", code);
    const deleted = await repository.deleteAd(
      principal.appId,
      code,
      id,
      makeAudit("delete", "ad", id, code),
    );
    if (!deleted) throw notFound();
    return emptyResponse();
  }

  if (route.name === "ad-detail") {
    authorize(principal, "ads:read");
    assertNoQuery(request.url);
    const id = decodePathSegment(route.params[0], validateAdId);
    const record = await repository.getAd(principal.appId, id);
    if (!record) throw notFound();
    authorize(principal, "ads:read", record.appCode);
    return jsonResponse(200, toAdDetail(record));
  }

  if (route.name === "ad-show") {
    authorize(principal, "ads:show");
    assertNoQuery(request.url);
    const code = decodePathSegment(route.params[0], validateCode);
    authorize(principal, "ads:show", code);
    const records = await repository.showAds(principal.appId, code);
    return jsonResponse(200, records.map(toAdShowItem));
  }

  throw notFound();
}

function matchRoute(path, method, basePath) {
  if (path !== basePath && !path.startsWith(`${basePath}/`)) return null;
  const relative = path.slice(basePath.length) || "/";
  for (const definition of ROUTES) {
    const match = definition.pattern.exec(relative);
    if (!match) continue;
    return {
      name: definition.name,
      params: match.slice(1),
      methodAllowed: definition.methods.includes(method),
      allowedMethods: definition.methods,
    };
  }
  return null;
}

function extractRequest(event, context) {
  const safeEvent = event && typeof event === "object" ? event : {};
  const safeContext = context && typeof context === "object" ? context : {};
  const requestHttp = safeEvent.requestContext?.http || {};
  const functionHttp = safeContext.httpContext || {};
  const method = firstString(
    safeEvent.httpMethod,
    safeEvent.method,
    requestHttp.method,
    functionHttp.httpMethod,
    functionHttp.method,
  );
  let url =
    firstString(
      safeEvent.url,
      safeEvent.rawPath,
      safeEvent.path,
      requestHttp.path,
      functionHttp.url,
      functionHttp.path,
    ) || "";
  if (!url.includes("?")) {
    const rawQuery = firstString(
      safeEvent.rawQueryString,
      functionHttp.rawQueryString,
    );
    if (rawQuery) url += `?${rawQuery}`;
    else {
      const query =
        safeEvent.multiValueQueryStringParameters ||
        safeEvent.queryStringParameters ||
        functionHttp.multiValueQueryStringParameters ||
        functionHttp.queryStringParameters;
      if (query && typeof query === "object" && !Array.isArray(query)) {
        const parameters = new URLSearchParams();
        for (const [key, values] of Object.entries(query)) {
          for (const value of Array.isArray(values) ? values : [values]) {
            if (typeof value === "string") parameters.append(key, value);
          }
        }
        const encoded = parameters.toString();
        if (encoded) url += `?${encoded}`;
      }
    }
  }
  return {
    method: method ? method.toUpperCase() : "",
    path: normalizeRequestPath(url),
    url,
    headers:
      safeEvent.headers || safeEvent.header || functionHttp.headers || {},
    body: safeEvent.body,
    isBase64Encoded: safeEvent.isBase64Encoded === true,
  };
}

function parseJsonBody(request) {
  const contentType = findHeader(request.headers, "content-type");
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.trim()) ||
    typeof request.body !== "string"
  ) {
    throw invalidRequest("请求体必须是 UTF-8 JSON");
  }
  let bytes;
  if (request.isBase64Encoded) {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        request.body,
      )
    ) {
      throw invalidRequest("请求体编码不合法");
    }
    bytes = Buffer.from(request.body, "base64");
  } else {
    bytes = Buffer.from(request.body, "utf8");
  }
  if (bytes.length < 2 || bytes.length > MAX_BODY_BYTES) {
    throw invalidRequest("请求体大小不合法");
  }
  try {
    if (request.isBase64Encoded && bytes.toString("base64") !== request.body) {
      throw new TypeError("non_canonical_base64");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw invalidRequest("请求体不是合法 JSON");
  }
}

function assertNoQuery(urlValue) {
  let url;
  try {
    url = new URL(urlValue || "/", "https://version-api.invalid");
  } catch {
    throw invalidRequest("查询参数不合法");
  }
  if ([...url.searchParams.keys()].length > 0) {
    throw invalidRequest("该接口不接受查询参数");
  }
}

function createGrid(records, totalRecords, pagination) {
  const totalPages = Math.ceil(totalRecords / pagination.size);
  return {
    model: "grid.result",
    result: {
      model: "data.set",
      datas: records,
      total: totalRecords,
    },
    page: {
      model: "page",
      current: pagination.page,
      total: totalPages,
      size: pagination.size,
      total_page: totalPages,
    },
  };
}

function toVersionListRecord(record) {
  const output = {
    id: record.id,
    name: record.name,
    code: record.code,
    codeVersion: record.codeVersion,
    downloadUrl: record.downloadUrl,
    promptContent: record.promptContent,
    forcedUpdate: record.forcedUpdate,
    promptUpdate: record.promptUpdate,
    stopUpdate: record.stopUpdate,
    updateContent: record.updateContent,
  };
  if (record.updateCriteria !== undefined) {
    output.updateCriteria = record.updateCriteria;
    output.versionCriteria = record.versionCriteria;
  }
  return output;
}

function toAdDetail(record) {
  return {
    id: record.id,
    appCode: record.appCode,
    title: record.title,
    url: record.url,
    image: record.image,
    content: record.content,
  };
}

function toAdListItem(record) {
  return {
    id: record.id,
    appCode: record.appCode,
    title: record.title,
    url: record.url,
    image: record.image,
  };
}

function toAdShowItem(record) {
  return {
    id: record.id,
    url: record.url,
    image: record.image,
    content: record.content,
  };
}

function createNumericId() {
  const timestamp = (BigInt(Date.now()) % 10_000_000_000_000n)
    .toString()
    .padStart(13, "0");
  return `${timestamp}${String(randomInt(1_000_000)).padStart(6, "0")}`;
}

function extractTrustedSourceIp(event, context) {
  const safeEvent = event && typeof event === "object" ? event : {};
  const safeContext = context && typeof context === "object" ? context : {};
  const requestContext = safeEvent.requestContext || {};
  const requestHttp = requestContext.http || {};
  const functionHttp = safeContext.httpContext || {};
  for (const candidate of [
    requestHttp.sourceIp,
    requestContext.sourceIp,
    functionHttp.sourceIp,
    functionHttp.clientIp,
  ]) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (isIP(normalized) !== 0) return normalized;
  }
  return null;
}

function normalizeBasePath(value) {
  return typeof value === "string" &&
    value === DEFAULT_BASE_PATH &&
    !value.includes("/v1/v1")
    ? value
    : null;
}

function normalizeRequestPath(value) {
  try {
    return new URL(value, "https://version-api.invalid").pathname;
  } catch {
    return "";
  }
}

function notFound() {
  return new ApiError(404, "resource.not_found", "资源不存在");
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

module.exports = {
  DEFAULT_BASE_PATH,
  MAX_BODY_BYTES,
  createGrid,
  createHandler,
  createNumericId,
  extractRequest,
  extractTrustedSourceIp,
  matchRoute,
  parseJsonBody,
  toAdDetail,
  toAdListItem,
  toAdShowItem,
  toVersionListRecord,
};
