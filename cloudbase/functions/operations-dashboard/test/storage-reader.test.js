"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");

const { createHandler } = require("../src/handler");
const { createCloudBaseEventReader } = require("../src/reader");
const {
  createCloudBaseVersionReader,
  emptyReleaseSummary,
} = require("../src/version-reader");

const APPS = [
  {
    appId: "bifang-tools",
    collectionName: "telemetry_bifang_tools",
    versionCollection: "versions_bifang_tools",
    platforms: ["windows"],
    releaseStreams: [
      {
        platform: "windows",
        architecture: "x64",
        channel: "stable",
        code: "bifang-tools-windows-x64",
      },
    ],
  },
];

function createFakeStorageApp(initialFiles) {
  const files = new Map(Object.entries(initialFiles));
  let tempUrlCalls = 0;
  let fetchCalls = 0;
  let uploadCalls = 0;
  let databaseCalls = 0;
  const prefix = "cloud://test-env.bucket-123/";

  const app = {
    database() {
      databaseCalls += 1;
      throw new Error("should_not_touch_database");
    },
    async getUploadMetadata({ cloudPath }) {
      return { data: { fileId: `${prefix}${cloudPath}` } };
    },
    async uploadFile({ cloudPath, fileContent }) {
      uploadCalls += 1;
      files.set(cloudPath, JSON.parse(fileContent.toString("utf8")));
      return { fileID: `${prefix}${cloudPath}` };
    },
    async getTempFileURL({ fileList }) {
      tempUrlCalls += 1;
      return {
        fileList: fileList.map((fileID) => {
          const cloudPath = fileID.slice(prefix.length);
          if (!files.has(cloudPath)) {
            return { fileID, code: "STORAGE_FILE_NONEXIST" };
          }
          return {
            fileID,
            code: "SUCCESS",
            tempFileURL: `https://storage.example.test/${encodeURIComponent(cloudPath)}`,
          };
        }),
      };
    },
  };

  async function fakeFetch(url) {
    fetchCalls += 1;
    const cloudPath = decodeURIComponent(
      url.replace("https://storage.example.test/", ""),
    );
    if (!files.has(cloudPath)) {
      return {
        status: 404,
        ok: false,
        async text() {
          return "";
        },
      };
    }
    return {
      status: 200,
      ok: true,
      async text() {
        return JSON.stringify(files.get(cloudPath));
      },
    };
  }

  return {
    app,
    fakeFetch,
    files,
    counts: () => ({ tempUrlCalls, fetchCalls, uploadCalls, databaseCalls }),
  };
}

