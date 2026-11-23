# CloudBase 与真实 E2E 门禁

在阶段 2–4、6–8 读取。只复用负责人确认的现有免费环境和平台默认 HTTPS 域名。

这些阶段门禁都位于 [接入范围第一门禁](../SKILL.md#第一门禁确认接入范围) 之后。仅更新时不要求统计登记或 CloudBase 部署；仅统计时不要求 Updater 应用、Token、策略或安装验收。只对本次所选服务执行相应门禁，现有未选服务保持原状，不为通过联合校验扩大范围。

本文件中 application-version 的集合、code 和鉴权门禁只约束既有 CloudBase 历史服务；新客户端更新中心是独立服务，按 [新接入合同](client-update-center.md) 验证 APP_ID、目标、Token 和策略。客户端迁移不授权部署或删除任一服务。

## 费用红线

实施所选服务须先按 [第二门禁](integration-contract.md#第二门禁授权中心授权与配置获取) 设备授权并读取配置。读取 CloudBase 前确认 token 响应实际包含 `cloudbase:config:read`；仅统计只申请该 scope，联合接入另需实际获授 `updater:config:read`。缺权按统一合同重新授权，不能靠刷新补权限。CloudBase 返回 SecretId、SecretKey、EnvId、Region、Endpoint；密钥仅供获授权可信运维，不能分发进客户端或当日活认证。核验 Endpoint 与现有日活路由，不从 EnvId/Region 猜域名。环境/资源未部署单独交接；取得配置不授予云写入、购买或删除权限。

取得并验证配置后，还须通过 [第三门禁](integration-contract.md#第三门禁客户端接入方案与请求明细确认)：自动核验当前项目的具体 Rust 接入位置、字段来源、默认行为、变更范围和验收计划，才在原授权内实施。只核验所选服务；技术项齐备后须在回复正文展示 [完整接入确认单](integration-contract.md#客户接入确认单回复正文必填)，逐项列真实完整 URL、方法、请求头和参数、实际非敏感值/生成规则、默认依据及待补，再等待客户明确确认，不能只给记录链接。客户不用手填参数；凭据不回显。范围选择及浏览器批准不代替该确认，未确认不实施；“仅确认方案”不授权写业务代码，“确认并进入第四门禁”只有本次所选范围第三门禁整体通过后才能进入第四门禁。方案就绪不代替本地实现或真实验收，也不改变本文原有阶段授权。

第三门禁经客户明确确认后，在原授权内按 [第四门禁](integration-contract.md#第四门禁客户端本地实施与验收) 先按 [UI 方案与位置确认](integration-contract.md#先展示并确认-ui再编码) 读取当前项目风格，展示更新提示、强更和入口预览及触发/显示位置，等待客户明确确认适用 UI 后才编码；第三门禁确认不能替代 UI 确认。仅统计无可见变更时记不适用；都接入等待 UI 确认期间也不先写统计代码。编码前先执行 [项目架构与规范核验](integration-contract.md#编码前学习当前项目架构与编码规范)，读取目标项目适用指令、真实调用链及同类实现，复用现有设施并按原目录/依赖/编码规则实现，不新增客户审批。随后完成所选服务的本地实施和宿主验收，自动修复本轮失败；不重复询问自动可完成项。用假凭据、注入 transport 和临时状态验证，真实服务/GUI/安装及云端写入仍需对应授权。单项与联合分开记录，只能标本地通过，不能冒充真实接入完成。

不创建第二环境，不购买域名、证书、套餐或资源包，不开启按量超限、超限扣费或自动续费。控制台、API 或 CLI 一旦出现非零金额、升级、连续包月、资源包、自定义域名、证书购买或 EdgeOne 提示，立即停止并保留只读证据。

## 固定资源

CloudBase 后端存储默认统一使用 **CloudBase 云存储（COS）+ 热实例内存缓存**，**不再新建或访问 PostgreSQL 集合与 TTL 索引**（避免共享实例 5 分钟 CU 计费；仅当显式设置 `STORAGE_BACKEND=database` 时回退数据库）。

Telemetry 每个应用独立：

- 函数：`telemetry-<app_id>`
- 路由：`/apps/<app_id>/v1/track`
- 云存储路径：`telemetry/<app_id>/<active_date>.json`（热实例内存去重，无需 PostgreSQL 集合或 TTL 索引）

Application-version 全环境共享：

- 函数：`application-version-api`
- 路由：`/tools/version-control/v1`
- 云存储路径：每 APP_ID 独立 `version-control/<app_id>/versions.json`、`ads.json`、`audit.json`（读接口 5 分钟内存缓存，写接口强读并刷新缓存）
- 凭据绑定：`app_id + codes + scopes`

历史 PostgreSQL 集合（`telemetry_*`、`versions_*`、`ads_*`、`audit_*`）在云函数全面切到云存储后可按负责人授权直接清理释放存储占用；不删除 CloudBase 环境本身。

不存在静态更新 hosting 或现行 `/updates` 路由。旧静态资源只作为待精确退役的线上候选，不得重新生成或部署。

## 阶段 2：登记

- APP_ID、中文 `display_name` 与新更新中心目标已确认。没有真实旧发布流时运行 `npm run cloudbase:app:add -- <app_id>`，登记仅统计资源，不编造旧 code；已有旧发布流保留其真实 `(platform, architecture, channel, code)`，code 唯一且长度不超过 50。名称随 Profile 的 `derive_resources.py --profile` 输出交接，不从 APP_ID 猜名。
- `cloudbase/apps.json` 是非敏感拓扑唯一权威；凭据原值不写入登记表。
- 使用受测登记命令，一次只新增一个应用或一个发布流；不并发写文件。
- 在已获阶段 2 授权的运营精灵任务中，登记 APP_ID 和已有旧发布流后执行 `npm run cloudbase:app:name -- <app_id> "<已确认中文名>"`，写入 `cloudbase/functions/operations-dashboard/src/app-labels.json`；随后执行 `npm run cloudbase:labels:check -- --profile-file "<已校验的 Profile 交接文件>"` 和 `npm run cloudbase:config:check`。前者同时核对 Profile 的 APP_ID 已登记、名称精确一致及所有已登记应用的名称覆盖，不能只验本次工具。`cloudbase/apps.json` 继续只承载技术拓扑，不加入另一份中文名来源。
- 名称必须与 Profile 精确一致；普通版与 Plus 分别登记并保留独立 APP_ID/code，不因同名或近似名字合并。发现名称冲突时先核实产品事实，不覆盖其他工具。
- 只有名称表、登记表和检查结果齐备后，才标记 `app_display_name_registered=true`、`app_registered=true`。仅执行 APP_ID 登记或仅保存客户端 Profile 不满足名称登记。
- 本阶段只修改运营精灵本地登记、名称表与生成配置，不部署。客户端的一句话接入授权不允许自行修改运营精灵仓库。

## 阶段 3：本地计划

- `npm run cloudbase:config:check`、`npm run cloudbase:labels:check` 和完整测试通过；生成配置包含全部已登记 telemetry、共享 version 函数/路由和看板，无旧静态 hosting/route/env。核对看板应用映射及中文名覆盖完整集合；新工具接入计划列出看板需同步的名称和应用映射，不覆盖或漏掉既有工具。
- Version 部署计划输入完整只读 live-state。没有 live-state 时不得生成写步骤。
- 计划区分首次创建、已有兼容资源更新与冲突阻塞；不得用“存在”一概覆盖，也不得删除非空数据、未知索引、陌生凭据或其他应用。
- 每份客户端运行凭据只绑定一个 code 且仅有 `versions:check`；管理读取固定为独立 `versions:read + ads:read`，管理写入固定为独立 `versions:write + ads:write`。每条发布流必须有三类覆盖，全局还需恰好一份不可导出的 `contract-ads-*` 凭据执行 `ads:show` 契约测试；只显示 credential ID/fingerprint/scopes，不回显原值或摘要配置。
- dry-run/计划不得包含 `--all`、`--force`、`--prune`、顶层 deploy 或删除命令。

## 阶段 4：部署与公网 HTTP E2E

即使用户说“进入阶段 4”，真实写入前仍要展示：

- 环境 ID、确认的免费状态和平台默认域名；
- 函数、路由、六个业务集合、权限和索引；
- 三条发布流 code 与凭据绑定摘要；
- 当前 live-state、精确 create/update/preserve diff；
- 费用、回滚与明确排除项。

随后等待负责人明确“继续”。只执行已审查的精确步骤；失败后先重新读状态，不自动重试有副作用写入。

公网 E2E 覆盖十个端点、两个认证头、scope、跨 APP/code 拒绝、无/提示/强制/停止更新、空/单广告、列表/详情/写入、数字点分比较、内容消毒、429、事务和审计。测试记录不得包含 Key/Secret。

看板更新也必须在同一最终目标中明确列出并获得授权，不能因客户端接入或名称文件已修改就自动部署。只有名称代码变更且线上应用/发布流映射与本地完全一致时，可使用 `cloudbase:dashboard:code:plan` 准备仅代码更新；新增应用或发布流导致映射不一致时，该入口会拒绝，必须另行审查包含完整映射的看板配置更新，并保留现有登录哈希、已有应用及路由。

使用负责人现有登录会话核对看板接口和页面：`appIds`、`appLabels` 与完整登记清单一致，`appLabels[app_id]` 精确等于 Profile 的 `display_name`；下拉框、发布流应用名和“全部应用”的版本画像均显示中文。APP_ID/code 保持英文技术身份。覆盖所有平台/架构/渠道发布流，不能只验证 Windows 或首个应用；不能通过改数据库记录、重命名 code 或重置登录口令来修正展示。完成这些实际验证后才记录 `dashboard_display_name_verified=true`；纯本地名称修改、mock 或未登录 401 不能作为此 gate 的证据。

## 阶段 5：客户端本地迁移

本阶段按第四门禁分支验收：仅更新不新增/迁移日活，仅统计不替换/删除更新；都接入分别验收并增加隔离测试。以下 telemetry 证据仅适用于选择统计，不要求仅更新任务伪造字段。

规范 URL 一句话仅在门禁 1～3 整体通过及适用 UI 确认、架构核验完成后，授权所选范围的本地迁移与测试。第二门禁允许所选配置读取，但本地迁移不授权真实 CloudBase 业务请求。使用注入 transport 和假凭据，真实服务状态仍标 `Unverified`。

本地捕获实际序列化的 `daily_active`，验证 `app_version` 来自唯一应用版本来源且与 `sdk_version` 职责分离；更换测试版本和日期后值随之变化，同日升级不重报。证据齐备后才标记 `telemetry_app_version_verified=true`；只在 Profile 写了 `current_version` 或 SDK 示例测试通过不算宿主接入证据。

## 阶段 6：真实客户端 E2E

按 [本地通过后的配置与 EXE 测试](integration-contract.md#本地通过后更新中心配置与-exe-真实测试) 先交付客户配置清单：选择更新时提示去更新中心完成应用、版本/制品和策略；仅统计不要求更新后台。客户手动配置并告知完成后，必须先通过客户端更新接口简单预检；失败留在配置/预检步骤让客户修正，不代操作或审核管理后台。仅统计不做更新预检。适用预检与所选前置条件通过、具备具体构建/运行/真实请求授权后才进入 EXE 测试。

- 第四门禁及适用的本地迁移已通过；所选线上服务、真实运行凭据与准确测试目标已核验。仅更新不要求 CloudBase 部署/看板证据；两项都接入则两项服务均须就绪。
- 选择统计时核验适用阶段 4 公网服务与看板名称证据、`dashboard_display_name_verified=true`；本地迁移不要求提前完成这一云端验证，不为单更新伪造该字段。
- 仅在选择统计时，正常启动产生的已接受遥测 `app_version` 与安装制品版本一致，核对对应应用/平台/架构的活跃版本画像后才标记 `telemetry_app_version_online_verified=true`。原始安装标识、IP 和凭据不进回执；当日门禁已领取时等待新日，不能重置或增加生产上报。
- 构建、运行及已授权的适用安装使用准确版本；记录 EXE/APP 和安装包 SHA-256、路径、进程与窗口。
- 选择更新时，网络观测证明更新中心 POST URL、真实目标字段和 Bearer 认证存在且值遮挡，并证明不再访问该客户端旧更新协议。
- 选择更新时，验证无更新、推荐、强制、不可更新、断网/超时、下载校验、安装前复检、安装后版本及完整退出；telemetry 无回归。
- 鼠标精灵只需 Windows x64；录屏助手 Windows 与 macOS 分开，真实 Mac 未运行时保持 `Unverified`。
- DOM、mock、单元测试、编译或 HTTP 请求不能冒充原生 GUI E2E。

## 阶段 7：发布与推送

展示版本、制品哈希/签名、下载 URL、发布说明、隐私、回滚、远端状态和费用，再等待明确授权。不要因 E2E 通过自动推送或发布。

若明确授权发布正式版本，最终目标应列出更新中心的 APP_ID、版本、目标平台与安装形态、制品摘要和下载地址，并核对策略；旧看板的 application-version `code_version` 是独立历史数据，不假装由新更新中心自动同步。客户端 `app_version` 和版本检查请求不创建发布记录，也不授权赋予客户端管理写入权限。

## 阶段 8：线上旧静态资源退役

客户端 Profile 中 `legacy_client_update_removed=true` 不授权也不证明这里的线上删除。只有本节全部门禁完成并执行精确退役后，才可记录 `legacy_cloud_resources_removed=true`。

前置条件：新服务公网 E2E、两个 Windows 实际客户端新协议 E2E、最新线上完整枚举、归属判断和恢复证据均完成。

候选必须逐项来自 live inventory 与受审计 allowlist，例如：

- 网关精确路由 `/updates`；
- `updates/bifang-mouse-clicker/windows.json`；
- `updates/bifang-screen-recorder/windows.json`；
- `updates/bifang-screen-recorder/macos.json`；
- 历史 `updates/example-tool/windows.json`；
- 历史 `updates/update.schema.json`；
- live inventory 中其他对象必须先人工确认归属，未知项阻塞。

计划只输出 preview，不生成删除命令。展示每个精确对象/路由、当前哈希/元数据、为何可删、恢复材料及排除的 telemetry/version/dashboard 资源，再等待负责人明确“继续”。不使用通配符、目录级删除、`--force` 或 `--prune`，也不因配置里名为 `updates` 就删除整个 hosting 服务。

删除后重新验证：新 version API、两个 telemetry 路由和运营看板正常；旧路由不存在，已列对象返回 404。任何超出精确 allowlist 的数据删除需要新授权。

## 存量环境升级到云存储（止血与清理 PostgreSQL）

适用于已使用旧版 Skill 部署到 CloudBase（尤其是体验版 3,000 点/月环境）的存量项目。整个升级**无需修改或重新发布任何业务客户端**，所有既有接口 URL、鉴权头与响应格式保持不变。

### 1. 只读预检（不执行任何写入或删除）

使用仓库固定 CLI 登录（`./node_modules/.bin/tcb login`），先执行纯只读枚举：

- `./node_modules/.bin/tcb env list --json`：确认目标 `envId` 与套餐状态（不得创建新环境、不得升级或开启超限按量）。
- `./node_modules/.bin/tcb fn list -e <envId> --limit 100 --json`：列出全部线上云函数，重点识别历史定时清理函数（如 `cleanup-<app_id>`）以及业务函数（`telemetry-<app_id>`、`application-version-api`、`operations-dashboard-api`）。
- `./node_modules/.bin/tcb fn detail <fnName> -e <envId> --json`：核对触发器（`Triggers`，脱敏处理环境变量，不回显密钥/Token/哈希）与 `AvailableStatus`。
- `./node_modules/.bin/tcb routes list -e <envId> --limit 100 --json`：确认既有 HTTP 路由。

### 2. 展示最终目标并等待明确“继续”

向负责人逐项展示：目标 `envId`、待删除的定时触发器与 `cleanup-*` 函数名、待仅更新代码的业务云函数列表（明确承诺保留原环境变量与路由）、历史 PostgreSQL 集合是否清理（不迁移或另行导出）、以及 0 付费红线。未收到明确“继续”前不执行任何写入或删除。

### 3. 精确执行顺序

1. **立即止血（删除定时唤醒源）**：
   - `./node_modules/.bin/tcb fn trigger delete <cleanupFn> <triggerName> -e <envId> --json`
   - `./node_modules/.bin/tcb fn delete <cleanupFn> -e <envId> --json`
2. **仅更新业务云函数代码（严禁在仓库根目录直接打包，严禁覆盖线上环境变量与路由）**：
   - 必须先 `cd` 进入各云函数独立目录，再使用 `--dir . --deployMode zip` 上传，避免 CLI 误将仓库根目录打包导致 `InvalidParameter.ZipCodeFmt` 或超过 1.5MB 限制：
     - `telemetry-<app_id>`：在 `cloudbase/functions/telemetry` 目录执行 `../../../node_modules/.bin/tcb fn code update telemetry-<app_id> --dir . --deployMode zip -e <envId> --json`
     - `application-version-api`：在 `cloudbase/functions/application-version-api` 目录执行 `../../../node_modules/.bin/tcb fn code update application-version-api --dir . --deployMode zip -e <envId> --json`
     - `operations-dashboard-api`：在 `cloudbase/functions/operations-dashboard` 目录执行 `../../../node_modules/.bin/tcb fn code update operations-dashboard-api --dir . --deployMode zip -e <envId> --json`
3. **清理历史 PostgreSQL 表（按负责人授权，不销毁环境）**：
   - 历史数据不迁移时，仅清理已确认归属的旧业务集合/表（`telemetry_*`、`versions_*`、`ads_*`、`audit_*`）以释放存储占用；**绝不销毁整个 CloudBase 环境**。
   - 若实例当前已因额度耗尽处于 `Isolated` 状态（本身 0 CU 消耗），跳过 SQL 清理并如实回报，待下周期额度恢复后按需在控制台清理即可。
4. **更新后只读复核**：
   - 重新运行 `tcb fn list` 与 `tcb routes list`，确认 `cleanup-*` 已消失、全部业务函数状态为 `Deployment completed` 且原有路由完整保留。

## 绝不删除

- CloudBase 环境本身（切勿为清理 PostgreSQL 而销毁环境）；
- `telemetry-*` 云函数、`/apps/<app_id>/v1/track` 路由及云存储 `telemetry/<app_id>/` 数据；
- `application-version-api`、单层 `/tools/version-control/v1` 路由及云存储 `version-control/<app_id>/` 数据；
- `operations-dashboard-api`、`/admin/v1/metrics` 与 `/dashboard` 路由；
- 其他应用或未知归属资源（历史 PostgreSQL 集合仅在完成云存储切换并获负责人明确授权后方可精确清理）。
