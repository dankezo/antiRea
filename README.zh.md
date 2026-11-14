<p align="center">
  <img src="logo.svg" alt="antiRea logo" width="104">
</p>

<h1 align="center">antiRea</h1>

<p align="center">
  <strong>Build it. Ship it. Keep it yours.</strong>
</p>

<p align="center">
  antiRea 是一个服务器端 TypeScript 库，按身份计量数据集访问，并标记
  协同性的机器人滥用行为：批量提取团队、按计划行动的群体、占座。
  它只提供咨询性信号：它负责标记，由你决定如何处理。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://www.npmjs.com/package/@dannyphan190/anti-rea"><img src="https://img.shields.io/npm/v/@dannyphan190/anti-rea.svg" alt="npm version"></a>
  <a href="https://github.com/dankezo/antiRea/actions/workflows/ci.yml"><img src="https://github.com/dankezo/antiRea/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="tests/"><img src="https://img.shields.io/badge/tests-963%20total-informational" alt="tests: 963 total"></a>
</p>

<p align="center">
  <a href="https://antirea.dannyphan.me">Website</a> -
  <a href="docs/THREAT_MODEL_REA.md">威胁模型</a> -
  <a href="docs/LIMITATIONS.md">局限性</a> -
  <a href="CHANGELOG.md">更新日志</a>
</p>

<p align="center">
  <a href="README.md">English</a> - <a href="README.vi.md">Tiếng Việt</a> - 中文 - <a href="README.es.md">Español</a>
</p>

---

## 问题，30 秒讲清

克隆工具可以观察你的应用的页面、代码包和流量，然后把看到的东西重建
出来。你无法隐藏浏览器已经收到的代码，所以 antiRea 防守的是另一面：
数据本身。

**没有保护时。** 任何拥有账号的人都能把你的数据带回家。在我们的测试
中，一个账号在不到 200 个请求内就带走了全部 10,000 条记录的数据集。
悄无声息。日志里没有任何异常。

**有保护时。** 真实用户不会察觉任何变化。
每个身份最多只能收到一个有上限的切片，在我们的测试配置中是数据集的
20%，因此批量复制不再是一次导出，而变成了一个身份问题。
把工作分摊到多个账号，群体检测器会标记这种协同行为。

- 那个用 1 个账号拿走一切的运行，被**拦截在 5%**。
- 一个坚持要完成的脚本化团队需要 **25 个身份和约 19 分钟**，并且在
  途中被标记。

> 没有保护时，你的数据完整、免费、无痕地流出。
> 有保护时，它分片流出、付出代价、并留下记录。

