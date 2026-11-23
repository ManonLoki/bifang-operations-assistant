"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  createCloudBaseWriter,
  telemetryDailyCloudPath,
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
  test("默认写入云存储而不触碰 PostgreSQL，且热实例内存去重跳过重复读写", async () => {
    const fake = createFakeStorageApp();
    const writer = createCloudBaseWriter({
      collectionName: "telemetry_bifang_tools",
      appFactory: () => fake.app,
      fetch: fake.fakeFetch,
    });

    const first = await writer(makeDoc());
    assert.deepEqual(first, { duplicate: false });
    assert.equal(fake.counts().databaseCalls, 0);
    assert.equal(fake.counts().uploadCalls, 1);

    const second = await writer(makeDoc());
    assert.deepEqual(second, { duplicate: true, cached: true });
    assert.equal(fake.counts().uploadCalls, 1);
    assert.equal(fake.counts().tempUrlCalls, 1);

    const third = await writer(
      makeDoc({
        _id: "id-install-2",
        install_id: "22222222-2222-4222-8222-222222222222",
      }),
    );
    assert.deepEqual(third, { duplicate: false });
    assert.equal(fake.counts().uploadCalls, 2);

    const stored = JSON.parse(
      fake.files.get(telemetryDailyCloudPath("bifang-tools", "2026-11-23")),
    );
    assert.deepEqual(Object.keys(stored.events).sort(), [
      "id-install-1",
      "id-install-2",
    ]);
    assert.equal(
      stored.events["id-install-1"].expires_at,
      "2026-12-23T04:00:00.000Z",
    );
  });

  test("冷实例重复写入已有 _id 时读取去重并跳过上传", async () => {
    const fake = createFakeStorageApp();
    const writerA = createCloudBaseWriter({
      collectionName: "telemetry_bifang_tools",
      appFactory: () => fake.app,
      fetch: fake.fakeFetch,
    });
    await writerA(makeDoc());

    const writerB = createCloudBaseWriter({
      collectionName: "telemetry_bifang_tools",
      appFactory: () => fake.app,
      fetch: fake.fakeFetch,
    });
    const duplicate = await writerB(makeDoc());
    assert.deepEqual(duplicate, { duplicate: true });
    assert.equal(fake.counts().uploadCalls, 1);
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
