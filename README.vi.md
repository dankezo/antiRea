# antiRea

**Bảo vệ phần giá trị thật của ứng dụng, không dựa vào ảo tưởng rằng giao diện có thể bị giấu khỏi trình duyệt.**

**Bộ công cụ đánh giá rủi ro · TypeScript SDK · AI Agent Skill**

[English](README.md) · [中文](README.zh.md) · [Español](README.es.md) · [Mô hình rủi ro](docs/THREAT_MODEL_REA.md) · [Giới hạn](docs/LIMITATIONS.md) · [Changelog](CHANGELOG.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@dannyphan190/anti-rea.svg)](https://www.npmjs.com/package/@dannyphan190/anti-rea)
[![CI](https://github.com/dankezo/antiRea/actions/workflows/ci.yml/badge.svg)](https://github.com/dankezo/antiRea/actions/workflows/ci.yml)
[![độ phủ dòng của dist](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dankezo/antiRea/badges/badges/coverage.json)](https://github.com/dankezo/antiRea/blob/main/docs/LIMITATIONS.md)
[![tests](https://img.shields.io/badge/tests-815%20passing-informational)](tests/)

antiRea giúp bạn kiểm tra những gì website để lộ, áp dụng giới hạn quota/phân trang phía server, giữ logic quan trọng ở backend và dùng canary hoặc watermark khi phù hợp. Công cụ **không thể** ngăn người dùng kiểm tra dữ liệu đã gửi tới trình duyệt của họ.

## Câu chuyện ngắn

**Một web bình thường, không bảo vệ.** Ai có tài khoản cũng mang được dữ liệu về nhà. Trong bài test của chúng tôi, chỉ 1 tài khoản và 1 lệnh xuất dữ liệu đã lấy trọn bộ 10.000 bản ghi trong chưa tới 200 request - lặng lẽ, không để lại gì bất thường.

**Cũng web đó khi gắn antiRea.** Người dùng thật không thấy khác biệt gì. Nhưng dữ liệu được tính giá theo từng bản ghi: một danh tính chỉ nhận tối đa một lát cắt giới hạn (20% bộ dữ liệu trong cấu hình test), nên trích xuất hàng loạt không còn là chuyện bấm nút export mà thành bài toán danh tính. Rải việc qua nhiều tài khoản thì bộ phát hiện bầy đàn gắn cờ sự phối hợp đó. Kết quả đo được (vòng kinh điển v2.5.0): lượt REA-style vốn chỉ cần 1 tài khoản khi không bảo vệ đã bị **chặn ở 5% bộ dữ liệu**, và một nhóm slicing chạy script quyết lấy trọn bộ đã tốn **25 danh tính và ~19 phút**, bị cả bộ phát hiện bầy đàn lẫn bộ máy bằng chứng gắn cờ trên đường đi.

Không bảo vệ, dữ liệu ra đi **trọn gói, miễn phí, vô hình**. Có bảo vệ, nó ra đi **từng lát, có giá, và có dấu vết**. Toàn bộ số đo nằm ở mục [Hiệu quả đã đo được](#hiệu-quả-đã-đo-được) phía dưới.

Cài đặt từ npm:

```bash
npm install @dannyphan190/anti-rea
```

Bạn cũng có thể cài từ [GitHub Release](https://github.com/dankezo/antiRea/releases).

## Mới trong v2.8.1

Một bản vá với đúng một sửa chữa: cổng span cho các tín hiệu pha. Bên trong một phần của một chu kỳ lưới (mặc định 900 giây), pha sự kiện của mọi quần thể đều nằm trong một cung nhỏ, nên tín hiệu herd-phase và activity-phase (`createHerdPhaseSignal`, `createActivityPhaseSignal`) có thể xác nhận nhầm một quần thể trong cửa sổ ngắn - lỗi này lộ ra ngay trên range kiểm thử của chính dự án, nơi 12 độc giả hợp lệ bị xác nhận ở R_cohort 1.0000 trong một cửa sổ 40 giây. Nay việc xác nhận đòi hỏi thêm mỗi thành viên được tính phải có khoảng sự kiện phủ ít nhất một chu kỳ lưới đầy đủ, chỉ thành viên đủ điều kiện mới bị nêu tên, và kết quả có thêm trường mới `spanEligibleMembers`. Bản đầy đủ: [Tìm hiểu sâu v2.8.1](docs/v2.8.1-deep-dive.vi.md).

## Mới trong v2.8.0

Nói ngắn gọn: room guard mà 2.7.3 đã chủ động không ship nay đã có mặt - được xây lại theo một pin đăng ký trước mới, kèm đúng vế occupancy mà nó từng thiếu - và đi cùng nó là một lớp bằng chứng gồm bốn module nhỏ, chính xác, chốt rõ ý nghĩa của mọi phán quyết từ các tín hiệu còn lại: cấu hình nào đã tạo ra nó, xác minh danh tính chứng minh được gì và không chứng minh được gì, một lượt step-up đã qua được ghi nhớ ra sao, và bằng chứng nào được phép làm căn cứ cho hậu quả. Mọi thứ đều là cộng thêm và chỉ tư vấn; đường mặc định không đổi.

- **Lần này là guard trọn vẹn.** `createRoomGuard` đánh giá một phòng theo tick 30 giây trên bốn đường đóng băng: burst, sustained và churn (tốc độ join so với baseline của chính phòng, mức tập trung tài khoản mới, mức bất hoạt sau join, churn rời phòng nhanh) cộng thêm occupancy - tỉ lệ ghế bị tài khoản mới và im lặng giữ, duy trì liên tục. Trong pin lab RECOMB-06 (mô phỏng bằng seed, 20.161 tick mỗi ô), pressure không bao giờ bật ở năm ô hợp lệ, kể cả ô khán giả karaoke mà 60% session ghế không nói một lời; flood bị gắn cờ ở +60 giây, drip ở +32,5 phút, churn ở +30 giây, và ô chiếm ghế mà tổ hợp 2.7.3 bỏ sót hoàn toàn bị gắn cờ ở +690 giây nhờ vế occupancy. Đầu ra của nó là trạng thái phòng và một khuyến nghị step-up chỉ cho lượt join MỚI - thành viên đang ngồi không bao giờ bị nêu tên hay đụng chạm. Một lỗ được khai mở trong tài liệu, không chôn giấu: kẻ chiếm ghế chỉ cần chat 1-2 câu là thoát khỏi định nghĩa zero-activity của vế occupancy.
- **Một lớp bằng chứng, từ bốn cuộc giải phẫu.** `createConfigProvenance` (CS-02) băm cấu hình hiệu lực của một tín hiệu (chuỗi hóa canonical cộng SHA-256) để mọi phán quyết đều nêu được đúng detector đã tạo ra nó - bản port phát hành tái lập digest của probe lab từng byte. `classifyWebBotAuthVerdict` và `classifyHostVerificationFact` (BS-01) đóng băng ngữ nghĩa verified-neutral: danh tính đã xác minh làm mức nghi ngờ dịch đúng 0, mọi lỗi mơ hồ đều là "unverified", và chỉ giả mạo đã chứng minh mới là bằng chứng. `issueStepUpProof` và `createStepUpProofVerifier` (CAP-01) cho host một proof Ed25519 dùng một lần, chứng minh một danh tính đã qua một thử thách cụ thể dưới một cấu hình cụ thể. `evidentiaryRoleOf`, `auditEvidencePack` và `decorateSignalResult` (KT-01) ghi thành luật vai trò bằng chứng của từng kênh và khiến một gói bằng chứng chỉ gồm corroborating trở nên không đủ điều kiện cho hậu quả một cách cơ học.

Bản kỹ thuật đầy đủ: [Tìm hiểu sâu v2.8.0](docs/v2.8.0-deep-dive.vi.md). Bản phát hành trước thay đổi những gì: [Tìm hiểu sâu v2.7.4](docs/v2.7.4-deep-dive.vi.md).
## Bộ khung benchmark trình duyệt

Repo kèm một bộ khung Playwright chạy SaaS giả lập (**Northstar**: dashboard, tìm kiếm khách hàng, tạo yêu cầu, xuất CSV, biểu đồ) ở hai chế độ **baseline (`:4173`)** và **protected (`:4174`)** trên Chromium, Firefox và WebKit - bản tái lập được ngay trong repo, đi cùng mục kết quả đã đo ở dưới.

```bash
npm install
npm run build && npm run benchmark:build-sdk
python -m pip install playwright
python -m playwright install chromium firefox webkit
python benchmark/run_all.py --browsers chromium,firefox,webkit --iterations 5
```

## antiRea giải quyết vấn đề gì?

Các công cụ như [morluto/rea](https://github.com/morluto/rea) hỗ trợ quan sát DOM, phân tích JavaScript bundle, theo dõi mạng và tái lập UI.

Mục tiêu của dự án là giúp chủ sở hữu và cộng đồng triển khai biện pháp **thực chất, hạn chế tác dụng phụ, có bằng chứng đo đạc**.

## Hiệu quả đã đo được

**Phương pháp, nói ngắn.** Chúng tôi kiểm thử trên **Ledgerly**, một SaaS giả lập chứa 10.000 bản ghi sau 120 tài khoản, chạy hai bản: baseline không bảo vệ và protected có gắn antiRea trên *cùng* một ứng dụng. Các đợt tấn công được điều khiển bằng REA 6.8.0 (`rea-agents`) và bằng các agent đa năng đi theo quy trình clone tiêu chuẩn; các lượt chạy đối chứng bằng người dùng lịch sự đo cái giá đối với traffic hợp lệ. Một benchmark độc lập về chính repo này đã được công bố tại [issue #1](https://github.com/dankezo/antiRea/issues/1); phần lớn claim trụ vững qua đợt kiểm đó, và các điểm yếu nó tìm ra đều đã được sửa và ghi lại trong changelog. Phần phương pháp đầy đủ và bảng kết quả chi tiết theo từng lớp nằm ở [docs/EVIDENCE.vi.md](docs/EVIDENCE.vi.md).

| Lớp | Kết quả tóm tắt |
|---|---|
| Không bảo vệ (baseline) | Toàn bộ bộ dữ liệu 10.000 bản ghi ra đi trong **160-193 request** |
| Ngân sách bản ghi | Một danh tính bị giữ ở đúng **20%** bộ dữ liệu |
| Phát hiện bầy đàn + bằng chứng CUSUM | Lượt luân phiên danh tính kiểu REA bị chặn ở **5%**; đội tấn công thích ứng tốn **25 danh tính và ~19 phút** |
| Trần cohort khai báo | Union của cohort dừng ở đúng **600 bản ghi**, 0 bản ghi được phục vụ quá trần |
| Người dùng hợp lệ | Đội đã khai báo **1.200/1.200, 0 ma sát**; người dùng lịch sự 0 hậu quả |
| Ngân sách hành động (lab) | Đàn lạm dụng tính năng hoàn thành **16/80 thao tác (20,0%)**; người dùng thường **48/48**, 0 hậu quả |
| Tín hiệu tư vấn (lab) | Năm tín hiệu cho các hình dạng chậm: gắn cờ nhầm **0-1,67%** trên traffic hợp lệ - số chi tiết trong bảng đầy đủ |

Bảng đầy đủ theo từng lớp, kể cả các điểm mù ghi ngay trong chính các ô của nó: [docs/EVIDENCE.vi.md](docs/EVIDENCE.vi.md).

**Tổng kết lại.** Stack này loại bỏ kiểu clone một-phát-xong ở tầng casual, và biến trích xuất hàng loạt thành bài toán danh tính: mỗi lát dữ liệu thêm tốn thêm một tài khoản và thêm dấu vết. Nó không chặn được người tái dựng quyết tâm và có nguồn lực, và cái giá thật của một danh tính (ma sát đăng ký, tài khoản đã xác minh, thanh toán) là do bạn, phía host, đặt ra - đó là lý do ngân sách được ép theo danh tính và cờ bầy đàn phân biệt "cắt ngân sách" với "tăng mức soi" thay vì dùng một phản ứng cùn cho mọi trường hợp.

## Bốn tầng và ưu tiên triển khai

| Ưu tiên | Tính năng | Lợi ích có thể kỳ vọng | Giới hạn |
|---|---|---|---|
| **P0 - nền tảng** | Middleware giới hạn quota/phân trang (`createQuotaGuard`), phân quyền từng bản ghi, giữ thuật toán/secret ở backend | Đảm bảo an toàn cốt lõi chống scraping hàng loạt | Không giấu được dữ liệu đã trả về cho tài khoản hợp lệ |
| **Tầng 1** | Quét và chặn lộ source map (`verify-build.py` / `run-audit.cjs`); thông báo bản quyền; chữ ký dấu vết SVG/text | Ngăn lộ mã nguồn gốc ngoài ý muốn | Không ngăn được người cố tình xóa marker |
| **Tầng 2** | API canary chuẩn hóa đường dẫn (`handleCanaryTrapRequest`), mê cung canary xác định (`createCanaryMaze`), route mồi (`createDecoyMirage`), tín hiệu automation (`detectAutomationSignals`) và kiểm chứng chữ ký Web Bot Auth (`createWebBotAuthVerifier`) cho agent tự ký request | Ghi nhận truy cập bất thường để điều tra; nhận diện agent có chữ ký để chính sách quota bám theo danh tính ổn định | Không dùng làm rào cản chặn tuyệt đối; chữ ký hợp lệ là danh tính, không phải phân quyền |
| **Tầng 2 - Kinh tế dữ liệu** | Ngân sách theo bản ghi (`createRecordBudget`), xuất dữ liệu tính phí (`createExportGuard`), cursor nối chuỗi theo phiên (`mintCursor` / `verifyCursor`), chấm điểm chuỗi hành vi (`createFlowScorer`) | Chặn trần lượng dữ liệu một danh tính nhận được; trích xuất trọn bộ phải trả giá bằng nhiều danh tính (đã đo: trần 20% mỗi danh tính trong kiểm thử của chúng tôi) | Kẻ tấn công xoay vòng danh tính - cần kết hợp cái giá đăng ký thật ở phía host |
| **Tầng 2 - Phát hiện bầy đàn** | Bộ phát hiện bầy đàn xuyên danh tính (`createHerdDetector`) với bậc thang phản ứng (`applyHerdLadder`) | Gắn cờ các nhóm danh tính cùng nhau lát kín bộ dữ liệu, kể cả khác IP; nhóm lát dày bị cắt ngân sách, nhóm lát mỏng nhận phản ứng bậc thang | Với bầy lát mỏng, phát hiện không đồng nghĩa cưỡng chế - một bầy thích ứng kỷ luật đã bị gắn cờ nhưng vẫn hoàn tất (xem mục hiệu quả đã đo) |
| **Tầng 3** | AES-GCM ràng buộc ngữ cảnh (`encryptPayload` / `decryptPayload`) kèm chống phát lại giới hạn bộ nhớ (`createInMemoryReplayGuard`) | Bảo đảm toàn vẹn và chống phát lại thông điệp | Trình duyệt vẫn giải mã được nếu giữ khóa |
| **Tầng 4** | Watermark hiển thị token phiên tạm thời (`mountForensicWatermark`) | Hỗ trợ truy vết bản chụp khi token còn hiện rõ | Không chống được cắt/chỉnh sửa ảnh |

**Khuyến nghị mặc định:** thực hiện P0 trước, sau đó cấu hình Tầng 1. Với website có API quan trọng, bật quota guard và honeypot/canary.

## Cài đặt và kiểm thử

Cần Node.js 20+. Repo **không có runtime dependency**; để build cần TypeScript (được khai báo là devDependency).

```bash
npm install
npm run check
npm run build
```

`npm run check` gồm biên dịch, **817 kiểm thử tự động** (815 đạt, 2 vector RSA-PSS bị bỏ qua) và kiểm tra tĩnh. Có thể quét thư mục build công khai bằng `node scripts/run-audit.cjs dist` hoặc `python3 scripts/verify-build.py dist`.

### 1. Mẫu Middleware giới hạn Quota & Phân trang phía Server (P0)

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
    accountId: req.headers.get("x-verified-account") ?? undefined,
    apiKeyId: req.headers.get("x-verified-key-id") ?? undefined,
    tier: "free",
  }),
  onQuotaExceeded: event => {
    console.warn("[quota-exceeded]", event);
  },
}));
```

### 2. Mẫu API Canary (tự động chuẩn hóa biến thể URL)

```ts
import { handleCanaryTrapRequest, normalizeCanaryPath } from "@dannyphan190/anti-rea";

const result = await handleCanaryTrapRequest(request, {
  resolveUserId: () => verifiedSession.userId, // Lấy từ backend đã xác thực
  onAlert: async event => { /* gửi sự kiện đã tối giản đến logger */ },
});
if (result.isTrapped) return Response.json(result.body, { status: result.status });
```

### 3. Mẫu Chống Replay cho Transport Envelope (không rò rỉ RAM)

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

// Tự động dọn dẹp nonce hết hạn theo TTL và giới hạn số lượng bản ghi, không gây tràn RAM như Set()
const replayGuard = createInMemoryReplayGuard({
  ttlMs: 300_000,
  maxEntries: 10_000,
});

const decoded = await verifyTransportEnvelope(env, key, scope, { markNonceOnce: replayGuard });
```

### 4. Mẫu Watermark & Provenance Notice

```ts
import { mountForensicWatermark, injectAgentNotice } from "@dannyphan190/anti-rea";

const cleanupWatermark = mountForensicWatermark({ token: "A7fK3w9Z", enabled: true });
const cleanupNotice = injectAgentNotice({
  brandName: "My SaaS",
  canonicalOrigin: "https://app.example.com",
  termsUrl: "https://app.example.com/terms",
});
```

### 5. Mẫu Kiểm chứng Agent có Chữ ký (Web Bot Auth)

Một số crawler và AI agent tự ký request theo profile Web Bot Auth (RFC 9421, Ed25519). Bộ kiểm chứng dựng lại và kiểm tra chữ ký, ép cửa sổ hiệu lực, và từ chối nonce bị dùng lại. Module không tự tải khóa - bạn cấp khóa tĩnh hoặc qua resolver của riêng mình (tự fetch `/.well-known/http-message-signatures-directory` từ origin của agent với cache và chính sách SSRF của bạn).

```ts
import { createWebBotAuthVerifier } from "@dannyphan190/anti-rea";

const verifier = createWebBotAuthVerifier({
  resolveKey: async ({ agent }) => {
    if (!agent) return undefined;
    const res = await fetch(new URL("/.well-known/http-message-signatures-directory", agent));
    return res.ok ? await res.json() : undefined;
  },
  maxValiditySeconds: 600, // siết trần 24h của bản thảo
});

const verdict = await verifier.verify(request);
if (verdict.verified) {
  // verdict.agent / verdict.keyId xác định người ký của CHÍNH request này.
  // Đưa danh tính vào quyết định tier quota - và giữ nguyên kiểm tra
  // phân quyền như với traffic không ký.
}
```

Demo chạy được đầu-cuối (tạo khóa, ký request, kiểm chứng, rồi sửa request và xem nó bị từ chối) nằm tại [examples/web-bot-auth-verify.cjs](examples/web-bot-auth-verify.cjs).

### 6. Python / FastAPI

Backend của bạn chạy Python? [examples/python-fastapi](examples/python-fastapi) port quota guard với cùng tier, cùng ngữ nghĩa `429`, header `X-RateLimit-*` và giới hạn phân trang, kèm middleware Starlette và dependency cho FastAPI. Bộ test pytest của nó đối chiếu từng kịch bản kiểm thử của bản TypeScript, nên cả hai bản đều bị ràng bởi cùng một hợp đồng hành vi.

### 7. Đo chính dữ liệu (Ngân sách bản ghi + Phát hiện bầy đàn)

Quota theo request giới hạn *tốc độ*; ngân sách bản ghi giới hạn *lượng dữ liệu* một danh tính nhận được, dù nó phân trang lịch sự đến đâu. Đưa cùng các sự kiện phục vụ đó cho bộ phát hiện bầy đàn để các nhóm phối hợp cũng lộ diện.

```ts
import { createRecordBudget, createHerdDetector } from "@dannyphan190/anti-rea";

// Một danh tính nhận tối đa 2.000 bản ghi riêng biệt mỗi ngày.
const budget = createRecordBudget({ maxDistinctPerWindow: 2_000 });
const herd = createHerdDetector({
  onFlag: snap => { /* snap.band: "budget_cut_supported" | "graduated_only" */ },
});

// Chặn ở cổng trước khi handler chạy, rồi ghi lại những gì response thực sự đã phục vụ:
if (!budget.check("account:123", 1).allowed) { /* trả 429 */ }
// ... handler chạy, phân quyền đạt, recordIdsServed đã chốt ...
budget.consume("account:123", recordIdsServed);
herd.observe({ type: "list", identity: "account:123", ip: serverSeenIp, recordIds: recordIdsServed });
```

Dùng cùng một chuỗi danh tính (`account:<id>`) ở cả hai nơi, để cờ bầy đàn đưa thẳng vào `applyHerdLadder()` hoặc cơ chế ghi đè ngân sách.

### 8. Trần dùng chung & Bằng chứng (v2.5.0)

Với cohort, ngân sách theo danh tính bị pha loãng khi luân phiên; trần dùng chung thì không - nhưng chỉ khi reservation là giao dịch thật. Khai báo cohort, reserve trước khi phục vụ, commit sau:

```ts
import {
  createDisclosureLedger, createInMemoryTransactionalStore,
  createCusumTripwire, clampEnforcement, consequenceTargets,
  createProtectedCohortRegistry, defaultHerdBandResponse, herdFrictionTargets,
} from "@dannyphan190/anti-rea";

const ledger = createDisclosureLedger({
  store: createInMemoryTransactionalStore(), // store có CAS => mode "enforce"
  ceilingLimit: 2_000,                        // dùng chung cho cả cohort
});
await ledger.declareRegistry(memberIds);      // subject chưa đăng ký bị fail-closed

const reservation = await ledger.reserveDisclosure({ subject: "account:123", recordIds: idsToServe });
if (!reservation.allowed) { /* 429: ceiling_exceeded | rate_limited | ... */ }
// ... phục vụ ...
await ledger.commitReservation(reservation.reservationId);

// Khai báo các subject mà suy luận không bao giờ được áp hậu quả:
// đội rà soát compliance, bộ phận support, một cửa sổ pentest đã
// thỏa thuận. Telemetry của họ vẫn tích lũy - chỉ hậu quả bị chặn -
// và bản khai báo là một hồ sơ kiểm toán được.
const protectedCohorts = createProtectedCohortRegistry();
protectedCohorts.declareProtected(["account:auditor-1", "account:auditor-2"], {
  reason: "Q3 compliance review",
});

// Bằng chứng tích lũy riêng. Mode mặc định của tripwire là enforce,
// nhưng với bảng chưa hiệu chuẩn đi kèm, hậu quả lên cohort suy
// luận bị cap ở bậc ma sát (step-up, cộng hạ trần mềm không bao giờ
// xuống dưới 500 bản ghi). Hậu quả cứng hơn cần cohort do host khai
// báo hoặc calibration manifest ở tier ceiling - clampEnforcement()
// là điểm kiểm tra.
const tripwire = createCusumTripwire({ isProtected: id => protectedCohorts.isProtected(id) });
await tripwire.observe({ type: "list", identity: "account:123", recordIds: idsToServe });

// Flag của herd nhận cùng một mặc định: với cohort suy luận,
// defaultHerdBandResponse() trả về ma sát (stepUp: true,
// budgetStepDownFloorRecords: 500, ladder: false) trên cả hai band.
// Chỉ áp ma sát đó lên thành viên đã tạo ra bằng chứng (2.5.0):
// herdFrictionTargets(snap) giữ thành viên có độ phủ riêng đủ lớn,
// consequenceTargets(snapshot) giữ người đóng góp ròng - rồi mới
// partition qua registry để subject được bảo vệ vẫn ở mức 0.

// Canary-echo (2.5.0): mint một tham chiếu có chữ ký CHO danh tính
// này và nhúng vào chính bề mặt của nó (một bản ghi, một link ẩn);
// khi một danh tính khác trình lại, nối hai cohort với nhau.
const echoId = mintEchoId(secret, { mintedFor: "account:123" });
const ref = mintEchoRecord(secret, { mintedFor: "account:123" });
// ...sau đó, ở route detail, trước khi tra bản ghi:
const echoFrom = resolveEchoFrom(secret, presentedId);
if (echoFrom && echoFrom !== identity) {
  await tripwire.observe({ type: "detail", identity, echoFrom });
}
```

Với store chỉ có get/put, sổ báo `mode: "audit_only"` và `enforced: false` trên mọi quyết định - đo trước, thi hành khi store của bạn giao dịch thật được. Ngữ nghĩa đầy đủ và giới hạn: [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Thí điểm hiệu chuẩn

Bộ máy bằng chứng CUSUM của antiRea đi kèm bảng điểm fit trong
phòng lab (`r6-calib-1`, dán nhãn `uncalibrated: true`): bảng được
fit trên trace mô phỏng bằng script, không phải trên dân số người
dùng thật, và README ghi rõ điều đó ở mọi nơi nhắc tới bảng này.
Muốn khép khoảng trống đó chỉ cần đúng một thứ dự án không tự tạo
ra được - snapshot ở chế độ observe từ một host thật.

**Mời chạy thí điểm hiệu chuẩn.** Nếu bạn đang dùng antiRea (hoặc
đang đánh giá), hãy chạy CUSUM tripwire ở `mode: "observe"` -
crossing vẫn được ghi log và không có gì bị hạn chế - rồi chia sẻ
**snapshot tổng hợp đã ẩn danh** thu được: kích thước cohort, điểm
và số union record tại crossing, đúng dạng tóm tắt mà callback
`onCampaignFlag` của SDK đã phát ra.

- Chỉ snapshot tổng hợp đã ẩn danh - **không dữ liệu người dùng
  thô, không nội dung bản ghi, không định danh nào có thể nhận ra
  người dùng của bạn**. Hãy rà soát và lược bỏ trước khi gửi;
  trường nào trông giống định danh thì bỏ hẳn và ghi chú lại.
- Snapshot được đưa vào quy trình fit hiệu chuẩn offline; một bảng
  điểm fit trên snapshot dân số thật là cách nhãn `uncalibrated`
  được gỡ xuống, với phương pháp fit và kết quả holdout công bố
  trong changelog.
- Chỉ cần một host là đủ bắt đầu: bộ snapshot thật đầu tiên cũng
  là dữ liệu dân số thật đầu tiên dự án này từng có.

Quan tâm, hoặc muốn xem định dạng snapshot trước? Email
**dannyphan190@gmail.com**.

## Đóng góp / An ninh / Giới hạn

Đọc [CONTRIBUTING.md](.github/CONTRIBUTING.md), [SECURITY.md](.github/SECURITY.md), [LEGAL_PRIVACY.md](docs/LEGAL_PRIVACY.md) và [LIMITATIONS.md](docs/LIMITATIONS.md).
