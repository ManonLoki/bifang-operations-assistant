---
name: bifang-public-services-onboarding
description: Confirm updates, daily-active telemetry, or both, then obtain selected service configuration through authorization-center device authorization. Present full selected-service request URLs, headers and parameters for explicit customer confirmation then preview project-matched update UI and trigger locations for customer approval then study the target architecture and coding conventions before implementing and validating the Rust integration locally within authorization, infer project facts and use documented defaults instead of customer parameter forms; hand off manual update-center configuration, preflight the client update API after customer completion, then run authorized real EXE tests only after preflight passes; keep deployment, installation, publishing, and deletion separately authorized.
metadata:
  version: "2.1.5"
  infrastructure-version: "3.0.0"
  infrastructure-source-commit: "37f6dd120f082b8514a461bcfa30cee35b6259a6"
  application-version-contract-version: "1.0.0"
  application-version-baseline-commit: "92b0c599a42c3a094c99787e6928c30c2d2ea3af"
  source-repository: "bifang-operations-assistant"
  canonical-repository-url: "https://github.com/BFTools3666/bifang-operations-assistant.git"
---

# 毕方公共服务接入向导

按第一门禁确认的范围接入毕方基础设施 `3.0.0`：统计使用 `daily_active`（CloudBase 云函数默认写 **CloudBase 云存储 COS + 热实例内存去重**，不再创建或访问 PostgreSQL 集合与 TTL 索引，避免 5 分钟 CU 计费）；更新支持继续使用 **CloudBase `/tools/version-control/v1`**（底层同样默认走云存储 + 5 分钟内存缓存，**不强制要求 `https://update.meetelf.com`**），也可在明确启用独立更新中心时按 `client-update-center-v1` POST 协议接入。只有选择更新且获授权时，才删除旧静态 `/updates` 清单实现；**不再强制删除正在使用的 CloudBase `application-version-api` 客户端实现**，也不改动未选择的服务。已接入的旧客户端随服务端云函数部署即可无感切到云存储，无需改客户端代码。

若用户只要求整理规范、参数或 Skill，维护文档与必要契约校验，不运行真实 OAuth/配置请求或业务实施。先读 [统一接入契约](references/integration-contract.md) 的授权中心设备流程、精确配置字段、默认值及日活合同，再读 [Updater 完整合同](references/client-update-center.md)。配置查询 OAuth 已定义，不能与下游 ClientToken 或更新快照期限混淆；真实生产入口、客户端登记和 Endpoint 语义按部署资料核验，不要求客户补填已定义协议。

## 门禁总顺序