完整数字见：[实测结果](#效果如何实测结果)。

## 安装

```bash
npm install @dannyphan190/anti-rea
```

Node.js 20+。零运行时依赖。
也可以通过 [GitHub Release](https://github.com/dankezo/antiRea/releases) 获取。

## 快速开始

请求配额限制速度。记录预算限制一个身份总共能收到数据集的多少，无论
它问得多么有礼貌。

```ts
import { createRecordBudget, createHerdDetector } from "@dannyphan190/anti-rea";

// 一个身份每天最多收到 2,000 条不同的记录。
const budget = createRecordBudget({ maxDistinctPerWindow: 2_000 });
const herd = createHerdDetector({
  onFlag: snap => { /* snap.band: "budget_cut_supported" | "graduated_only" */ },
});

// 在处理器运行之前检查：
if (!budget.check("account:123", 1).allowed) { /* 返回 429 */ }

// 然后记录响应实际提供的内容：
budget.consume("account:123", recordIdsServed);
herd.observe({ type: "list", identity: "account:123", ip: serverSeenIp, recordIds: recordIdsServed });
```

两处使用相同的身份字符串（`account:<id>`），群体标记就可以通过
`applyHerdLadder()` 直接触发一次预算削减。

## 里面有什么

四个组。从上往下开始；每一层相互独立。

| 组 | 用大白话说它做什么 | 主要组件 | 坦白的局限 |
|---|---|---|---|
| **Meter** | 限制一个身份总共能收到多少数据，以及能以多快的速度收到 | 记录预算（`createRecordBudget`）、配额与分页守卫（`createQuotaGuard`）、计价导出（`createExportGuard`）、会话游标（`mintCursor` / `verifyCursor`）、流评分（`createFlowScorer`） | 攻击者可以轮换身份：请在你这边配合真实的注册成本 |
| **Ownership** | 发现一个身份横扫他人对象的行为（BOLA/IDOR 式遍历：顺序 id、随机 id，或数小时的慢速铺开），并附证据报告 | 所有权探针（`createOwnershipProbe`）：按身份统计滚动窗口内不同所有者的占比（默认 1 小时，慢速横扫可加 6 小时），公共路由豁免，增量状态、O(1) 读判定；仅 advisory | 标记只是一种形态，不是证据，授权仍是你的职责，低于地板或集中于少数所有者的横扫不在其范围内 |
| **Watch** | 发现协同行为：许多身份悄悄地把你的数据集铺满、试探诱饵，或者挤占一个房间 | 群体检测器（`createHerdDetector` + `applyHerdLadder`）、相位信号（`createHerdPhaseSignal`、`createActivityPhaseSignal`）、房间守卫（`createRoomGuard`）、金丝雀陷阱与诱饵（`handleCanaryTrapRequest`、`createCanaryMaze`、`createDecoyMirage`）、自动化遥测（`detectAutomationSignals`）、source map 卫生检查（`verify-build.py` / `run-audit.cjs`）、按量排名规则（`applyVolumeRankRule`）、经验混合校准（`selectEmpMixThreshold`）、会话时序特征（`computeHoldTypeFeatures` / `createHoldTypeScorer`）、早期最小占用信号（`createOccupancyEarlyMinimalSignal`） | 检测不等于执法：低铺放的群体得到的是渐进式响应，而且有一个自适应群体被标记后仍然完成了任务 |
| **Prove** | 把一个裁决的含义固定下来：是哪个配置产生了它、到底是谁签的名、什么可以作为后果的依据 | 配置溯源（`createConfigProvenance`）、Web Bot Auth 验证（`createWebBotAuthVerifier`）、step-up 证明（`issueStepUpProof`、`createStepUpProofVerifier`）、step-up 后果塑形（`createStepUp402Responder`）、证据角色（`evidentiaryRoleOf`、`auditEvidencePack`、`decorateSignalResult`） | 已验证的签名是身份，不是授权：你的权限检查保持原样，一点不变 |
| **Trace** | 可选的客户端辅助工具，用于泄漏追踪和重放防护 | 上下文绑定信封（`encryptPayload` / `decryptPayload`、`createInMemoryReplayGuard`）、取证水印（`mountForensicWatermark`）、偏好声明日志（`createDeclarationLog`） | 是可追溯性，不是访问控制：覆盖层可以被裁剪，浏览器也保管着它自己的上下文 |

**推荐顺序：** 先配额守卫（见下文），然后是记录预算，再然后是群体
检测。

## 效果如何？实测结果

**方法简述。** 我们用 **Ledgerly** 进行测试：一个合成 SaaS，120 个账号
背后放着 10,000 条记录，运行两次：一次无保护，一次在同一个应用上接入
antiRea。攻击运行由 REA 6.8.0（`rea-agents`）以及遵循标准克隆流程的
通用智能体驱动；礼貌用户的运行用来衡量对合法流量的代价。一份独立基准
测试发布在 [issue #1](https://github.com/dankezo/antiRea/issues/1)：
大部分主张都经受住了检验，它发现的缺口已经修复并记录在更新日志中。
完整方法和逐层结果表见：[docs/EVIDENCE.zh.md](docs/EVIDENCE.zh.md)。

| 层 | 核心结果 |
|---|---|
| 无保护（基线） | 全部 10,000 条记录的数据集在 **160-193 个请求**内流出 |
| 记录预算 | 一个身份被恰好限制在数据集的 **20%** |
| 群体检测 + CUSUM 证据 | REA 风格的身份轮换被拦截在 **5%**；一个自适应团队需要 **25 个身份和约 19 分钟** |
| 声明的群组上限 | 群组的并集恰好停在 **600 条记录**，超过上限后零提供 |
| 合法用户 | 已声明团队 **1,200/1,200，零摩擦**；礼貌用户零后果 |
| 动作预算（实验室） | 功能滥用群体完成了 **16/80 次操作（20%）**；普通用户 **48/48**，零后果 |
| 咨询性信号（实验室） | 五个慢形态信号：在合法流量上的误报率为 **0-1.67%**，逐信号数字见完整表格 |

**这些结果意味着什么。** 随手的一次性克隆没有了。批量提取变成了身份
问题：每多拿一片，就要多付一个账号的代价，多暴露一份可见性。它挡不住
一个有决心、有资源的重建者，而一个身份的真实价格（注册摩擦、已验证
账号、付费）由你来定，这正是预算按身份计算、群体标记区分"削减预算"
和"加强审查"的原因。

## 也会说 MCP

antiRea 附带一个面向 AI 智能体的官方 MCP 服务器：
[`@dannyphan190/anti-rea-mcp`](https://www.npmjs.com/package/@dannyphan190/anti-rea-mcp)
（[源代码](https://github.com/dankezo/anti-rea-mcp)），基于官方的
`@modelcontextprotocol/sdk` 构建，通过 stdio 说 MCP。

它把库的八种咨询性信号以六个工具的形式暴露出来：`list_signals`、
`create_signal`、`observe`、`observe_reference`、`evaluate`、
`close_signal`，让智能体可以打开一个信号会话、喂入事件并读取裁决。

```json
{
  "mcpServers": {
    "anti-rea": {
      "command": "npx",
      "args": ["-y", "@dannyphan190/anti-rea-mcp"]
    }
  }
}
```

这是一个评估和演示通道。生产环境的保护仍然属于进程内、属于你自己的
应用。

## 最新版本

### v2.9.2 - 审计与加固

精确比较 token、限制遥测状态、修正乱序事件的 ownership 窗口、为无效会话返回有限数值，并安全处理带环的字段结构。所有后果仍由主机决定，运行时依赖仍为零。

本次 Windows 本地审计运行 963 项测试：960 项通过、0 项失败、3 项跳过（两个 RSA-PSS 向量和一个缺少符号链接权限的用例）。下方历史实验室数字保留原始适用范围；缺失生成器的项目明确标为 NOT VERIFIED。

[2.9.2 deep dive](docs/v2.9.2-deep-dive.zh.md) | [Audit measurements](docs/audit-2.9.2.json)

### v2.9.1：402 形式的 step-up 答复，与五个实验室毕业模块

[2.9.1 deep dive](docs/v2.9.1-deep-dive.zh.md)

> volume-rank 实验室分层来自生成器成分，SDK 则按观测流量分组。重跑在 kappa 1000 时得到 HIGH 层 1/115 个误报，因此历史 0.007 并非 SDK 重新分组后的通用上限。


- **问题：** step-up 挑战只是叫机器调用方停下，却没有给它任何可机器
  读取的行动依据；同时研究实验室还有五个毕业成果一直没有建成，其
  中包括房间占用规则里已公开声明的 A1 漏洞。
- **新模块 `createStepUp402Responder`：** 把 step-up 触发的后果塑
  形成 x402 风格的 HTTP 402 响应：`X-Payment-Required` 头，加
  上带有 pay、appeal、continue-free 后续步骤的 manifest 正文，
  以及用于会话 token 的 `checkAssertion`。没有结算、没有支付
  处理，价格只是一个信号。实验室实测（RECOMB-09，PASS-lab）：
  合作型 agent 在 94.5% 的会话中撤退、在 94.0% 中出示了有效
  assertion；200 个浏览器会话与 200 个 API 会话中合法
  dead-end 为 0。忽略 manifest 的 agent 不受影响，这就是该格式
  诚实的上限。
- **新模块 `createDeclarationLog`：** 一个仅追加、哈希链相连的主
  机侧日志，证明某个偏好声明（robots.txt 的 Content-Signal 行、
  RSL 的 License 行、aipref 的 Content-Usage）在被转载的副本出
  现之前就已存在；它与 C39 值水印（`createValueWatermark`）配
  对，后者才是能在转载后存活下来的部分。实验室实测
  （RECOMB-10，PASS-lab）：带声明的一臂在 18/18 个门控单元上与
  仅水印一臂持平（100%），200 个诚实数据集上错误归因为 0，日志
  200/200 验证通过。日志只证明顺序与完整性，既不证明爬虫遵
  守，也不构成法律承认。
- **新信号 `applyVolumeRankRule`：** 在成交量分层（冻结边界
  63.2 / 632.5）上执行 R2 规则：当某身份至少 2 个稀有单元格按
  双分量 EB05 分数排进全部单元格的前 5% 时，该身份被标记（前
  10% 仅描述性报告）。实验室实测（RECOMB-04，PASS-lab）：MID
  层 walker 检出在 kappa 100 / 300 / 1000 时为 0.90 / 0.85 /
  0.85；纳入门限的 kappa 100/300/1000 上，每个至少含 20 个合法身份的分层中合法误报至多 0.007；
  检出只在 MID 层测得，因为所有 walker 都活在那里。
- **新工具 `selectEmpMixThreshold`：** 用于聚类阈值选择的经验混
  合校准规则：在 50/50 校准集（零假设置换加平坦经验森林）上读
  取混合 FMR，选混合 FMR 至多 1% 的最大网格点，无一合格时为
  null。实验室实测（RECOMB-05，PASS-lab，仅 R14 分支 C 框
  架）：混合集在 0-30% 污染下把选择保持在 h = 0.36，而仅用零
  假设的集合在 10% 处翻转，并未通过平坦误报门。
- **新特征 `computeHoldTypeFeatures` / `createHoldTypeScorer`：**
  五个会话时序特征（鼠标事件率、点击时长标准差、按键保持标准
  差、按键间隔标准差、程序化输入比例 s_type），以及冻结的带符
  号 z 复合分数 S_R2（含 set2/type 子分数），对照主机提供的人
  类参考分布评分。RECOMB-02 仅为 PASS-LAB Step 0：只测了特征
  分离度，不发布任何检出主张，阈值留在主机侧（实验室用的是人
  类复合分布的外侧 5% 尾部）。
- **新信号 `createOccupancyEarlyMinimalSignal`：** 针对新身份的
  A1 反制：身份在加入前不到 24 小时创建、迄今保持 1-2 个
  activity、每个 activity 都在加入后 300 秒内；D2-FAST 在占比
  至少 0.50 持续 600 秒时标记，D2-DRIP 在至少 0.34 持续 3600
  秒时标记。实验室实测（A1-COUNTER-D2，PASS-lab）：快速 squat
  在 +690 秒被标记，DELAY-300 在 +960 秒，drip 在 +1440 秒，
  合法孪生与新 lurker 单元均未被标记，但 lurker 门只以恰好一
  个会话的余量通过（d2max 0.3333 对 drip 线 0.34），首次
  activity 延迟落在（300 秒，~630 秒）区间会按设计绕过两条规
  则，3 个 activity 的 squat 按构造绕过。仅 advisory。

### v2.9.0：surface guard 与已声明 cohort 模式

- **问题：** 预算限制的是一个身份能拿走多少，而不是一个响应能携带什么。
  现实中反复出现的泄露正是一个过宽的负载：个人资料或搜索响应顺带带出
  密码哈希、身份证号和银行账号（Spoutible 2024、eHUST 学生数据泄露、
  Power Apps 2021）。入站方向的镜像问题是批量赋值--一次写入仅仅因为
  调用方提交了 `role` 或 `owner_id` 就把它们绑定了。
- **新模块 `createSurfaceGuard`：** 按内置的敏感/特权字段 denylist 加上
  你按路由声明的 allowlist，双向检查 JSON 负载。默认仅咨询；只有你
  明确要求时才 strip 或 block。在带种子语料上测量：2,000 个合法响应
  与 2,000 个合法请求误报为 0；注入的敏感字段捕获 1,194 / 1,194，
  注入的特权字段捕获 918 / 918。
- **新模式--已声明 cohort 的联合预算：** 15 秒内掏空测试靶场的那次
  herd 突发有了成文的答案：一个以主机声明的 cohort id 为键的记录
  预算，使已声明 cohort 内部的身份轮换不再稀释上限（可运行示例，
  附验证：[examples/declared-cohort-budget](examples/declared-cohort-budget)）。
- 完整说明：[v2.9.0 深入解析](docs/v2.9.0-deep-dive.zh.md)；
  上一版：[v2.8.1 深入解析](docs/v2.8.1-deep-dive.zh.md)。

### v2.8.1：span 门修复

- **问题：** 在一个网格周期（默认 900 秒）的一小部分时间内，herd-phase
  和 activity-phase 信号可能确认一个只是短暂同步的群体。在本项目自己
  的测试靶场上，12 名合法读者在 40 秒的窗口内被确认。
- **修复：** 现在，一个成员只有当它的事件跨度至少覆盖一个完整的网格
  周期时才被计数；只有符合条件的成员会被点名，结果中也新增了
  `spanEligibleMembers` 字段。
- 完整说明：[v2.8.1 深入解析](docs/v2.8.1-deep-dive.zh.md)。

### v2.8.0：房间守卫，外加一个证据层

- **`createRoomGuard`** 以 30 秒为 tick 监视一个共享房间：加入爆发、
  流失，以及被新鲜、沉默的账号占据的座位。它只对新加入者建议
  step-up，已在座的成员永远不会被点名或触及。有一个漏洞被公开声明：
  占座者只要发出哪怕 1-2 条消息，就离开了占用（occupancy）的定义。
- **一个证据层**，由四个小模块组成，把每个裁决的含义固定下来：它背后
  确切的配置（CS-02）、身份验证能证明什么和不能证明什么（BS-01）、
  一次性的、证明某个 step-up 已被通过的凭证（CAP-01），以及哪些证据
  可以作为后果的依据（KT-01）。
- 在实验室 pin 中，flood 在 +60 秒被标记，churn 在 +30 秒，占座在
  +690 秒，而压力在五个合法单元格中从未触发，包括一个 60% 的在座
  会话从不发一言的观众单元格。
- 一切都是新增且仅具咨询性；默认值没有任何变化。
- 完整说明：[v2.8.0 深入解析](docs/v2.8.0-deep-dive.zh.md)；
  上一版：[v2.7.4 深入解析](docs/v2.7.4-deep-dive.zh.md)。

## 第一步：配额守卫

服务器端配额和分页边界，按账号、API 密钥和 IP 强制执行。返回 HTTP
`429` 并带 `Retry-After`，同时为运营者记录结构化事件。

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
    accountId: req.headers.get("x-verified-account") ?? undefined, // 来自你的服务器认证
    apiKeyId: req.headers.get("x-verified-key-id") ?? undefined,
    tier: "free",
  }),
  onQuotaExceeded: event => {
    console.warn("[quota-exceeded]", event);
  },
}));
```

### 更多模式

- **金丝雀端点**：记录异常试探的陷阱路由，带路径规范化，让变体无法
  溜过去。
  可运行示例：[examples/node-canary-server.cjs](examples/node-canary-server.cjs)。
- **带签名的智能体**：验证 Web Bot Auth（RFC 9421）签名，并对一个稳定
  的身份执行配额策略。可端到端运行的演示：
  [examples/web-bot-auth-verify.cjs](examples/web-bot-auth-verify.cjs)。
- **Python / FastAPI**：配额守卫的移植版，层级、`429` 语义和分页边界
  完全相同，并遵循同一套测试契约：
  [examples/python-fastapi](examples/python-fastapi)。
- **共享群组上限与 CUSUM 证据引擎**：对整个已声明群组的事务性预留，
  以及受保护群组（其遥测会累积，但永远不会招致后果）：语义见
  [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。
- **水印与信封**：见上面的 Trace 组；永远不要把某个人的邮箱、IP 或原始
  用户 ID 嵌入水印像素。

## 坦白的局限

- 它**不能**隐藏交付给浏览器的代码，也不能阻止任何人检查自己的浏览器
  下载到的内容。
- 它**不能**挡住一个有决心、有资源的重建者。它的作用是让批量复制变得
  缓慢、昂贵且可见。
- 证据引擎的内置表格是在实验室轨迹上拟合的，不是在真实用户群体上，
  并且在所有被提及的地方都标有 `uncalibrated: true`。见下文的校准试点。
- 客户端组件是可追溯性辅助工具，不是访问控制。
- 没有客户端机器人拦截技巧，也没有提示词注入：它们站不住脚，也不是
  合乎伦理的控制手段。
  见 [docs/REFERENCES.md](docs/REFERENCES.md)。

完整列表：[docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

## 复现这些数字

本仓库附带一个 Playwright 测试工具，在 Chromium、Firefox 和 WebKit 上，
以基线模式（`:4173`）和受保护模式（`:4174`）运行一个合成 SaaS
（**Northstar**：仪表板、客户搜索、线索创建、CSV 导出、图表视图）。

```bash
npm install
npm run build && npm run benchmark:build-sdk
python -m pip install playwright
python -m playwright install chromium firefox webkit
python benchmark/run_all.py --browsers chromium,firefox,webkit --iterations 5
```

在本仓库本身上工作：`npm run check` 会编译代码、运行 **963 个自动化
测试**（960 个通过，Windows 跳过两个 RSA-PSS 向量和一个符号链接权限用例），并执行静态检查。在部署
前扫描公开构建：`node scripts/run-audit.cjs /path/to/dist` 或
`python3 scripts/verify-build.py /path/to/dist`。

## 帮忙校准

这个项目唯一无法为自己生成的东西，就是真实流量。如果你运行 antiRea
（或者正在评估它），请把 CUSUM 绊线以 `mode: "observe"` 运行，越线会被
记录，什么都不会被限制，并分享它发出的**匿名化聚合快照**：群组规模、
分数、并集记录数。

不要原始用户数据，不要记录内容，不要标识符。发送前请检查并剥离快照；
如果某个字段看起来具有识别性，就把它去掉并说明。第一批真实快照，就是
`uncalibrated` 标签被摘掉的方式。

感兴趣，或者想先要快照格式？
请发邮件至 **dannyphan190@gmail.com**。

## 文档

- [威胁模型](docs/THREAT_MODEL_REA.md)：antiRea 对攻击者的假设
- [局限性](docs/LIMITATIONS.md)：它不做什么
- [证据](docs/EVIDENCE.zh.md)：完整的实测结果和方法
- [法律与隐私说明](docs/LEGAL_PRIVACY.md)
- 深入解析：[v2.9.0](docs/v2.9.0-deep-dive.zh.md) - [v2.8.1](docs/v2.8.1-deep-dive.zh.md) - [v2.8.0](docs/v2.8.0-deep-dive.zh.md)
- [v2.9.1 deep dive](docs/v2.9.1-deep-dive.zh.md)
- [v2.9.2 deep dive](docs/v2.9.2-deep-dive.zh.md)
- [更新日志](CHANGELOG.md)

## 贡献与安全

在打开 pull request 或漏洞报告之前，请先阅读
[CONTRIBUTING.md](.github/CONTRIBUTING.md) 和
[SECURITY.md](.github/SECURITY.md)。

**项目资助：** [支持维护者](https://www.paypal.com/paypalme/dannyphan190)
（可选；使用本项目从不以此为必要条件）。

<p>
  Featured on
  <a href="https://launchnest.io/p/antirea" target="_blank"><img src="https://launchnest.io/badge/antirea.svg?variant=featured" alt="antiRea on LaunchNest" width="160" height="40" /></a>
</p>
