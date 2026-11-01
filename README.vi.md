# antiRea

**Bảo vệ phần giá trị thật của ứng dụng, không dựa vào ảo tưởng rằng giao diện có thể bị giấu khỏi trình duyệt.**

**Bộ công cụ đánh giá rủi ro · TypeScript SDK · AI Agent Skill**

[English](README.md) · [Mô hình rủi ro](docs/THREAT_MODEL_REA.md) · [Giới hạn](docs/LIMITATIONS.md) · [Kết quả QA](docs/QA_2026-10-31.md) · [Changelog](CHANGELOG.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@dannyphan190/anti-rea.svg)](https://www.npmjs.com/package/@dannyphan190/anti-rea)
[![CI](https://github.com/dankezo/antiRea/actions/workflows/ci.yml/badge.svg)](https://github.com/dankezo/antiRea/actions/workflows/ci.yml)
[![độ phủ dòng của dist](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dankezo/antiRea/badges/badges/coverage.json)](https://github.com/dankezo/antiRea/blob/main/docs/LIMITATIONS.md)
[![tests](https://img.shields.io/badge/tests-85%20passing-informational)](tests/)

antiRea giúp bạn kiểm tra những gì website để lộ, áp dụng giới hạn quota/phân trang phía server, giữ logic quan trọng ở backend và dùng canary hoặc watermark khi phù hợp. Công cụ **không thể** ngăn người dùng kiểm tra dữ liệu đã gửi tới trình duyệt của họ.

Cài đặt từ npm:

```bash
npm install @dannyphan190/anti-rea
```

Bạn cũng có thể cài từ [GitHub Release](https://github.com/dankezo/antiRea/releases).

## Mới trong v2.2: Kiểm chứng Web Bot Auth & Bản port Python/FastAPI

- **Kiểm chứng agent có chữ ký:** `createWebBotAuthVerifier()` kiểm tra chữ ký Web Bot Auth (bản thảo IETF trên nền RFC 9421 HTTP Message Signatures, Ed25519) để nhận diện các agent tự ký request của chúng và gắn chính sách quota theo danh tính đó. Chữ ký hợp lệ chỉ chứng minh quyền sở hữu khóa cho request đã ký - không phải giấy phép truy cập và tự nó không phải tín hiệu tin cậy.
- **Bản port Python/FastAPI:** quota guard nay có bản port Python trung thực tại [examples/python-fastapi](examples/python-fastapi), cùng tier, cùng định dạng phản hồi và giới hạn phân trang, kèm bộ test pytest đối chiếu từng kịch bản với bản TypeScript.

## Demo SaaS A/B (v2.1)

Đã dựng **Northstar**, ứng dụng SaaS giả lập với dashboard, tìm kiếm khách hàng, tạo yêu cầu, xuất CSV, biểu đồ ở hai chế độ **baseline (`:4173`)** và **protected (`:4174`)**.

```bash
npm install
npm run build && npm run benchmark:build-sdk
python -m pip install playwright
python -m playwright install chromium firefox webkit
python benchmark/run_all.py --browsers chromium,firefox,webkit --iterations 5
```

Muốn xem giao diện bằng tay, mở hai terminal và chạy `npm run benchmark:baseline` cùng `npm run benchmark:demo`.

## antiRea giải quyết vấn đề gì?

Các công cụ như [morluto/rea](https://github.com/morluto/rea) hỗ trợ quan sát DOM, phân tích JavaScript bundle, theo dõi mạng và tái lập UI.

Mục tiêu của dự án là giúp chủ sở hữu và cộng đồng triển khai biện pháp **thực chất, hạn chế tác dụng phụ, có bằng chứng đo đạc**.

## Bốn tầng và ưu tiên triển khai

| Ưu tiên | Tính năng | Lợi ích có thể kỳ vọng | Giới hạn |
|---|---|---|---|
| **P0 - nền tảng** | Middleware giới hạn quota/phân trang (`createQuotaGuard`), phân quyền từng bản ghi, giữ thuật toán/secret ở backend | Đảm bảo an toàn cốt lõi chống scraping hàng loạt | Không giấu được dữ liệu đã trả về cho tài khoản hợp lệ |
| **Tầng 1** | Quét và chặn lộ source map (`verify-build.py` / `run-audit.cjs`); thông báo bản quyền; chữ ký dấu vết SVG/text | Ngăn lộ mã nguồn gốc ngoài ý muốn | Không ngăn được người cố tình xóa marker |
| **Tầng 2** | API canary chuẩn hóa đường dẫn (`handleCanaryTrapRequest`), tín hiệu automation (`detectAutomationSignals`) và kiểm chứng chữ ký Web Bot Auth (`createWebBotAuthVerifier`) cho agent tự ký request | Ghi nhận truy cập bất thường để điều tra; nhận diện agent có chữ ký để chính sách quota bám theo danh tính ổn định | Không dùng làm rào cản chặn tuyệt đối; chữ ký hợp lệ là danh tính, không phải phân quyền |
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

`npm run check` gồm biên dịch, **65 kiểm thử tự động** và kiểm tra tĩnh. Có thể quét thư mục build công khai bằng `node scripts/run-audit.cjs dist` hoặc `python3 scripts/verify-build.py dist`.

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

## Đóng góp / An ninh / Giới hạn

Đọc [CONTRIBUTING.md](.github/CONTRIBUTING.md), [SECURITY.md](.github/SECURITY.md), [LEGAL_PRIVACY.md](docs/LEGAL_PRIVACY.md), [LIMITATIONS.md](docs/LIMITATIONS.md) và [QA_2026-10-31.md](docs/QA_2026-10-31.md).