门禁必须按本次已选范围严格串行：1 范围确认 → 2 授权/配置验证 → 3 完整请求明细确认 → 4A UI 确认 → 4B 架构/规范核验 → 4C 编码 → 4D 本地验收。前一步未通过，不进入下一步；两项都接入须当前门禁两项全部通过，不能让成功分支先跨门禁。仅统计无可见 UI 变更只豁免 4A 的人工确认并记录依据，其他检查点不省略。每次转入下一步先核验证据；缺项/未回复/过期不算通过，复用有效证据不重复问。门禁状态写脱敏交接记录，不添加 Profile 字段；旧运维阶段或脚本成功不能代替此链。完整信息、通过条件和回退规则见 [门禁总表](references/integration-contract.md#门禁顺序与放行总表)。

## 第一门禁：确认接入范围

这是接入任务的第一个硬门禁，先于来源验证、bootstrap/Skill 安装、项目扫描、索取接口参数、Profile 写入与代码修改。整理规范本身不触发客户接入问答。

首次收到“接入更新”“接入统计”“接入更新和统计”或“帮我接入”，必须先问：

> 请确认本次接入范围：仅更新、仅统计，还是更新和统计都接入？

- 只提更新时，明确询问是否也接入统计；只提统计时，明确询问是否也接入更新。
- 初始请求同时提到两项，也先用此问题确认本次范围；不能用 URL 请求或默认提示词直接判定门禁通过。
- 必须等待用户明确选择。未回答、含糊回答或预选选项都不算确认；不要在等待时继续后续接入步骤。
- 用户已经回答过本次范围门禁时复用该结果，不重复问；之后只按用户明确修改的新范围推进。
- 在本次交接记录中保存选择与用户确认依据，不把它虚构成配置接口字段或现有 Profile 未定义的字段。

| 确认选择         | 执行范围                                             | 不包含的工作                                                       |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| 仅更新           | Updater 配置、检测、提示、下载/安装适配和相应验证    | 不新增或迁移统计，不索取统计参数、不登记统计资源；已有日活保持原状 |
| 仅统计           | CloudBase daily_active 配置、身份/每日门禁和相应验证 | 不新增或迁移更新，不索取更新 Token/策略，不删除旧更新实现          |
| 更新和统计都接入 | 两项分别接入、分别验收                               | 不自动获得部署、安装、发布、推送或删除线上资源授权                 |

后续所有参数、阶段和完成标准按此表裁剪。未选择不等于缺失，不为了填齐联合模板要求用户接入另一项。

## 第二门禁：授权中心授权与配置获取

第一门禁后，验证来源并只读识别项目，按 [授权中心完整合同](references/integration-contract.md#授权中心协议与配置字段) 申请/复用 OAuth 授权，实际读取所选配置。客户只在必要时通过浏览器登录、改密/风险确认和批准；不再要求逐项填写或确认技术参数清单，已有有效且权限足够的授权直接复用。

| 范围   | 配置请求                                                         | 响应与后续                                                                                                             |
| ------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 仅更新 | GET /updater/{project_id}/config                                 | 顶层 Endpoint、ClientToken；核对下游端点/令牌要求，合并项目真实目标与默认值，再接入更新，不读取统计配置                |
| 仅统计 | GET /cloudbase/{project_id}/config                               | 顶层 SecretId、SecretKey、EnvId、Region、Endpoint；核验日活路由，密钥仅用于已授权运维，不进客户端/上报，不读取更新配置 |
| 都接入 | 同一实际获授两个配置 scope 的有效 access_token 分别 GET 上述接口 | 两个裸响应分别验证、凭据分离；一项失败不冒充联合成功                                                                   |

默认 project_id=bifang_tools、scope 按范围取 updater:config:read、cloudbase:config:read 或两者以单个空格连接、超时 10 秒；本地已登记客户端为 woskill，无 client_secret。真实生产 API/授权页地址与客户端登记从可信部署资料取得，不能拿本机 127.0.0.1 或占位 API_HOST 当通用地址。版本、系统、程序架构、安装形态从项目/运行环境识别；无既有发布通道的新稳定流默认 stable，无例外离线策略默认 service-default，无已实现下载能力默认 capabilities=[]，无可靠语言来源省略 locale。协议常量、UUID/时间戳自动生成；已有产品事实优先，不能默认虚构身份、安装能力或服务地址。

先核对 token 响应的实际 scope：少勾选则停止缺权分支，多勾选也不扩展第一门禁范围。旧 ip:read 不能查配置；403 insufficient_scope 需重新授权，刷新默认省略 scope 并延续实际获授集合，不能补权限。

通过证据是具有所需权限的有效授权、所选 GET 返回 200 且字段完整、端点/凭据用途匹配、项目事实可确定，不是用户口头确认配置。仅无法自动解决的真实部署地址、登记、身份冲突或 Endpoint 语义才向运维/用户询问必要缺项。OAuth access_token、Updater ClientToken、CloudBase SecretId/SecretKey 不混用，不打印响应，不让客户贴密钥。

配置合同已取得，不再整体标待补；实际服务未部署/配置未录入/端点未能核验分别报告。未通过分支在第二门禁修复，已验证分支只保留当前证据；所选配置未全部验证通过，不进入第三门禁。此门禁允许为接入进行上述授权和只读配置获取，不自动授权下游写测试数据、云部署、安装或发布；仅整理规范时不运行真实授权。

## 第三门禁：客户端接入方案与请求明细确认

所选分支通过第二门禁后，按 [第三门禁完整清单](references/integration-contract.md#第三门禁客户端接入方案与请求明细确认) 自动核验具体 Rust 接入点、字段来源、运行行为、迁移范围和验收计划。复用已知项目事实、有依据默认值及有效配置，不让客户再次填技术表或确认笼统“是否继续”。

| 范围   | 核验重点与默认行为                                                                                                                                                                                            | 通过条件与后续                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 仅更新 | 请求字段来源、Rust 凭据/检查入口、调度/提示/强更解除/退出、实际能力与旧更新替换清单。无既有通道的新稳定流用 stable，无例外离线策略用 service-default，无已实现下载能力 capabilities=[]，无语言来源省略 locale | 来源和接入点明确、能力声明真实、迁移与验收计划完整；再按原授权实施 Rust 检查/UI/能力、旧更新替换及本地验证；统计不变   |
| 仅统计 | 真实日活路由、十字段、应用隔离状态、后台启动入口、UUID v4 及联网前原子每日门禁。固定 schema_version=2、event=daily_active、sdk_version=3.0.0；Asia/Shanghai 同日最多尝试一次，失败不补发                      | 字段、身份/状态存储、并发保护、失败和隐私方案明确，管理密钥不进入客户端；再实施 Rust 日活及本地去重/版本验证；更新不变 |
| 都接入 | 分别完成以上两项，再核验共享版本/平台映射、保留已有身份、凭据/状态隔离、独立调度、部分失败和联合验收                                                                                                          | 两项第二门禁、两套方案及联合核验均通过才标联合就绪；两项当前门禁未全部通过不得进入下一门禁，不允许单分支先实施         |

必须按 [客户接入确认单](references/integration-contract.md#客户接入确认单回复正文必填) 在回复正文展示所选服务、实际完整请求 URL、方法、请求头、路径/query/body 各字段的必填性、实际非敏感值或运行时生成规则及来源，逐项写明默认值、待补与真实验证状态；都接入完整列两份，不能只给记录链接。凭据仅显示获取/校验状态及用途，不回显原值、部分值或摘要。尚未实施写“拟接入／方案待确认”。再交付非敏感实施清单，列具体文件/入口、来源、已有与拟新增能力、默认值依据、变更范围、测试预期及线上依赖。无目标代码证据不虚构路径；拟新增能力验证前不向下游声明已实现。上述表格是技术核验条件，第三门禁还必须等待客户对完整明细明确确认，不能自动通过。确认问题为“请确认以上所选服务的请求地址、参数和实施方案：①确认并进入第四门禁；②仅确认方案，暂不实施；③需要调整”。有问答工具时先在正文展示完整明细再用工具提问，无工具则在回复结尾提问。第一门禁选择、浏览器批准及配置 200 均不代替此次确认；未回答不能实施。只确认方案不授权实施，已有只读限制须明确要求实施才解除；已覆盖相同本地动作的授权可复用。客户确认与范围/授权依据记入交接记录；方案、地址、固定参数或能力实质变更重新确认受影响项，未变化不重复问。此门禁不代替代码、测试或真实接入证据，也不新增未定义 Profile 字段。

只有无法自动解决的身份/名称冲突、运行目标不明或无默认规则的产品行为变更才问最少必要问题。已知待登记/部署/发布在目标及合同明确时另列线上依赖；关键配置/映射未知则停止依赖分支。它不等同于 CloudBase 运维“阶段 3”，不扩大当前阶段授权；仅整理规范仍不写业务代码、不运行真实接口。

## 第四门禁：客户端本地实施与验收

所选范围的第二、第三门禁整体通过且已有当前客户端实施授权后，按 [第四门禁完整清单](references/integration-contract.md#第四门禁客户端本地实施与验收) 先按 [UI 方案与位置确认](references/integration-contract.md#先展示并确认-ui再编码) 完成设计展示，取得适用 UI 的客户确认后，再自动编码、修复本轮问题并本地验收。第四门禁先做 UI 方案与位置确认，再编码：选择更新时读取当前项目页面、组件和样式，展示普通更新提示、强制更新界面及手动检查入口的可见预览，列清启动/定时/手动/安装前触发点、实际显示位置、按钮/关闭行为和新业务限制范围。必须等待客户明确确认 UI；第三门禁确认不替代本次确认，等待时不写业务代码，都接入也不先实施统计。UI 确认后先学习项目架构与规范，再按已有授权编码和本地验收，不再问是否开始。仅统计默认无打扰，没有可见 UI 变更则记 UI 确认不适用；若改应用内隐私界面则先预览确认。复用现有风格，强更仅按有效 block_new_operations 限制新业务，保留已有任务和更新/重试/退出。仅整理规范/方案的任务不执行业务代码。

编码前必须执行 [项目架构与编码规范核验](references/integration-contract.md#编码前学习当前项目架构与编码规范)。适用 UI 确认后，编码前必须先阅读目标项目及修改目录的 AGENTS.md、架构/编码约定、真实模块调用链和同类实现，明确复用组件、HTTP/配置/状态/错误/日志/异步机制及验证命令；简短报告有代码依据的落实摘要后直接编码，不新增确认门禁。保持现有架构和前端栈，Rust 实现可信服务职责，遵守目录、依赖方向、命名及测试规则，不套服务端模板或重构无关代码。

| 范围   | 实施顺序                                                                                                                                                          | 本地通过条件                                                                                                                                  | 仍需单独授权                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 仅更新 | 风格取证/更新 UI 与位置预览 → 客户确认 UI → 架构/规范核验 → Rust 配置/请求/身份 → 决定与 UI/强更/退出 → 按方案实现人工升级或下载/安装适配 → 旧更新清理 → 宿主验收 | 实际序列化字段和认证正确，能力声明真实，错误/离线/解除行为正确；适用的大小/摘要及 pre_install 目标校验通过，扫描/代码复核无遗漏，既有统计不变 | 真实检查/制品下载、制品构建/打包/签名/实际安装、原生 GUI E2E、更新后台写入、发布/推送/线上删除 |
| 仅统计 | 日活路由 → UUID v4/隔离状态 → 原子每日门禁 → 十字段 → 后台上报/隐私说明 → 宿主验收                                                                                | 实际请求和应用版本来源正确，Asia/Shanghai 同日/并发最多尝试一次，失败/429 不补发，新日恢复，升级保留身份及门禁，管理密钥不入客户端，更新不变  | 运营仓库登记、CloudBase 部署、真实日活/看板验收、制品构建/打包/签名/安装、发布/推送/线上删除   |
| 都接入 | 先共同确认适用 UI → 分别实施两项 → 分项验收 → 版本/架构/身份/状态/调度/凭据隔离与部分失败验证                                                                     | 两项及联合隔离全部通过；单项失败可独立修复，不能冒充联合通过或擅自减范围                                                                      | 以上两类操作的并集，不因选择两项自动获得额外权限                                               |

本地测试默认假凭据、注入 transport、固定时钟、临时状态和本地 fixture，自动运行相关格式/静态检查、测试所需编译、单元及宿主集成测试，不访问真实业务服务、不重置生产日活状态。测试所需编译不等于客户端制品构建或安装；本地安装替身不证明真实安装，DOM/mock 不证明原生 GUI E2E。

输出脱敏本地验收记录：实际文件/入口、请求与状态证据、检查命令和结果、未执行/受限项、能力与平台限制、分项/联合结论及线上待办。只允许标记“本地实施通过”，不能把 Profile、SDK 测试或编译成功单独当接入完成。单服务 Profile 工具限制如实记录，不填假参数，不增加未定义状态字段。

复用已有同目标同动作的阶段授权；第二门禁配置读取权限不覆盖下游业务 E2E。需另获授权的步骤先准备具体目标、计划和预检，仍遵守部署/发布/推送/删除的最终确认及费用红线。本门禁不等于 CloudBase 运维阶段 4，原阶段 5 本地迁移按此分支清单验收。

## 本地通过后的配置与 EXE 测试

第 5 步只提示客户到更新中心自行手动配置，并交付已有项目参数；不代操作或审核管理后台。提示中说明客户告知完成后会做限定的简单更新接口预检：真实地址与 ClientToken、HTTP 201、响应合同、目标版本/平台/通道及预期更新行为；不下载、安装或运行 EXE。预检失败由客户调整后再告知重检，通过后才进入第 6 步，按具体授权构建/运行 EXE 并进行真实验收。仅统计跳过更新中心及更新预检；都接入先过更新预检，统计真实上报留 EXE 测试。完整交接、就绪条件与验收见 [后续流程](references/integration-contract.md#本地通过后更新中心配置与-exe-真实测试)。

## 一句话入口

以下请求是本 Skill 的规范入口：

```text
https://github.com/BFTools3666/bifang-operations-assistant.git 帮我接入
```

这句话先触发第一门禁；用户确认范围后，才授权在**当前客户端仓库**获取并验证权威仓库、安装/更新本 Skill、只读扫描和记录所选服务的非敏感事实。按第二门禁进行必要设备授权/所选配置读取，再通过第三门禁方案与请求明细确认后，才进入第四门禁，在原授权内实施该服务及本地验收；旧更新替换/删除仅适用于选择更新的任务。它不授权 CloudBase 写入或删除、客户端打包/安装、真实 GUI E2E、发布、推送、购买或修改其他项目。

若用户显式调用 `$bifang-public-services-onboarding`，也先过范围门禁，再按用户指定阶段执行；若没有指定阶段，先做所选范围的只读检查与方案，并交付完整接入确认单、提出第三门禁确认问题；客户选择“确认并进入第四门禁”即进入第四门禁的 UI 展示/确认及后续本地实施流程，不要求客户另输阶段编号。门禁通过后不要求用户再次输入 Skill 名称或重复确认同一范围；仍严格遵守上述本地边界。

阶段按顺序分别执行，每次只推进一个已获授权阶段；不得把本地授权扩展为运营仓库写入、服务部署或安装发布授权。

## 验证权威来源

先保存当前客户端根目录，再定位毕方运营精灵权威仓库。若本地没有可信副本，规范 URL 请求允许在客户端仓库之外的隔离临时目录执行只读 `git ls-remote` 和非嵌套 clone；不得把运营精灵变成客户端的子目录、submodule 或依赖源码副本。

权威仓库必须满足：

- `origin` 规范化后精确等于 frontmatter 中的 `canonical-repository-url`，URL 不含账号、Token、查询参数或片段；
- checkout 是 Git top-level，整个仓库相对 HEAD 没有 index、worktree 或未跟踪漂移；必需入口与 Skill 源文件均受版本控制、无符号链接/重解析点，也不含 `.pyc` 或 `__pycache__`；
- HEAD 精确等于 `git ls-remote --symref <canonical-url> HEAD` 实时返回的默认分支提交；
- 根 `bifang-onboarding.json`、`tools/bootstrap_bifang_onboarding.py` 和其中声明的 Skill/脚本都存在；
- HEAD 包含 manifest 的最低基础设施提交；frontmatter 的 `infrastructure-source-commit` 同时包含该最低提交、属于当前 HEAD 的祖先，且该提交的根 `package.json` 确实声明对应基础设施版本；
- manifest 的基础设施、Skill 和契约版本与本 frontmatter 一致。

在原客户端 cwd 中运行权威仓库的 bootstrap，并传入客户端绝对 Git 根。权威源码与目标客户端不能重叠；目标客户端可以是 `CODEX_HOME/worktrees/` 下的 Codex worktree，但不能与实际安装目录 `CODEX_HOME/skills/bifang-public-services-onboarding/` 重叠。bootstrap 先完成阶段 0 只读扫描，以分支、HEAD、index、porcelain 状态和扫描范围内容摘要证明客户端未变，再隔离外部 `quick_validate` 钩子安装 Skill，最后统一输出结果。安装完成后，本轮直接完整阅读已安装 `SKILL.md`，进入第二门禁授权与配置获取，不能跳过后直接迁移；不要求重开会话。

每次实施还要完整读取权威仓库中的：

- `README.md`
- `docs/毕方小工具公共服务分步接入指南.md`
- `docs/multi-tool-isolation.md`
- `docs/telemetry-and-update.md`
- `docs/client-update-center-migration.md`
- `references/client-update-center.md`
- `references/integration-contract.md`（授权中心、精确配置字段、自动取值/默认值、日活与验收）
- `cloudbase/apps.json`、`cloudbase/generate-cloudbaserc.mjs`

涉及仍在线的历史 application-version 服务时，再读取其合同与 CloudBase 函数；不要将该服务的 GET 协议用于新客户端。

若权威仓库版本高于本 Skill，先用权威 installer 更新；installer 仅允许当前规范版本，或匹配允许列表中已发布 v1 / infrastructure 2.1、v2 树的旧 Skill 原子升级。比较完整文件树时只忽略 CRLF 与 LF 换行差异，文件增删或其他内容变化仍会被拒绝；任何修改过或来源不明的同名 Skill 都停止。若权威版本低于已安装版本，也停止写入并报告，不能套用混合版本。

## 当前客户端迁移流程

以下是联合接入的步骤清单：第一门禁后可执行事实取证与草稿准备，准备第二门禁设备授权与配置读取；本次所选范围第二门禁整体通过后执行第三门禁方案核验，技术就绪且客户确认后进入第四门禁，在原授权内完成业务实现/迁移和本地验收。单服务跳过未选服务的参数、资源、变更与测试。仅统计不执行更新清理，仅更新不新增或迁移日活。扫描/安装成功和草稿存在不等于任一实施门禁通过。

1. 核对目标项目根目录、Codex Task、Git 分支、HEAD 和工作区。保留用户已有改动；脏工作区可以迁移，但必须先区分现有修改与本轮修改，不能覆盖、清理、stash、reset 或切走。
2. 验证 `.bifang/public-services-profile.json`。Profile v1 只作为旧状态证据读取；不要原地猜测字段。规范一句话授权时，基于代码证据确定性写入 v2。`display_name` 必须是已确认的中文产品名，从当前发布产品配置、窗口标题或负责人说明取证；证据不一致或仅有英文包名时询问负责人，不从 APP_ID 自行翻译或拼接名字。冲突或无法确认的产品事实最多问 1–3 个短问题。
3. 运行 `scripts/scan_project.py <project-root>`。把 `daily_active` telemetry 与旧静态更新分开；扫描不完整时列出 `skipped_files`，不能声称旧协议已删除。
4. 从实际发布配置确认唯一 SemVer 来源、框架、平台、架构、主窗口 ready hook、安全外链和完整退出。`current_version` 是本次快照，`version_source` 指向真实发布/运行时来源，不把 Profile 当运行时版本配置。不得从 README 猜运行时事实。
5. 使用 `scripts/derive_resources.py --profile ...` 展示中文 `display_name`、APP_ID、telemetry 资源、新更新中心 POST 地址和每个实际目标。将名称映射连同资源清单交接给运营精灵任务；本地交接不表示已登记或已上线。旧 application-version 的 code 和集合是历史运营事实，不作为新服务的配置推导，也不由客户端接入删除。
6. 保留已经正确隔离的 `daily_active` 实现，并核对其请求必含真实应用 SemVer `app_version`。公共 SDK 由宿主的 `appVersion` 自动映射；其他框架按同一协议发送。从唯一版本来源取值，与版本检查的当前版本一致，禁止漏传、固定占位、误用 SDK 版本或另增版本上报接口。`sdk_version` 固定为 `3.0.0`，服务端等值校验，不可填 Rust crate/适配器自身版本。删除旧 `UPDATE_BASE_URL=/updates`、静态 manifest URL、14 字段解析、旧 rollout/manifest 决策、兼容开关和相关测试；不要删除通用 SemVer、安全 HTTPS 外链或完整退出能力。
7. 在可信宿主层实现 `POST <update_center_base_url>/api/v1/apps/{app_id}/update-checks`，按 [新协议](references/client-update-center.md) 填真实版本、平台、安装形态、随机持久 UUID、触发方式和已实现能力；HTTP 201 才解析决定。只有 `enforcement=block_new_operations` 才阻止新业务，保留更新、重试和退出，不中断已有任务。
8. 使用服务端匹配的客户端专用 Bearer Token，管理凭据永不进入客户端。原值不进 Git、Profile、源码、命令行参数、普通日志或测试证据，只从运行时注入；共享 Token 可被提取，不能当作用户身份。缺少真实 Token 或后台应用策略时保持线上验证未完成，不伪造成功。
9. 本地测试覆盖请求字段和认证、201/错误处理、推荐与强更、断网策略、下载大小和 SHA-256、安装前重新检测与目标变化、失败重试和完整退出；不转发 Token 给文件服务。捕获实际 `daily_active` 请求并验证版本来源和同日去重，通过后记录 `telemetry_app_version_verified=true`。SDK 当前只提供检测和目标对照，不能把它当成完整下载/安装实现。不得在未授权时访问真实服务。
10. 再次运行 Profile 校验、资源派生、旧协议扫描和项目测试。只有扫描完整、`update_center_migration_gate=clear` 且人工确认生产代码、配置和活跃测试均没有旧静态或旧 application-version 更新客户端，才把 `legacy_update_status` 记为 `removed`。新服务的字符串命中只是线索，不能单凭扫描宣称接入完成。

## Profile 与发布流

先在交接记录中列出已确认范围。以下更新字段及 `--require-update-center` 仅适用于选择更新；仅统计不填更新字段，也不能回退到旧 application-version 合同。现有 Profile 部分完成校验仍面向联合接入，单服务缺少未选字段时不得伪造值、扩大范围或冒称联合门禁通过；保留真实草稿并以所选服务的独立证据报告当前结果，记录校验器适配缺口。

档案固定为 `.bifang/public-services-profile.json`，Schema 位于 [references/public-services-profile.schema.json](references/public-services-profile.schema.json)。只保存非敏感事实；写后运行：

```text
python <skill-root>/scripts/validate_profile.py .bifang/public-services-profile.json --require-update-center
python <skill-root>/scripts/derive_resources.py --profile .bifang/public-services-profile.json
```

Windows 使用 `py -3 -X utf8 -B`。新接入 Profile v2 默认支持 CloudBase `/tools/version-control/v1`（不强制要求 `https://update.meetelf.com`）；仅当明确接入独立更新中心时，才将 `update_transport` 设为 `client-update-center-v1` 并通过 `--require-update-center` 校验（生产 `update_center_base_url` 按授权中心配置核验，本机联调可用 `http://127.0.0.1:8080/`）。本地地址不能标记生产服务或客户端线上 E2E 已验证，也不能完成阶段 6/7；不要把生产 Token 用于本地测试。`update_targets` 记录每个 `os + architecture + installation_type + channel`，以当前进程架构而非硬件架构为准。`x64` 映射为 `x86_64`，Linux 必须从真实发行版确认 `ubuntu` 或 `debian`。CloudBase 后端存储默认走云存储（COS），不再将 PostgreSQL 集合创建作为阶段 4 或线上 E2E 的前置门禁。

Profile 只记录 `update_center_auth_status` 和已确认的 `offline_enforcement`，不记录 Token、凭据摘要或下载临时链接。`service-default` 遵循服务端强更缓存期限；`persist-until-resolved` 是产品明确要求的离线强更例外，不能未经确认套用到其他工具。

`display_name` 为 1–100 个 Unicode 字符，包含中文，无首尾空白、控制/格式字符和 `<`、`>`。草稿可以暂缺名称，但不能声称 Profile 完成，也不能生成缺名称的 Profile 交接清单。旧档案缺失名称或仍写英文 APP_ID 时，按产品证据补全后重新校验；不要改 APP_ID、发布流 code、集合或路由来实现中文展示。

阶段 2–4 的名称登记、覆盖检查与线上验收见 [references/cloudbase-gates.md](references/cloudbase-gates.md)。名称唯一展示来源是权威仓库的 `cloudbase/functions/operations-dashboard/src/app-labels.json`；每个工具自己的 APP_ID 和全部发布流共同使用同一中文名。普通版与 Plus 版仍保持独立身份，不合并发布流。

客户端版本、SDK 版本与发布记录的区别见 [references/integration-contract.md](references/integration-contract.md)。客户端 `app_version` 用于活跃版本画像；看板“发布流最高版本”来自旧运营端 `versions_*` 中的已发布 `code_version`。仅统计工具可不登记旧发布流，新更新中心的发布状态在更新后台查看；遥测和版本检查请求都不会创建发布记录。不允许为填表给客户端管理写权限或自动发布。即使升级了应用，当天已尝试过 `daily_active` 也不重置每日门禁，新版本在下一次正常的新日上报中出现。

## 框架和安全边界

实施客户端时读取 [references/integration-contract.md](references/integration-contract.md) 与 [references/framework-adapters.md](references/framework-adapters.md)。涉及云端或真实 E2E 时读取 [references/cloudbase-gates.md](references/cloudbase-gates.md)。

本仓库新接入以 Rust 为目标。授权中心设备流程及两个配置 GET 合同已在统一规范明确；先实际取配置再实施，项目身份/版本/目标自动识别，默认值按有依据的规则采用。CloudBase SecretId/SecretKey 仅在已授权可信运维边界使用，不分发到业务客户端；Rust 日活只需要验证后的上报地址与固定业务字段。TypeScript SDK 保留为有限协议参考，不引入 Node/Python 运行桥接。

参数以完整服务合同为准，不以旧 SDK 类型为准：Windows Updater 架构支持 `x86`（telemetry/Profile 架构 `ia32`）；其他系统不支持 x86。旧 TypeScript SDK 的架构、响应字段和部分校验尚未对齐 1.4.1，差异清单见 Updater reference，不能复制成新的 Rust 接入规范。所选配置未实际获取并验证时不得标记门禁通过；不通过伪造 Profile 值绕过缺口。

- Tauri/Rust：凭据和 HTTP 请求留在 Rust 可信层；WebView 只接收固定更新 DTO 和固定动作，不得提交任意 URL、路径或读取凭据。
- Node/Electron：可信主进程持有请求配置与凭据；renderer 只通过最小 IPC 接收决策。`@bifang/telemetry-update-sdk` 的 `ClientUpdateService` 只覆盖检测和目标对照，下载校验、强更缓存和安装由宿主完成。
- 其他原生程序：以更新中心的客户端 API 契约实现薄适配层；不得用旧服务的 OpenAPI 或凭参考摘要猜字段。
- 广告端点仅在产品已经明确包含广告展示能力或用户另行批准该产品功能时接入；没有广告 UI 的客户端不为“凑齐接口”新增广告产品能力。服务端广告与管理端点由运营精灵自己的契约/E2E 验收。

## 阶段与授权

以下 0～8 是历史运维/交付阶段，不是本 Skill 的门禁编号，不能据此跳过接入门禁。阶段 5 本地迁移必须先通过门禁 1～3 及第四门禁 4A/4B；本地测试使用假凭据，不要求提前完成云部署或公网 E2E，但不能豁免第二门禁真实配置验证。校验器只检查部分阶段字段，脚本通过不等于执行流程已通过；阶段 4/6/8 分别承担服务端、公网客户端和线上退役证据。Profile 用 `legacy_client_update_removed` 记录客户端旧实现已删，用 `legacy_cloud_resources_removed` 记录阶段 8 的线上资源退役，二者不得混用。

| 阶段 | 结果                                         | 规范一句话是否授权         |
| ---- | -------------------------------------------- | -------------------------- |
| 0    | 验证权威来源并只读扫描当前项目               | 是                         |
| 1    | 写入或迁移非敏感 Profile v2                  | 是                         |
| 2    | 在运营精灵登记 APP_ID、历史拓扑及中文名      | 否，须在运营精灵任务中执行 |
| 3    | 生成并审查 CloudBase 配置和只读计划          | 否                         |
| 4    | 部署/写入服务并完成公网 HTTP E2E             | 否，写入前再次确认         |
| 5    | 替换并删除当前客户端旧更新协议，运行本地验证 | 第三门禁明确确认后         |
| 6    | 构建、安装和真实客户端 GUI E2E               | 否，需明确要求             |
| 7    | 发布或推送                                   | 否，写入前再次确认         |
| 8    | 删除线上旧静态更新资源                       | 否，列出精确目标后再次确认 |

本 Skill 不从运营精灵仓库扫描或修改未知客户端；接入始终由目标客户端自己的 Task 发起。规范一句话不允许修改第二个客户端或运营精灵仓库。

## 存量 CloudBase 环境升级（PostgreSQL 切云存储与止血）

当已有项目曾使用旧版 Skill 在 CloudBase（尤其是体验版 3,000 点/月环境）部署了 PostgreSQL 版云函数或 `cleanup-*` 定时清理函数时，可按 [存量环境升级与 PostgreSQL 清理](references/cloudbase-gates.md#存量环境升级到云存储止血与清理-postgresql) 在不改动已发布客户端代码的前提下完成无感升级：

1. 使用仓库固定 CLI（`./node_modules/.bin/tcb login`）登录后，先只读枚举环境、云函数、触发器与路由，重点排查定时触发器（如每 15 分钟唤醒 PostgreSQL 的 `cleanup-*` 函数）。
2. 向负责人展示精确目标（待删定时触发器/清理函数、待仅更新代码的业务云函数、是否清理旧 PostgreSQL 表及 0 付费确认）并等待明确“继续”。
3. 删除 `cleanup-*` 定时触发器与清理函数，再进入各函数独立目录用 `--dir . --deployMode zip` 仅更新 `telemetry-*`、`application-version-api`、`operations-dashboard-api` 代码（严格保留线上原有环境变量与路由），并复核 `tcb fn list` 全部为 `Deployment completed`。

## 完成标准

先报告第一门禁选择、第二门禁授权/所选配置获取的脱敏证据、第三门禁正文完整请求明细、客户确认依据、分项/联合方案结论与实施清单、第四门禁适用 UI 的展示/客户确认依据、本地验收证据及未执行项、自动识别和默认值来源，以及准确部署缺项。不得输出完整配置/令牌，不能把阅读合同当真实取配置；一分支通过不代表联合通过，后台未就绪不表示线上验证。

结束时先报告第一门禁选择及用户确认依据，再按所选范围报告：目标 Task/cwd/分支/HEAD、继承的用户改动、Profile/接入记录、中文名及其证据、适用的名称/版本/日活/更新验证状态、删除的旧更新实现、新 API 文件和请求形状、实际测试、未执行的构建/GUI/云端/发布/推送/删除。未选择的服务记为“不在本次范围”，不是接入失败。静态检查、单元测试、编译、HTTP E2E 与真实 GUI E2E 分开，不得互相冒充。

若没有真实云端服务、运行凭据或已安装制品，只能把相应状态标为 `Unverified`；不能用 mock 或 localhost 声称最终 E2E 完成。
