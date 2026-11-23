"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createCloudBaseRepository } = require("../src/repository");

const APP_A = "bifang-mouse-clicker";
const RESOURCES = [
  {
    appId: APP_A,
    versionCollection: "versions_bifang_mouse_clicker",
    adCollection: "ads_bifang_mouse_clicker",
    auditCollection: "audit_bifang_mouse_clicker",
  },
];

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

function versionRecord(overrides = {}) {
  return {
    id: "2001178408904765440",
    name: "测试版本",
    code: "bifang-mouse-clicker",
    codeVersion: "1.2.0",
    versionKey: "1.2",
    downloadUrl: "https://downloads.example.com/app-1.2.0.exe",
    promptContent: "修复若干问题",
    forcedUpdate: false,
    promptUpdate: true,
    stopUpdate: false,
    updateContent: "本次更新内容",
    createdAt: "2026-11-23T04:00:00.000Z",
    updatedAt: "2026-11-23T04:00:00.000Z",
    ...overrides,
  };
}

function adRecord(overrides = {}) {
  return {
    id: "8001178408904765440",
    appCode: "bifang-mouse-clicker",
    content: "<p>公告</p>",
    createdAt: "2026-11-23T04:00:00.000Z",
    updatedAt: "2026-11-23T04:00:00.000Z",
    ...overrides,
  };
}

test("默认使用云存储承载版本与广告读写，且命中实例级读缓存不触碰 PostgreSQL", async () => {
  const fake = createFakeStorageApp();
  const sharedCache = new Map();
  let currentMs = Date.parse("2026-11-23T04:00:00.000Z");

  const repository = createCloudBaseRepository({
    resources: RESOURCES,
    appFactory: () => fake.app,
    cache: sharedCache,
    cacheTtlMs: 300_000,
    fetch: fake.fakeFetch,
    now: () => currentMs,
  });

  await repository.createVersion(APP_A, versionRecord(), {
    id: "audit-1",
    action: "create",
    entity: "version",
    recordId: "2001178408904765440",
    code: "bifang-mouse-clicker",
    occurredAt: "2026-11-23T04:00:00.000Z",
  });

  const beforeReadCalls = fake.counts().tempUrlCalls;
  const firstRead = await repository.listVersionsForCode(
    APP_A,
    "bifang-mouse-clicker",
  );
  const secondRead = await repository.listVersionsForCode(
    APP_A,
    "bifang-mouse-clicker",
  );

  assert.equal(firstRead.length, 1);
  assert.deepEqual(secondRead, firstRead);
  assert.equal(fake.counts().tempUrlCalls, beforeReadCalls);
  assert.equal(fake.counts().databaseCalls, 0);

  // 同 code + 同 versionKey 必须返回 409 冲突
  await assert.rejects(
    repository.createVersion(
      APP_A,
      versionRecord({ id: "2001178408904765441" }),
      { id: "audit-dup" },
    ),
    (error) => error.statusCode === 409,
  );

  // 更新版本后缓存立即刷新
  const updated = await repository.updateVersion(
    APP_A,
    "2001178408904765440",
    versionRecord({ codeVersion: "1.3.0", versionKey: "1.3" }),
    { id: "audit-2" },
    new Set(["bifang-mouse-clicker"]),
  );
  assert.equal(updated.codeVersion, "1.3.0");
  const afterUpdate = await repository.listVersionsForCode(
    APP_A,
    "bifang-mouse-clicker",
  );
  assert.equal(afterUpdate[0].codeVersion, "1.3.0");

  // 广告增删改查走云存储
  await repository.createAd(APP_A, adRecord(), { id: "audit-ad-1" });
  assert.equal(
    (await repository.showAds(APP_A, "bifang-mouse-clicker")).length,
    1,
  );
  const deleted = await repository.deleteAd(
    APP_A,
    "bifang-mouse-clicker",
    adRecord().id,
    { id: "audit-ad-2" },
  );
  assert.equal(deleted.id, adRecord().id);
  assert.equal(
    (await repository.showAds(APP_A, "bifang-mouse-clicker")).length,
    0,
  );

  // 缓存过期后重新从云存储拉取
  currentMs += 301_000;
  const beforeExpiredRead = fake.counts().tempUrlCalls;
  await repository.listVersionsForCode(APP_A, "bifang-mouse-clicker");
  assert.equal(fake.counts().tempUrlCalls, beforeExpiredRead + 1);
});
