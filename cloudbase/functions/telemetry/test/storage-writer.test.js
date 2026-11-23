"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  createCloudBaseWriter,
  selectTelemetryShard,
  telemetryManifestCloudPath,
  telemetryShardCloudPath,
} = require("../src/writer");

function createFakeStorageApp() {
  const files = new Map();
  let uploadCalls = 0;
  let tempUrlCalls = 0;
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
      files.set(cloudPath, fileContent.toString("utf8"));
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
        return files.get(cloudPath);
      },
    };
  }

  return {
    app,
    fakeFetch,
    files,
    counts: () => ({ uploadCalls, tempUrlCalls, databaseCalls }),
  };
}

function makeDoc(overrides = {}) {
  return {
    _id: "id-install-1",
    schema_version: 2,
    event: "daily_active",
    app_id: "bifang-tools",
    app_version: "1.0.0",
    install_id: "11111111-1111-4111-8111-111111111111",
    platform: "windows",
    arch: "x64",
    active_date: "2026-11-23",
    received_at: "2026-11-23T04:00:00.000Z",
    expires_at: new Date("2026-12-23T04:00:00.000Z"),
    source_ip: "203.0.113.10",
    ...overrides,
  };
}

describe("telemetry CloudBase cloud storage writer", () => {
  test("默认按分片写入云存储而不触碰 PostgreSQL，且热实例内存去重跳过重复读写", async () => {
    const fake = createFakeStorageApp();
    const writer = createCloudBaseWriter({
      collectionName: "telemetry_bifang_tools",
      appFactory: () => fake.app,
      fetch: fake.fakeFetch,
      shardCount: 16,
    });

    const first = await writer(makeDoc());
    assert.deepEqual(first, { duplicate: false });
    assert.equal(fake.counts().databaseCalls, 0);
    // 首次写入：1 次分片上传 + 1 次当日 manifest.json 上传
    assert.equal(fake.counts().uploadCalls, 2);

    const second = await writer(makeDoc());
    assert.deepEqual(second, { duplicate: true, cached: true });
    assert.equal(fake.counts().uploadCalls, 2);
    assert.equal(fake.counts().tempUrlCalls, 1);

    const third = await writer(
      makeDoc({
        _id: "id-install-2",
        install_id: "22222222-2222-4222-8222-222222222222",
      }),
    );
    assert.deepEqual(third, { duplicate: false });
    // manifest 每天每实例只写一次，因此仅增加 1 次分片上传
    assert.equal(fake.counts().uploadCalls, 3);

    const manifest = JSON.parse(
      fake.files.get(telemetryManifestCloudPath("bifang-tools", "2026-11-23")),
    );
    assert.equal(manifest.shard_count, 16);

    const shard1Path = telemetryShardCloudPath(
      "bifang-tools",
      "2026-11-23",
      selectTelemetryShard("id-install-1", 16),
    );
    const shard2Path = telemetryShardCloudPath(
      "bifang-tools",
      "2026-11-23",
      selectTelemetryShard("id-install-2", 16),
    );
    const stored1 = JSON.parse(fake.files.get(shard1Path));
    const stored2 = JSON.parse(fake.files.get(shard2Path));
    assert.equal(
      stored1.events["id-install-1"].expires_at,
      "2026-12-23T04:00:00.000Z",
    );
    assert.ok(stored2.events["id-install-2"]);
  });

  test("同实例并发写入同一分片时排队批合并，零覆盖丢失", async () => {
    const fake = createFakeStorageApp();
    const writer = createCloudBaseWriter({
      collectionName: "telemetry_bifang_tools",
      appFactory: () => fake.app,
      fetch: fake.fakeFetch,
      shardCount: 1,
    });

    const docs = Array.from({ length: 12 }, (_, index) =>
      makeDoc({
        _id: `concurrent-id-${index}`,
        install_id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      }),
    );

    const results = await Promise.all(docs.map((doc) => writer(doc)));
    assert.ok(results.every((item) => item.duplicate === false));

    const shardPath = telemetryShardCloudPath("bifang-tools", "2026-11-23", 0);
    const stored = JSON.parse(fake.files.get(shardPath));
    assert.equal(Object.keys(stored.events).length, 12);
    // 12 次并发合并为极少次数上传（远小于 12 次 + 1 次 manifest）
    assert.ok(fake.counts().uploadCalls <= 4);
  });

  test("跨实例偶发覆盖后，原实例后续写入同一分片可通过内存并集自愈", async () => {
    const fake = createFakeStorageApp();
    const writer = createCloudBaseWriter({
      collectionName: "telemetry_bifang_tools",
      appFactory: () => fake.app,
      fetch: fake.fakeFetch,
      shardCount: 1,
    });

    await writer(makeDoc({ _id: "id-a" }));
    // 模拟另一个并发实例误将远端分片覆盖为只剩 id-b
    const shardPath = telemetryShardCloudPath("bifang-tools", "2026-11-23", 0);
    fake.files.set(
      shardPath,
      JSON.stringify({
        schema_version: 2,
        app_id: "bifang-tools",
        active_date: "2026-11-23",
        shard: 0,
        shard_count: 1,
        events: {
          "id-b": makeDoc({
            _id: "id-b",
            expires_at: "2026-12-23T04:00:00.000Z",
          }),
        },
      }),
    );

    await writer(makeDoc({ _id: "id-c" }));
    const stored = JSON.parse(fake.files.get(shardPath));
    assert.deepEqual(Object.keys(stored.events).sort(), [
      "id-a",
      "id-b",
      "id-c",
    ]);
  });

  test("云存储短暂上传失败时自动短退避重试成功", async () => {
    const fake = createFakeStorageApp();
    let failedOnce = false;
    const originalUpload = fake.app.uploadFile.bind(fake.app);
    fake.app.uploadFile = async (params) => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("transient_network_error");
      }
      return originalUpload(params);
    };

    const writer = createCloudBaseWriter({
      collectionName: "telemetry_bifang_tools",
      appFactory: () => fake.app,
      fetch: fake.fakeFetch,
      retryAttempts: 2,
      retryBaseDelayMs: 1,
      sleep: async () => {},
    });

    const result = await writer(makeDoc());
    assert.deepEqual(result, { duplicate: false });
    assert.equal(failedOnce, true);
  });

  test("冷实例重复写入已有 _id 时读取去重并跳过上传", async () => {
    const fake = createFakeStorageApp();
    const writerA = createCloudBaseWriter({
      collectionName: "telemetry_bifang_tools",
      appFactory: () => fake.app,
      fetch: fake.fakeFetch,
    });
    await writerA(makeDoc());
    const uploadsAfterFirst = fake.counts().uploadCalls;

    const writerB = createCloudBaseWriter({
      collectionName: "telemetry_bifang_tools",
      appFactory: () => fake.app,
      fetch: fake.fakeFetch,
    });
    const duplicate = await writerB(makeDoc());
    assert.deepEqual(duplicate, { duplicate: true });
    assert.equal(fake.counts().uploadCalls, uploadsAfterFirst);
  });

  test("显式 STORAGE_BACKEND=database 时回退到数据库集合写入", async () => {
    const added = [];
    const writer = createCloudBaseWriter({
      collectionName: "telemetry_bifang_tools",
      storageBackend: "database",
      appFactory: () => ({
        uploadFile() {
          throw new Error("should_not_use_storage");
        },
        getTempFileURL() {
          throw new Error("should_not_use_storage");
        },
        database() {
          return {
            collection() {
              return {
                async add(doc) {
                  added.push(doc);
                },
              };
            },
          };
        },
      }),
    });

    const result = await writer(makeDoc());
    assert.deepEqual(result, { duplicate: false });
    assert.equal(added.length, 1);
  });
});