test("运营看板事件与版本读取器默认批量读取云存储，且缓存历史日期文件", async () => {
  const fake = createFakeStorageApp({
    "telemetry/bifang-tools/2026-11-22.json": {
      schema_version: 1,
      app_id: "bifang-tools",
      active_date: "2026-11-22",
      events: {
        "evt-1": {
          _id: "evt-1",
          schema_version: 2,
          event: "daily_active",
          app_id: "bifang-tools",
          app_version: "1.0.0",
          install_id: "11111111-1111-4111-8111-111111111111",
          platform: "windows",
          arch: "x64",
          active_date: "2026-11-22",
          received_at: "2026-11-22T03:00:00.000Z",
        },
      },
    },
    "telemetry/bifang-tools/2026-11-23.json": {
      schema_version: 1,
      app_id: "bifang-tools",
      active_date: "2026-11-23",
      events: {
        "evt-2": {
          _id: "evt-2",
          schema_version: 2,
          event: "daily_active",
          app_id: "bifang-tools",
          app_version: "1.1.0",
          install_id: "22222222-2222-4222-8222-222222222222",
          platform: "windows",
          arch: "x64",
          active_date: "2026-11-23",
          received_at: "2026-11-23T03:00:00.000Z",
        },
      },
    },
    "version-control/bifang-tools/versions.json": {
      schema_version: 1,
      app_id: "bifang-tools",
      records: [
        {
          id: "1001",
          code: "bifang-tools-windows-x64",
          codeVersion: "1.1.0",
          forcedUpdate: false,
          promptUpdate: true,
          stopUpdate: false,
          updatedAt: "2026-11-23T02:00:00.000Z",
        },
      ],
    },
  });

  const readEvents = createCloudBaseEventReader({
    appFactory: () => fake.app,
    fetch: fake.fakeFetch,
    nowMs: () => Date.parse("2026-11-23T04:00:00.000Z"),
  });
  const readVersions = createCloudBaseVersionReader({
    appFactory: () => fake.app,
    fetch: fake.fakeFetch,
  });

  const eventsFirst = await readEvents({
    apps: APPS,
    startDate: "2026-11-22",
    endDate: "2026-11-23",
    receivedBefore: "2026-11-23T04:00:00.000Z",
  });
  assert.equal(eventsFirst.length, 2);
  assert.equal(fake.counts().fetchCalls, 2);

  // 第二次读取时 2026-11-22 命中历史缓存，仅重新拉取当天 2026-11-23
  const eventsSecond = await readEvents({
    apps: APPS,
    startDate: "2026-11-22",
    endDate: "2026-11-23",
    receivedBefore: "2026-11-23T04:00:00.000Z",
  });
  assert.equal(eventsSecond.length, 2);
  assert.equal(fake.counts().fetchCalls, 3);

  const versions = await readVersions({ apps: APPS });
  assert.equal(versions.length, 1);
  assert.equal(versions[0].highestVersion, "1.1.0");
  assert.equal(versions[0].status, "prompt");
  assert.equal(fake.counts().databaseCalls, 0);
});

test("看板 handler 在启用短缓存时 60 秒内复用聚合快照", async () => {
  const token = "dashboard-cache-token-with-at-least-32-characters";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  let readerCalls = 0;
  let now = new Date("2026-11-23T04:00:00.000Z");

  const handler = createHandler({
    environmentId: "test-env",
    path: "/admin/v1/metrics",
    tokenHash,
    apps: APPS,
    cacheTtlMs: 60_000,
    now: () => now,
    reader: async () => {
      readerCalls += 1;
      return [];
    },
    versionReader: async () => [
      emptyReleaseSummary(APPS[0], APPS[0].releaseStreams[0]),
    ],
  });

  const req = {
    httpMethod: "GET",
    path: "/admin/v1/metrics",
    headers: { Authorization: `Bearer ${token}` },
  };
  assert.equal((await handler(req)).statusCode, 200);
  assert.equal((await handler(req)).statusCode, 200);
  assert.equal(readerCalls, 1);

  now = new Date("2026-11-23T04:01:05.000Z");
  assert.equal((await handler(req)).statusCode, 200);
  assert.equal(readerCalls, 2);
});

