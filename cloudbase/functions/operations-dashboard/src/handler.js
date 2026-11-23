"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const { safeDiagnostic } = require("./diagnostics");

const {
  addDays,
  createDashboardSnapshot,
  toShanghaiDate,
} = require("./aggregate");
const { createCloudBaseEventReader } = require("./reader");
const { createCloudBaseVersionReader } = require("./version-reader");
const { createDashboardWebHandler } = require("./web");

const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const COLLECTION_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;
const CHANNEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const RELEASE_STREAM_KEYS = "architecture,channel,code,platform";
const RELEASE_PLATFORMS = ["windows", "macos", "linux"];
const RELEASE_ARCHITECTURES = ["x64", "arm64", "ia32"];
const DASHBOARD_APPLICATION_MAPPING_SCHEMA_VERSION = 2;

function createHandler(options = {}) {
  const adminPath = normalizePathValue(
    options.path === undefined ? process.env.DASHBOARD_PATH : options.path,
  );
  const webPath = normalizePathValue(
    options.webPath === undefined
      ? process.env.DASHBOARD_WEB_PATH || "/dashboard"
      : options.webPath,
  );
  const tokenHash = normalizeTokenHash(
    options.tokenHash === undefined
      ? process.env.DASHBOARD_TOKEN_SHA256
      : options.tokenHash,
  );
  const accessTokenHash = normalizeTokenHash(
    options.accessTokenHash === undefined
      ? process.env.DASHBOARD_ACCESS_TOKEN_SHA256
      : options.accessTokenHash,
  );
  const apps = parseDashboardApps(
    options.apps === undefined ? process.env.DASHBOARD_APPS_JSON : options.apps,
  );
  const readEvents = options.reader || createCloudBaseEventReader();
  const readReleaseStreams =
    options.versionReader || createCloudBaseVersionReader();
  const now = options.now || (() => new Date());
  const logger = options.logger || console;
  const snapshotCache = options.snapshotCache || new Map();
  const defaultCacheTtlMs =
    options.reader || options.versionReader ? 0 : 60 * 1000;
  const snapshotCacheTtlMs = resolveSnapshotCacheTtlMs(
    options.cacheTtlMs,
    defaultCacheTtlMs,
  );
  const environmentId = normalizeEnvironmentId(
    options.environmentId === undefined
      ? process.env.CLOUDBASE_ENV_ID ||
          process.env.TCB_ENV ||
          process.env.SCF_NAMESPACE
      : options.environmentId,
  );

  async function handleMetrics(request, context) {
    if (!apps.length || !environmentId) {
      return jsonResponse(503, { error: "metrics_unavailable" });
    }
    const query = parseQuery(request.url, request.querySources);
    if (!query.ok) return jsonResponse(400, { error: "invalid_query" });
    if (
      query.appId !== "all" &&
      !apps.some((app) => app.appId === query.appId)
    ) {
      return jsonResponse(400, { error: "invalid_query" });
    }

    try {
      const currentTime = now();
      if (
        !(currentTime instanceof Date) ||
        Number.isNaN(currentTime.getTime())
      ) {
        throw new Error("invalid_server_clock");
      }
      const cacheKey = `${query.appId}:${query.days}`;
      if (snapshotCacheTtlMs > 0) {
        const cached = snapshotCache.get(cacheKey);
        if (
          cached &&
          currentTime.getTime() - cached.cachedAt < snapshotCacheTtlMs
        ) {
          return jsonResponse(200, cached.snapshot);
        }
      }
      const selectedApps =
        query.appId === "all"
          ? apps
          : apps.filter((app) => app.appId === query.appId);
      const [events, releaseSummaries] = await Promise.all([
        readEvents({
          apps: selectedApps,
          startDate: addDays(toShanghaiDate(currentTime), -29),
          endDate: toShanghaiDate(currentTime),
          receivedBefore: currentTime.toISOString(),
          // Only the platform-supplied second argument is trusted for identity.
          runtimeContext: context,
        }),
        readReleaseStreams({ apps: selectedApps, runtimeContext: context }),
      ]);
      const snapshot = createDashboardSnapshot({
        apps,
        days: query.days,
        environmentId,
        events,
        releaseSummaries,
        now: currentTime,
        selectedAppId: query.appId,
      });
      if (snapshotCacheTtlMs > 0) {
        snapshotCache.set(cacheKey, {
          cachedAt: currentTime.getTime(),
          snapshot,
        });
      }
      return jsonResponse(200, snapshot);
    } catch (error) {
      if (logger && typeof logger.error === "function") {
        try {
          logger.error(
            "operations_dashboard_query_failed",
            safeDiagnostic(error),
          );
        } catch {
          // Diagnostic logging must not affect the response.
        }
      }
      return jsonResponse(503, { error: "metrics_unavailable" });
    }
  }

  const handleWebRequest = createDashboardWebHandler({
    webPath,
    accessTokenHash,
    handleMetrics,
    now,
    loginAttempts: options.loginAttempts,
    publicDirectory: options.publicDirectory,
    randomBytes: options.randomBytes,
    readFile: options.readFile,
  });

  return async function operationsDashboardHandler(event = {}, context = {}) {
    const request = extractRequest(event, context);
    if (request.path === adminPath) {
      if (request.method !== "GET") {
        return jsonResponse(
          405,
          { error: "method_not_allowed" },
          { Allow: "GET" },
        );
      }
      if (!isAuthorized(request.headers, tokenHash)) {
        return jsonResponse(
          401,
          { error: "unauthorized" },
          { "WWW-Authenticate": "Bearer" },
        );
      }
      return handleMetrics(request, context);
    }
    return (
      (await handleWebRequest(request, context)) ||
      jsonResponse(404, { error: "not_found" })
    );
  };
}

