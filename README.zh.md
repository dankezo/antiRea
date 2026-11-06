# antiRea

**保护真正支撑应用的核心部分。不要幻想客户端界面能对浏览器隐藏。**

**风险评估工具包 · TypeScript SDK · AI Agent 技能**

[English](README.md) · [Tiếng Việt](README.vi.md) · [Español](README.es.md) · [Threat Model](docs/THREAT_MODEL_REA.md) · [Limitations](docs/LIMITATIONS.md) · [Changelog](CHANGELOG.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@dannyphan190/anti-rea.svg)](https://www.npmjs.com/package/@dannyphan190/anti-rea)
[![CI](https://github.com/dankezo/antiRea/actions/workflows/ci.yml/badge.svg)](https://github.com/dankezo/antiRea/actions/workflows/ci.yml)
[![dist 代码行覆盖率](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dankezo/antiRea/badges/badges/coverage.json)](https://github.com/dankezo/antiRea/blob/main/docs/LIMITATIONS.md)
[![tests](https://img.shields.io/badge/tests-746%20passing-informational)](tests/)

antiRea 帮助您审计网站暴露了什么、在服务器端执行速率/分页配额、把关键逻辑移到服务器，并在适当时应用金丝雀或水印控制。它**不能**阻止用户或智能体检查已交付到其浏览器的代码。

## 简短故事

**一个普通的 Web 应用，没有任何保护。** 任何拥有账号的人都能把数据带回家。在我们的测试中，只用一个账号和一次导出调用，就在不到 200 个请求内悄悄带走了全部 10,000 条记录的数据集，没有留下任何异常痕迹。

**同一个应用，接入 antiRea 之后。** 真实用户不会察觉任何变化。但数据按记录计量：一个身份最多只能收到一个有上限的切片（在我们的测试配置中为数据集的 20%），因此批量提取不再是一次导出，而变成了一个身份问题。把工作分摊到多个账号，群体检测器会标记这种协同行为。实测结果（v2.5.0 经典轮次）：在无保护时只需 1 个账号的 REA 风格运行，被**拦截在数据集的 5%**，而一个坚持要完成的脚本化切片团队需要 **25 个身份和约 19 分钟**，途中同时被群体检测器和证据引擎标记。

没有保护时，您的数据会**完整、免费、无痕**地流出。有保护时，它会**分片流出、付出代价、并留下记录**。完整数字见下文[实测结果](#效果如何实测结果)。

从 npm 安装：

```bash
npm install @dannyphan190/anti-rea
```

您也可以通过 [GitHub Release](https://github.com/dankezo/antiRea/releases) 安装。

## v2.7.3 新功能

简短版：这一版是为**直播间**准备的——一起看影院、卡拉OK 房、直播流——起因是一个真实平台的房间在应用层被机器人 swarm 反复打崩。六个新的咨询信号发布，每个都通过了自己预注册的实验室测试；一个设计好的模块**没有通过实验室，被留在了门外**；集成文档现在是写给负责大部分接线工作的 AI 编程智能体的。默认路径没有任何变化。

- **共用一台定时器的舰队。** 新的 herd-phase 信号看的是账户*何时*行动，而不是行动多少：给它喂一种重复的时间戳（加入房间、会话开始、重试），它就能检出行动锁定在同一个 900 秒定时器、**且偏移相同**的舰队——这是一个调度器驱动许多机器人的指纹。群体检验正是关键所在：锁定在*自己*定时器上的账户（个人 cron、单个机器人）永远不会被点名。实验室中，60 个机器人共用定时器的重连 herd 被确认（60/60，R_cohort 0.9978），同一 herd 改用各自独立的定时器则**没有**被确认（R_cohort 0.0421）；而普通的房间日常——稳定观看、主播发链接后 50 个用户涌入、60 个用户在同一分钟为已宣布的场次加入、卡拉OK 黄金时段——没有产生任何确认，也没有误标。和本层级的其他一切一样，它只是咨询性的：把确认的舰队作为证据点名；不阻断任何东西。
- **另外五个房间信号，各自通过了自己冻结的实验室测试。** *座位占用*只看人群层面（它描述的是房间，永远不是某个人）：当全新且沉默的账户占住房间一半座位达 10 分钟时标记——第二个更慢的配置能抓住滴漏变体（三分之一座位被沉默地占满整整一小时）；沉默观众的卡拉OK 单元格峰值只到 0.50 线的 0.13。*活动相位*把 herd-phase 的规律用在聊天/表情时间戳上，而不是加入事件上——满屋子真实观众对同一个电影瞬间做出反应，测得锁定成员为**零**。*投票 brigading*按分钟积累证据：首次访客的一次大规模跳过无法标记房间（它测得的一次尖峰比一支 brigading 还大），连续毁掉两首歌则可以。*房间跳跃*会标记一小时内进入 16 个以上不同房间的身份（合法的冲浪者测得最多 11 个），并且当平台上突然有四分之一看起来都像这样时，它会自我解除武装、不点名任何人。*重连风暴*会标记在 10 分钟内循环 40 次以上、每次会话不足 5 秒的来源（信号不好的手机测得 13，火车通勤者测得 21），同样带有自我解除——并有一个明确声明的盲点：分散在许多来源上的细流风暴不会标记任何人，因为高峰时段的通勤人群在人群层面上就能达到风暴级的总量。
- **不在这里的那个模块。** 一个组合式的房间守卫模块（加入洪水、churn、座位占用）曾为这一版设计，并通过了实验室的大部分测试：洪水在 60 秒被标记，慢速滴漏在 31 分钟被标记，churn 在 30 秒被标记，合法房间零误报。但它**完全漏掉了座位占用**——悄悄占满卡拉OK 全部 30 个座位然后只是坐在那里的机器人，攻击的是占用率，而不是加入速度，而预先注册的信号里没有占用这一条腿。这里的规则不允许在看到结果之后放宽测试，所以该模块被排除，而不是半盲地发布。v2.7.3 中仍然没有 `createRoomGuard`。缺失的占用腿被单独重新注册，通过了自己冻结的实验室测试（如上），作为独立的座位占用信号发布——组合守卫本身仍未构建，如实说明，不加掩饰。
- **你的智能体能直接执行的文档。** 新发布的[智能体指南](docs/AGENT-GUIDE.md)把症状映射到模块，给出带安全默认值的可复制接线代码、一份"绝不"清单（绝不依据咨询输出硬阻断；绝不碰已经在房间里的成员）和一份验证清单。如果由 AI 智能体替你集成 antiRea，先让它看那里。（该指南为英文版。）
- **诚实的分层。** antiRea 守的是房间门——应用层上假用户的加入、占用与循环。它不拦截网络层 DDoS；那是你的 CDN/防火墙的工作，本版也不假装能做。以上所有数字都是带种子的模拟，不是真实流量测量。

完整技术说明，包括未通过的那道门及其机制：[v2.7.3 深入解析](docs/v2.7.3-deep-dive.zh.md)。上一版改了什么：[v2.7.2 深入解析](docs/v2.7.2-deep-dive.zh.md)。

## 浏览器基准测试工具

本仓库附带一个 Playwright 测试工具，在 Chromium、Firefox 和 WebKit 上以 **baseline（`:4173`）** 和 **protected（`:4174`）** 两种模式运行一个合成 SaaS（**Northstar**：仪表板、客户搜索、线索创建、CSV 导出、图表视图）——这是与下文实测结果配套的、可在仓库内复现的工具。

```bash
npm install
npm run build && npm run benchmark:build-sdk
python -m pip install playwright
python -m playwright install chromium firefox webkit
python benchmark/run_all.py --browsers chromium,firefox,webkit --iterations 5
```

## antiRea 解决什么问题？

[morluto/rea](https://github.com/morluto/rea) 等工具可协助观察 DOM 结构、分析 JavaScript 包、跟踪网络流量，并重建 Web 应用界面。

本项目的目标是帮助应用所有者实施**副作用最小的有效措施**，并以可复现的测试基准为依据，而不是靠隐匿来获得安全。

## 效果如何？实测结果

**方法，简述。** 我们在 **Ledgerly** 上测试：这是一个合成 SaaS，在 120 个账号之后存放着 10,000 条记录，运行两次：一个没有保护的 baseline 实例，以及*同一个*应用接入 antiRea 的 protected 实例。攻击运行由 REA 6.8.0（`rea-agents`）和遵循标准克隆流程的通用智能体驱动；礼貌用户对照运行用来测量对合法流量的代价。关于本仓库的一份独立基准测试也已发表在 [issue #1](https://github.com/dankezo/antiRea/issues/1) 中；其中大多数主张都经受住了检验，它发现的差距也已修复并记录在变更日志中。完整的方法说明和完整的逐层表格见 [docs/EVIDENCE.zh.md](docs/EVIDENCE.zh.md)。

| 层 | 主要结果 |
|---|---|
| 无保护（baseline） | 完整的 10,000 条记录数据集在 **160-193 个请求**内流出 |
| 记录预算 | 一个身份被恰好限制在数据集的 **20%** |
| 群体检测 + CUSUM 证据 | REA 式身份轮换在 **5%** 处被拦住；一个自适应团队需要 **25 个身份和约 19 分钟** |
| 已声明群体上限 | 群体并集恰好停在 **600 条记录**，超出上限的服务为零 |
| 合法用户 | 已声明团队 **1,200/1,200，零摩擦**；礼貌用户零后果 |
| 行动预算（实验室） | 功能滥用 herd 完成 **16/80 个操作（20%）**；普通用户 **48/48**，零后果 |
| 咨询信号（实验室） | 五个慢速形态信号：对合法流量的误标 **0-1.67%**——逐信号数字见完整表格 |

完整的逐层表格，包括记录在其自身单元格内的盲点：[docs/EVIDENCE.zh.md](docs/EVIDENCE.zh.md)。

**这一切意味着什么。** 该技术栈消除了随意的单次克隆，并把批量提取变成一个身份问题：数据集的每一个额外切片都要付出另一个账号和更多可见性的代价。它无法阻止一个决心坚定、资源充足的重建者，而一个身份的真实价格（注册摩擦、已验证账号、付款）由您——主机方——设定，这正是预算按身份执行、群体标记区分"削减预算"和"加强审查"而不是发出一种钝性响应的原因。

## 四个层级与实施优先级

| 优先级 | 功能 | 预期收益 | 局限 |
|---|---|---|---|
| **P0 - 基础** | 服务器端配额/分页中间件（`createQuotaGuard`）、按记录授权、秘密隔离 | 核心的反抓取和反克隆保障 | 无法隐藏已经提供给已授权用户的数据 |
| **第 1 层** | 隐藏公开源映射（`verify-build.py` / `run-audit.cjs`）；版权声明；SVG/文本来源签名 | 防止意外暴露完整源代码 | 决心坚定的用户很容易去除 |
| **第 2 层** | 规范化 API 金丝雀陷阱（`handleCanaryTrapRequest`）、确定性金丝雀迷宫（`createCanaryMaze`）、诱饵路由（`createDecoyMirage`）、低置信度自动化遥测（`detectAutomationSignals`），以及为签署请求的智能体提供的 Web Bot Auth 签名验证（`createWebBotAuthVerifier`） | 记录异常探测以供审查；识别已签名的智能体，使配额策略可以基于稳定的身份 | 不是阻止访问的控制；已验证的签名是身份，不是授权 |
| **第 2 层 - 数据经济学** | 按记录预算（`createRecordBudget`）、定价导出（`createExportGuard`）、会话链式游标（`mintCursor` / `verifyCursor`）、序列流程评分（`createFlowScorer`） | 限制任何一个身份总共能收到的数据集数量；使完整提取需要付出许多身份的代价（实测：在我们的测试中每个身份上限为 20%） | 攻击者会轮换身份——需在主机端配合真实的注册成本 |
| **第 2 层 - 群体检测** | 跨身份群体检测器（`createHerdDetector`）及响应阶梯（`applyHerdLadder`） | 标记共同铺满数据集的身份群体，包括跨 IP 的群体；高铺满群体被削减预算，低铺满群体获得分级响应 | 对低铺满群体，检测不等于执行——一个纪律严明的自适应群体被标记后仍完成了提取（见实测结果） |
| **第 3 层** | AES-GCM 上下文绑定信封（`encryptPayload` / `decryptPayload`）及有界重放防护（`createInMemoryReplayGuard`） | 防止简单的跨端点重放 | 如果密钥在浏览器中，客户端仍持有解密上下文 |
| **第 4 层** | 临时令牌水印覆盖层（`mountForensicWatermark`） | 对泄露的屏幕截图可追溯 | 屏幕覆盖层可以被裁剪或编辑掉 |

**默认建议：** 先实施 P0，然后设置第 1 层。对于关键 API，启用服务器配额和金丝雀陷阱。

## 安装和测试

需要 Node.js 20+。本仓库**没有运行时依赖**；TypeScript 是用于构建的 devDependency。

```bash
npm install
npm run check
npm run build
```

`npm run check` 会编译、运行 **748 个自动化测试**（746 个通过，2 个 RSA-PSS 向量被跳过），并执行静态检查。部署前，用 `node scripts/run-audit.cjs /path/to/dist` 或 `python3 scripts/verify-build.py /path/to/dist` 扫描您的公开构建目录。

## 如何集成 SDK

### 1. P0 服务器端配额和分页防护（建议先做）

```ts
import { createExpressQuotaMiddleware } from "@dannyphan190/anti-rea";

app.use("/api/", createExpressQuotaMiddleware({
  trustedIpHeader: "cf-connecting-ip",
  tiers: {
    anonymous: { maxRequests: 30, windowMs: 60_000, maxPageSize: 25, maxPage: 5 },
    free: { maxRequests: 60, windowMs: 60_000, maxPageSize: 50, maxPage: 20 },
    pro: { maxRequests: 300, windowMs: 60_000, maxPageSize: 200, maxPage: 100 },
  },
  resolveIdentity: req => ({
    accountId: req.headers.get("x-verified-account") ?? undefined, // populate from server auth middleware
    apiKeyId: req.headers.get("x-verified-key-id") ?? undefined,
    tier: "free",
  }),
  onQuotaExceeded: event => {
    console.warn("[quota-exceeded]", event);
  },
}));
```

当账号、API 密钥或 IP 阈值被超过时返回 HTTP `429` 并带 `Retry-After`，执行 `limit`/`pageSize` 和 `page`/`offset` 上限，并为运营者记录结构化事件。

### 2. 服务器金丝雀端点（带 URL 规范化）

```ts
import { handleCanaryTrapRequest, normalizeCanaryPath } from "@dannyphan190/anti-rea";

const result = await handleCanaryTrapRequest(request, {
  onAlert: async event => { /* send sanitized event to your monitoring platform */ },
  resolveUserId: () => trustedServerSession.userId,
});
if (result.isTrapped) return Response.json(result.body, { status: result.status });
```

`normalizeCanaryPath` 会自动规范化尾部斜杠、大写路径和百分号编码字符（`%2D`、`%5F`），使路由变体无法绕过精确匹配。

### 3. 已认证预览的可选水印

```ts
import { mountForensicWatermark } from "@dannyphan190/anti-rea";
const remove = mountForensicWatermark({ token: "A7fK3w9Z", enabled: true });
// Resolve that token to a session only in your private server ledger.
```

不要把此人的电子邮件、IP 或原始用户 ID 嵌入像素中。请提供隐私声明和保留政策。

### 4. 高级信封：服务器持有的密钥和有界重放防护

```ts
import {
  createEnvelopeKey,
  encryptPayload,
   verifyTransportEnvelope,
  createInMemoryReplayGuard,
} from "@dannyphan190/anti-rea";

const key = await createEnvelopeKey();
const scope = { purpose: "report-export", method: "POST", path: "/api/export", sessionBinding: "trusted-session-id" };
const env = await encryptPayload({ result: "ok" }, key, scope);

// Automatically purges expired nonces by TTL and caps entries to prevent unbounded RAM growth
const replayGuard = createInMemoryReplayGuard({
  ttlMs: 300_000,
  maxEntries: 10_000,
});

const decoded = await verifyTransportEnvelope(env, key, scope, { markNonceOnce: replayGuard });
```

将此模式用于独立控制的服务器服务或精心设计的会话协议（在多实例集群中使用 Redis `SET ... NX PX`）。

### 5. 验证已签名的智能体（Web Bot Auth）

一些爬虫和 AI 智能体会按照 Web Bot Auth 配置文件（RFC 9421，Ed25519）签署其请求。验证器会重建并检查签名，执行有效期窗口，并拒绝重放的 nonce。它从不自行获取密钥——您静态提供密钥，或通过自己的解析器提供（用您自己的缓存和 SSRF 策略从智能体的源获取 `/.well-known/http-message-signatures-directory`）。

```ts
import { createWebBotAuthVerifier } from "@dannyphan190/anti-rea";

const verifier = createWebBotAuthVerifier({
  resolveKey: async ({ agent }) => {
    if (!agent) return undefined;
    const res = await fetch(new URL("/.well-known/http-message-signatures-directory", agent));
    return res.ok ? await res.json() : undefined;
  },
  maxValiditySeconds: 600, // tighten the draft's 24h ceiling
});

const verdict = await verifier.verify(request);
if (verdict.verified) {
  // verdict.agent / verdict.keyId identify the signer of THIS request.
  // Feed the identity into your quota tier decision - and keep your
  // authorization checks exactly as they are for unsigned traffic.
}
```

一个可运行的端到端演示（生成密钥、签署请求、验证，然后篡改并看它失败）位于 [examples/web-bot-auth-verify.cjs](examples/web-bot-auth-verify.cjs)。

### 6. Python / FastAPI

后端运行 Python？[examples/python-fastapi](examples/python-fastapi) 移植了配额防护，具有相同的层级、`429` 语义、`X-RateLimit-*` 头和分页上限，还附带 Starlette 中间件和 FastAPI 依赖。它的 pytest 套件镜像了 TypeScript 测试场景，因此两种实现都受同一合同约束。

### 7. 计量数据本身（记录预算 + 群体检测）

请求配额限制*速度*；记录预算限制一个身份无论多么礼貌地分页，*能收到多少数据集*。将相同的服务事件喂给群体检测器，使协同群体也能浮现。

```ts
import { createRecordBudget, createHerdDetector } from "@dannyphan190/anti-rea";

// One identity receives at most 2,000 distinct records per day.
const budget = createRecordBudget({ maxDistinctPerWindow: 2_000 });
const herd = createHerdDetector({
  onFlag: snap => { /* snap.band: "budget_cut_supported" | "graduated_only" */ },
});

// Gate before the handler runs, then record what the response actually served:
if (!budget.check("account:123", 1).allowed) { /* return 429 */ }
// ... handler runs, authorization passes, recordIdsServed is final ...
budget.consume("account:123", recordIdsServed);
herd.observe({ type: "list", identity: "account:123", ip: serverSeenIp, recordIds: recordIdsServed });
```

在两处都使用相同的身份字符串（`account:<id>`），这样群体标记可以直接喂入 `applyHerdLadder()` 或预算覆盖。

### 8. 共享上限和证据（v2.5.0）

对于群体，按身份的预算会被轮换稀释；共享上限不会——但前提是预留是事务性的。声明群体，在提供服务前预留，之后提交：

```ts
import {
  createDisclosureLedger, createInMemoryTransactionalStore,
  createCusumTripwire, clampEnforcement, consequenceTargets,
  createProtectedCohortRegistry, defaultHerdBandResponse, herdFrictionTargets,
} from "@dannyphan190/anti-rea";

const ledger = createDisclosureLedger({
  store: createInMemoryTransactionalStore(), // CAS store => mode "enforce"
  ceilingLimit: 2_000,                        // shared across the whole cohort
});
await ledger.declareRegistry(memberIds);      // unregistered subjects fail closed

const reservation = await ledger.reserveDisclosure({ subject: "account:123", recordIds: idsToServe });
if (!reservation.allowed) { /* 429: ceiling_exceeded | rate_limited | ... */ }
// ... serve ...
await ledger.commitReservation(reservation.reservationId);

// Declare the subjects inference must never consequence: the
// compliance team's reviewers, the support floor, an agreed pentest
// window. Their telemetry still accrues - only consequences are
// suppressed - and the declaration is an auditable record.
const protectedCohorts = createProtectedCohortRegistry();
protectedCohorts.declareProtected(["account:auditor-1", "account:auditor-2"], {
  reason: "Q3 compliance review",
});

// Evidence accumulates separately. The tripwire's default mode is
// enforce, but with the bundled uncalibrated tables an inferred
// cohort's consequence is capped at the friction tier (step-up, plus
// a soft budget step-down that never goes below 500 records).
// Anything harder needs a host-declared cohort or a ceiling-tier
// calibration manifest - clampEnforcement() is the check.
const tripwire = createCusumTripwire({ isProtected: id => protectedCohorts.isProtected(id) });
await tripwire.observe({ type: "list", identity: "account:123", recordIds: idsToServe });

// Herd flags get the same default: for an inferred cohort,
// defaultHerdBandResponse() returns friction (stepUp: true,
// budgetStepDownFloorRecords: 500, ladder: false) on both bands.
// Apply that friction only to the members who produced the
// evidence (2.5.0): herdFrictionTargets(snap) keeps members whose
// unique coverage is material, consequenceTargets(snapshot)
// keeps net contributors - then partition through the registry
// so protected subjects stay at zero.

// Canary-echo (2.5.0): mint a signed reference FOR this identity
// and embed it in its own surface (a record, a hidden link); when
// a different identity presents it back, link the two cohorts.
const echoId = mintEchoId(secret, { mintedFor: "account:123" });
const ref = mintEchoRecord(secret, { mintedFor: "account:123" });
// ...later, on the detail route, before the record lookup:
const echoFrom = resolveEchoFrom(secret, presentedId);
if (echoFrom && echoFrom !== identity) {
  await tripwire.observe({ type: "detail", identity, echoFrom });
}
```

对于只有 get/put 的存储，账本会在每个决定上报告 `mode: "audit_only"` 和 `enforced: false`——先测量，等您的存储真正能执行事务时再强制执行。完整语义和局限：[docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

## 校准试点

antiRea 的 CUSUM 证据引擎附带在实验室拟合的表
（`r6-calib-1`，标注为 `uncalibrated: true`）：它们是在
脚本化轨迹上拟合的，不是在真实用户群体上拟合的，README 在
提到这些表的每个地方都这样说明。要弥合这一差距，恰好需要
一件本项目无法自行生成的东西——来自真实主机的 observe
模式快照。

**运行一次校准试点。** 如果您使用 antiRea（或正在评估
它），请以 `mode: "observe"` 运行 CUSUM tripwire——越界会
被记录，且不会限制任何东西——并分享由此产生的
**匿名化聚合快照**：群体规模、越界时的分数和
并集记录计数，其摘要形状与 SDK 的
`onCampaignFlag` 回调已经发出的相同。

- 只有聚合的、匿名化的快照——**没有原始用户数据，没有
  记录内容，没有任何可以识别您用户的标识符**。发送前请审查并去除快照；如果某个字段
  看起来具有识别性，请将其省略并说明。
- 快照会进入离线校准拟合；在
  真实群体快照上拟合的表，是去除 `uncalibrated` 标注的方式，拟合方法和留出结果会发表在
  变更日志中。
- 一个主机就足以开始：第一组真实快照是
  本项目有史以来的第一个真实群体数据点。

感兴趣，或想先看快照格式？请发电子邮件至
**dannyphan190@gmail.com**。

## 为什么不"阻止 CDP"或注入恶意提示？

旧的 `Error.stack` 序列化技巧已被 V8 的变化削弱；独立研究记录了客户端阻止的局限性。DOM 提示注入是不可信数据，不是可靠或合乎道德的安全控制。见[参考资料](docs/REFERENCES.md)。

## 贡献 / 安全 / 局限性

请阅读 [CONTRIBUTING.md](.github/CONTRIBUTING.md)、[SECURITY.md](.github/SECURITY.md)、[docs/LEGAL_PRIVACY.md](docs/LEGAL_PRIVACY.md) 和 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

**项目资助：** [支持维护者](https://www.paypal.com/paypalme/dannyphan190)（可选；使用本项目永远不需要）。