test("看板读取器合并过渡期单文件与分片文件，并对历史天执行惰性归档", async () => {
  const fake = createFakeStorageApp({
    // 2026-11-22 历史天：既有旧单文件 evt-legacy，又有新分片 evt-shard-0 / evt-shard-2
    "telemetry/bifang-tools/2026-11-22.json": {
      schema_version: 1,
      app_id: "bifang-tools",
      active_date: "2026-11-22",
      events: {
        "evt-legacy": {
          _id: "evt-legacy",
          schema_version: 2,
          event: "daily_active",
          app_id: "bifang-tools",
          app_version: "1.0.0",
          install_id: "11111111-1111-4111-8111-111111111111",
          platform: "windows",
          arch: "x64",
          active_date: "2026-11-22",
          received_at: "2026-11-22T02:00:00.000Z",
        },
      },
    },
    "telemetry/bifang-tools/2026-11-22/manifest.json": {
      schema_version: 2,
      app_id: "bifang-tools",
      active_date: "2026-11-22",
      shard_count: 4,
    },
    "telemetry/bifang-tools/2026-11-22/shard-00.json": {
      schema_version: 2,
      app_id: "bifang-tools",
      active_date: "2026-11-22",
      shard: 0,
      shard_count: 4,
      events: {
        "evt-shard-0": {
          _id: "evt-shard-0",
          schema_version: 2,
          event: "daily_active",
          app_id: "bifang-tools",
          app_version: "1.0.0",
          install_id: "22222222-2222-4222-8222-222222222222",
          platform: "windows",
          arch: "x64",
          active_date: "2026-11-22",
          received_at: "2026-11-22T05:00:00.000Z",
        },
      },
    },
    "telemetry/bifang-tools/2026-11-22/shard-02.json": {
      schema_version: 2,
      app_id: "bifang-tools",
      active_date: "2026-11-22",
      shard: 2,
      shard_count: 4,
      events: {
        "evt-shard-2": {
          _id: "evt-shard-2",
          schema_version: 2,
          event: "daily_active",
          app_id: "bifang-tools",
          app_version: "1.0.1",
          install_id: "33333333-3333-4333-8333-333333333333",
          platform: "macos",
          arch: "arm64",
          active_date: "2026-11-22",
          received_at: "2026-11-22T08:00:00.000Z",
        },
      },
    },
    // 2026-11-23 当天：仅分片存在，不应触发归档
    "telemetry/bifang-tools/2026-11-23/manifest.json": {
      schema_version: 2,
      app_id: "bifang-tools",
      active_date: "2026-11-23",
      shard_count: 4,
    },
    "telemetry/bifang-tools/2026-11-23/shard-01.json": {
      schema_version: 2,
      app_id: "bifang-tools",
      active_date: "2026-11-23",
      shard: 1,
      shard_count: 4,
      events: {
        "evt-today": {
          _id: "evt-today",
          schema_version: 2,
          event: "daily_active",
          app_id: "bifang-tools",
          app_version: "1.1.0",
          install_id: "44444444-4444-4444-8444-444444444444",
          platform: "windows",
          arch: "x64",
          active_date: "2026-11-23",
          received_at: "2026-11-23T03:00:00.000Z",
        },
      },
    },
  });

  const readerFirst = createCloudBaseEventReader({
    appFactory: () => fake.app,
    fetch: fake.fakeFetch,
    nowMs: () => Date.parse("2026-11-23T04:00:00.000Z"),
  });

  const events = await readerFirst({
    apps: APPS,
    startDate: "2026-11-22",
    endDate: "2026-11-23",
    receivedBefore: "2026-11-23T04:00:00.000Z",
  });
  assert.deepEqual(events.map((item) => item._id).sort(), [
    "evt-legacy",
    "evt-shard-0",
    "evt-shard-2",
    "evt-today",
  ]);
  // 历史天 2026-11-22 已被惰性归档回单文件，当天 2026-11-23 不归档
  assert.equal(fake.counts().uploadCalls, 1);
  const compacted = fake.files.get("telemetry/bifang-tools/2026-11-22.json");
  assert.equal(compacted.compacted, true);
  assert.deepEqual(Object.keys(compacted.events).sort(), [
    "evt-legacy",
    "evt-shard-0",
    "evt-shard-2",
  ]);
  assert.equal(fake.files.has("telemetry/bifang-tools/2026-11-23.json"), false);

  // 冷启动新 reader 实例（无内存缓存）读取历史天时，直接命中 compacted 单文件，仅 1 次 fetch
  const fetchBeforeColdRead = fake.counts().fetchCalls;
  const coldReader = createCloudBaseEventReader({
    appFactory: () => fake.app,
    fetch: fake.fakeFetch,
    nowMs: () => Date.parse("2026-11-23T05:00:00.000Z"),
  });
  const historyOnly = await coldReader({
    apps: APPS,
    startDate: "2026-11-22",
    endDate: "2026-11-23",
    receivedBefore: "2026-11-23T05:00:00.000Z",
  });
  assert.equal(historyOnly.length, 4);
  // 仅 fetch 了：2026-11-22.json (1) + 2026-11-23/manifest.json (1) + 2026-11-23/shard-01.json (1) = 3 次
  assert.equal(fake.counts().fetchCalls - fetchBeforeColdRead, 3);
  assert.equal(fake.counts().uploadCalls, 1);
});