function resolveSnapshotCacheTtlMs(override, fallback) {
  const raw =
    override === undefined ? process.env.DASHBOARD_CACHE_TTL_MS : override;
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseDashboardApps(value) {
  let parsed = value;
  // CloudBase CLI 3.8.1 revives JSON-shaped strings into objects. A JSON-encoded
  // string survives that parser as a string; accept at most that extra layer.
  for (let depth = 0; depth < 2 && typeof parsed === "string"; depth += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  parsed = expandCompactDashboardApps(parsed);
  if (!Array.isArray(parsed)) return [];
  const apps = [];
  for (const item of parsed) {
    const expectedKeys =
      "appId,collectionName,platforms,releaseStreams,versionCollection";
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(",") !== expectedKeys ||
      typeof item.appId !== "string" ||
      !APP_ID_PATTERN.test(item.appId) ||
      typeof item.collectionName !== "string" ||
      !COLLECTION_PATTERN.test(item.collectionName) ||
      item.collectionName !== `telemetry_${item.appId.replaceAll("-", "_")}` ||
      typeof item.versionCollection !== "string" ||
      !COLLECTION_PATTERN.test(item.versionCollection) ||
      item.versionCollection !==
        `versions_${item.appId.replaceAll("-", "_")}` ||
      !Array.isArray(item.platforms) ||
      item.platforms.some(
        (platform) => !RELEASE_PLATFORMS.includes(platform),
      ) ||
      new Set(item.platforms).size !== item.platforms.length ||
      !Array.isArray(item.releaseStreams) ||
      item.releaseStreams.length > 12
    ) {
      return [];
    }
    const releaseStreams = [];
    for (const stream of item.releaseStreams) {
      if (
        !stream ||
        typeof stream !== "object" ||
        Array.isArray(stream) ||
        Object.keys(stream).sort().join(",") !== RELEASE_STREAM_KEYS ||
        !RELEASE_PLATFORMS.includes(stream.platform) ||
        !RELEASE_ARCHITECTURES.includes(stream.architecture) ||
        typeof stream.channel !== "string" ||
        !CHANNEL_PATTERN.test(stream.channel) ||
        typeof stream.code !== "string" ||
        !APP_ID_PATTERN.test(stream.code)
      ) {
        return [];
      }
      releaseStreams.push({
        platform: stream.platform,
        architecture: stream.architecture,
        channel: stream.channel,
        code: stream.code,
      });
    }
    const expectedPlatforms = RELEASE_PLATFORMS.filter((platform) =>
      releaseStreams.some((stream) => stream.platform === platform),
    );
    if (
      JSON.stringify(item.platforms) !== JSON.stringify(expectedPlatforms) ||
      new Set(releaseStreams.map((stream) => stream.code)).size !==
        releaseStreams.length ||
      new Set(
        releaseStreams.map(
          (stream) =>
            `${stream.platform}\u0000${stream.architecture}\u0000${stream.channel}`,
        ),
      ).size !== releaseStreams.length
    ) {
      return [];
    }
    apps.push({
      appId: item.appId,
      collectionName: item.collectionName,
      versionCollection: item.versionCollection,
      platforms: [...item.platforms],
      releaseStreams,
    });
  }
  const allCodes = apps.flatMap((app) =>
    app.releaseStreams.map((stream) => stream.code),
  );
  return new Set(apps.map((app) => app.appId)).size === apps.length &&
    new Set(apps.map((app) => app.collectionName)).size === apps.length &&
    new Set(apps.map((app) => app.versionCollection)).size === apps.length &&
    new Set(allCodes).size === allCodes.length
    ? apps
    : [];
}

function expandCompactDashboardApps(value) {
  if (Array.isArray(value)) return value;
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "apps,schema_version" ||
    value.schema_version !== DASHBOARD_APPLICATION_MAPPING_SCHEMA_VERSION ||
    !Array.isArray(value.apps) ||
    value.apps.length === 0 ||
    value.apps.length > 100
  ) {
    return null;
  }
  const apps = [];
  for (const entry of value.apps) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      !APP_ID_PATTERN.test(entry[0]) ||
      !Array.isArray(entry[1]) ||
      entry[1].length > 12
    ) {
      return null;
    }
    const releaseStreams = [];
    for (const stream of entry[1]) {
      if (!Array.isArray(stream) || stream.length !== 4) return null;
      const [platform, architecture, channel, code] = stream;
      releaseStreams.push({ platform, architecture, channel, code });
    }
    const appId = entry[0];
    apps.push({
      appId,
      collectionName: `telemetry_${appId.replaceAll("-", "_")}`,
      versionCollection: `versions_${appId.replaceAll("-", "_")}`,
      platforms: RELEASE_PLATFORMS.filter((platform) =>
        releaseStreams.some((stream) => stream.platform === platform),
      ),
      releaseStreams,
    });
  }
  return apps;
}

function isAuthorized(headers, expectedHash) {
  if (!expectedHash) return false;
  const header = findHeader(headers, "authorization");
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length);
  if (token.length < 32 || token.length > 256) return false;
  const actual = createHash("sha256").update(token, "utf8").digest();
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeTokenHash(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function normalizeEnvironmentId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized !== "current" &&
    /^[a-z0-9][a-z0-9-]{0,127}$/.test(normalized)
    ? normalized
    : null;
}

function normalizePathValue(value) {
  return typeof value === "string" && /^\/[a-z0-9._/-]+$/.test(value)
    ? value
    : null;
}

function parseQuery(urlValue, querySources = []) {
  let url;
  try {
    url = new URL(urlValue || "/", "https://dashboard.invalid");
  } catch {
    return { ok: false };
  }
  const values = new Map();
  for (const source of [url.searchParams, ...querySources]) {
    if (source === undefined || source === null || source === "") continue;
    let entries;
    if (source instanceof URLSearchParams || typeof source === "string") {
      entries = [...new URLSearchParams(source).entries()];
    } else if (typeof source === "object" && !Array.isArray(source)) {
      entries = Object.entries(source).map(([key, value]) => [
        key,
        Array.isArray(value) && value.length === 1 ? value[0] : value,
      ]);
    } else return { ok: false };
    const seen = new Set();
    for (const [key, value] of entries) {
      if (
        !["app_id", "days"].includes(key) ||
        typeof value !== "string" ||
        seen.has(key) ||
        value === "" ||
        (values.has(key) && values.get(key) !== value)
      )
        return { ok: false };
      seen.add(key);
      values.set(key, value);
    }
  }
  const daysText = values.get("days") || "14";
  const appId = values.get("app_id") || "all";
  if (!["7", "14", "30"].includes(daysText)) return { ok: false };
  if (appId !== "all" && !APP_ID_PATTERN.test(appId)) return { ok: false };
  return { ok: true, days: Number(daysText), appId };
}

function extractRequest(event, context) {
  const safeEvent = event && typeof event === "object" ? event : {};
  const safeContext = context && typeof context === "object" ? context : {};
  const requestContext = safeEvent.requestContext || {};
  const requestHttp = safeEvent.requestContext?.http || {};
  const functionHttp = safeContext.httpContext || {};
  const method = firstString(
    safeEvent.httpMethod,
    safeEvent.method,
    requestHttp.method,
    functionHttp.httpMethod,
    functionHttp.method,
  );
  const url =
    firstString(
      safeEvent.url,
      safeEvent.rawPath,
      safeEvent.path,
      requestHttp.path,
      functionHttp.url,
      functionHttp.path,
    ) || "";
  return {
    method: method ? method.toUpperCase() : "",
    path: normalizeRequestPath(url),
    url,
    // API Gateway may keep path query-free and put the query in these fields.
    // Merge equivalent representations, but reject ambiguous or duplicate values.
    querySources: [
      safeEvent.rawQueryString,
      safeEvent.multiValueQueryStringParameters,
      safeEvent.queryStringParameters,
      functionHttp.rawQueryString,
      functionHttp.multiValueQueryStringParameters,
      functionHttp.queryStringParameters,
    ],
    headers:
      safeEvent.headers || safeEvent.header || functionHttp.headers || {},
    body: safeEvent.body === undefined ? functionHttp.body : safeEvent.body,
    isBase64Encoded:
      safeEvent.isBase64Encoded === true ||
      functionHttp.isBase64Encoded === true,
    // Never trust X-Forwarded-For supplied by the caller. Only use the
    // platform-populated request/runtime context for best-effort login limits.
    sourceIp: firstString(
      requestContext.identity?.sourceIp,
      requestContext.sourceIp,
      requestHttp.sourceIp,
      functionHttp.sourceIp,
      safeContext.sourceIp,
    ),
  };
}

function normalizeRequestPath(value) {
  try {
    return new URL(value, "https://dashboard.invalid").pathname;
  } catch {
    return "";
  }
}

function findHeader(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  const matches = Object.entries(headers).filter(
    ([key]) => key.toLowerCase() === name,
  );
  if (matches.length !== 1) return undefined;
  const value = matches[0][1];
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      Vary: "Authorization",
      ...extraHeaders,
    },
    isBase64Encoded: false,
    body: JSON.stringify(body),
  };
}

module.exports = {
  createHandler,
  extractRequest,
  isAuthorized,
  normalizeTokenHash,
  parseDashboardApps,
  parseQuery,
};
