<p align="center">
  <img src="logo.svg" alt="antiRea logo" width="104">
</p>

<h1 align="center">antiRea</h1>

<p align="center">
  <strong>Build it. Ship it. Keep it yours.</strong>
</p>

<p align="center">
  antiRea là một thư viện TypeScript phía server, đo lượng truy cập bộ
  dữ liệu theo từng danh tính và gắn cờ các hành vi lạm dụng bot có phối
  hợp - đội trích xuất hàng loạt, bầy đàn chạy theo lịch, chiếm ghế.
  Chỉ tư vấn: nó gắn cờ, bạn quyết định.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://www.npmjs.com/package/@dannyphan190/anti-rea"><img src="https://img.shields.io/npm/v/@dannyphan190/anti-rea.svg" alt="npm version"></a>
  <a href="https://github.com/dankezo/antiRea/actions/workflows/ci.yml"><img src="https://github.com/dankezo/antiRea/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="tests/"><img src="https://img.shields.io/badge/tests-1056%20total-informational" alt="tests: 1056 total"></a>
</p>

<p align="center">
  <a href="https://antirea.dannyphan.me">Website</a> -
  <a href="docs/THREAT_MODEL_REA.md">Mô hình đe dọa</a> -
  <a href="docs/LIMITATIONS.md">Giới hạn</a> -
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <a href="README.md">English</a> - Tiếng Việt - <a href="README.zh.md">中文</a> - <a href="README.es.md">Español</a>
</p>

---

## Vấn đề, gói trong 30 giây

Các công cụ clone có thể quan sát trang, bundle và traffic của ứng
dụng của bạn, rồi dựng lại những gì chúng thấy. Bạn không thể giấu
code mà trình duyệt đã nhận - nên antiRea bảo vệ phía còn lại: chính
dữ liệu.

**Không bảo vệ.** Ai có tài khoản cũng mang được dữ liệu của bạn về
nhà. Trong các bài test của chúng tôi, một tài khoản đã lấy trọn bộ
dữ liệu 10.000 bản ghi trong chưa tới 200 request. Lặng lẽ. Không có
gì bất thường trong log.

**Có bảo vệ.** Người dùng thật không nhận thấy gì khác.
Mỗi danh tính chỉ có thể nhận một lát cắt có trần - 20% bộ dữ liệu
trong cấu hình test của chúng tôi - nên việc sao chép không còn là
một lần xuất dữ liệu nữa, mà thành bài toán danh tính.
Rải việc qua nhiều tài khoản, và bộ phát hiện bầy đàn sẽ gắn cờ sự
phối hợp đó.

- Lượt chạy lấy trọn bộ bằng 1 tài khoản đã bị **chặn ở 5%**.
- Một đội chạy script quyết lấy cho xong đã cần **25 danh tính và
  khoảng 19 phút** - và bị gắn cờ trên đường đi.

> Không bảo vệ, dữ liệu của bạn ra đi trọn gói, miễn phí và vô hình.
> Có bảo vệ, nó ra đi từng lát, có giá, và có dấu vết.

Toàn bộ số đo: [Kết quả đã đo](#hiệu-quả-ra-sao-kết-quả-đã-đo).

## Cài đặt

```bash
npm install @dannyphan190/anti-rea
```

Node.js 20+. Không có dependency lúc chạy.
Cũng có qua [GitHub Release](https://github.com/dankezo/antiRea/releases).

## Bắt đầu nhanh

Quota request giới hạn tốc độ. Ngân sách bản ghi giới hạn lượng dữ
liệu một danh tính có thể nhận trong suốt vòng đời, dù nó có hỏi
lịch sự đến đâu.

```ts
import { createRecordBudget, createHerdDetector } from "@dannyphan190/anti-rea";

// Một danh tính nhận tối đa 2.000 bản ghi khác nhau mỗi ngày.
const budget = createRecordBudget({ maxDistinctPerWindow: 2_000 });
const herd = createHerdDetector({
  onFlag: snap => { /* snap.band: "budget_cut_supported" | "graduated_only" */ },
});

// Kiểm tra trước khi handler chạy:
if (!budget.check("account:123", 1).allowed) { /* trả về 429 */ }

// Rồi ghi lại những gì response thực sự đã phục vụ:
budget.consume("account:123", recordIdsServed);
herd.observe({ type: "list", identity: "account:123", ip: serverSeenIp, recordIds: recordIdsServed });
```

Dùng cùng một chuỗi danh tính (`account:<id>`) ở cả hai nơi, và cờ
bầy đàn có thể đưa thẳng vào một lần cắt ngân sách qua
`applyHerdLadder()`.

## Bên trong có gì

Bốn nhóm. Bắt đầu từ trên xuống; mỗi lớp độc lập với nhau.

| Nhóm | Nó làm gì, nói đơn giản | Thành phần chính | Giới hạn, nói thẳng |
|---|---|---|---|
| **Meter** | Giới hạn lượng dữ liệu một danh tính có thể nhận trong suốt vòng đời, và cả tốc độ nhận | Ngân sách bản ghi (`createRecordBudget`), quota và chặn phân trang (`createQuotaGuard`), xuất dữ liệu có tính giá (`createExportGuard`), con trỏ phiên (`mintCursor` / `verifyCursor`), chấm điểm luồng (`createFlowScorer`) | Kẻ tấn công có thể xoay vòng danh tính - hãy kết hợp với chi phí đăng ký thật ở phía bạn |
| **Ownership** | Phát hiện một danh tính quét qua các đối tượng của người khác (kiểu đi quét BOLA/IDOR - id tuần tự, id ngẫu nhiên, hoặc rải chậm nhiều giờ) và báo kèm bằng chứng | Probe sở hữu (`createOwnershipProbe`) - tỉ lệ chủ sở hữu khác nhau theo từng danh tính trên cửa sổ trượt (mặc định 1 giờ, thêm 6 giờ cho quét chậm), route công khai được miễn, trạng thái tăng dần với lần đọc verdict O(1); chỉ advisory | Một lá cờ là hình dạng, không phải bằng chứng - quyền truy cập vẫn là việc của bạn, và quét dưới sàn hoặc tập trung vào ít chủ sở hữu thì ngoài tầm |
| **Watch** | Phát hiện sự phối hợp: nhiều danh tính lặng lẽ lát kín bộ dữ liệu của bạn, dò các mồi nhử, hoặc chen chúc trong một phòng | Bộ phát hiện bầy đàn (`createHerdDetector` + `applyHerdLadder`), tín hiệu pha (`createHerdPhaseSignal`, `createActivityPhaseSignal`), room guard (`createRoomGuard`), bẫy canary và mồi nhử (`handleCanaryTrapRequest`, `createCanaryMaze`, `createDecoyMirage`), telemetry tự động hóa (`detectAutomationSignals`), vệ sinh source-map (`verify-build.py` / `run-audit.cjs`), luật hạng theo khối lượng (`applyVolumeRankRule`), hiệu chuẩn trộn thực nghiệm (`selectEmpMixThreshold`), feature thời gian phiên (`computeHoldTypeFeatures` / `createHoldTypeScorer`), tín hiệu chiếm ghế tối thiểu-sớm (`createOccupancyEarlyMinimalSignal`) | Phát hiện không phải là thực thi - bầy đàn lát mỏng nhận phản ứng theo nấc, và một bầy đàn thích ứng đã bị gắn cờ nhưng vẫn lấy xong |
| **Prove** | Chốt rõ một phán quyết nghĩa là gì: cấu hình nào tạo ra nó, ai thực sự đã ký, điều gì được phép làm căn cứ cho hậu quả | Nguồn gốc cấu hình (`createConfigProvenance`), xác minh Web Bot Auth (`createWebBotAuthVerifier`), bằng chứng step-up (`issueStepUpProof`, `createStepUpProofVerifier`), định hình hậu quả step-up (`createStepUp402Responder`), vai trò bằng chứng (`evidentiaryRoleOf`, `auditEvidencePack`, `decorateSignalResult`) | Chữ ký đã xác minh là danh tính, không phải quyền truy cập - các kiểm tra quyền của bạn vẫn giữ nguyên như cũ |
| **Trace** | Công cụ phía client tùy chọn, hỗ trợ khi rò rỉ và phát lại | Phong bì gắn ngữ cảnh (`encryptPayload` / `decryptPayload`, `createInMemoryReplayGuard`), watermark pháp y (`mountForensicWatermark`), log khai báo preference (`createDeclarationLog`) | Truy vết, không phải kiểm soát truy cập - lớp phủ có thể bị cắt, và trình duyệt nắm giữ ngữ cảnh của chính nó |

**Thứ tự khuyến nghị:** quota guard trước (xem bên dưới), rồi đến
ngân sách bản ghi, rồi phát hiện bầy đàn.

## Hiệu quả ra sao? Kết quả đã đo

**Phương pháp, nói ngắn.** Chúng tôi kiểm thử trên **Ledgerly**, một
SaaS giả lập chứa 10.000 bản ghi sau 120 tài khoản, chạy hai lần:
không bảo vệ, và cùng ứng dụng đó khi đã gắn antiRea. Các lượt tấn
công được điều khiển bằng REA 6.8.0 (`rea-agents`) và bằng các agent
đa năng đi theo quy trình clone tiêu chuẩn; các lượt chạy bằng người
dùng lịch sự đo cái giá đối với traffic hợp lệ. Một benchmark độc
lập đã được công bố tại
[issue #1](https://github.com/dankezo/antiRea/issues/1) - phần lớn
claim trụ vững, và các điểm yếu nó tìm ra đã được sửa và ghi trong
changelog.
Phương pháp đầy đủ và bảng theo từng lớp: [docs/EVIDENCE.vi.md](docs/EVIDENCE.vi.md).

| Lớp | Kết quả tóm tắt |
|---|---|
| Không bảo vệ (baseline) | Toàn bộ bộ dữ liệu 10.000 bản ghi ra đi trong **160-193 request** |
| Ngân sách bản ghi | Một danh tính bị giữ ở đúng **20%** bộ dữ liệu |
| Phát hiện bầy đàn + bằng chứng CUSUM | Luân phiên danh tính kiểu REA bị chặn ở **5%**; một đội thích ứng cần **25 danh tính và ~19 phút** |
| Trần cohort khai báo | Union của cohort dừng ở đúng **600 bản ghi**, 0 bản ghi được phục vụ quá trần |
| Người dùng hợp lệ | Đội đã khai báo **1.200/1.200, 0 ma sát**; người dùng lịch sự 0 hậu quả |
| Ngân sách hành động (lab) | Đàn lạm dụng tính năng hoàn thành **16/80 thao tác (20%)**; người dùng thường **48/48**, 0 hậu quả |
| Tín hiệu tư vấn (lab) | Năm tín hiệu cho các hình dạng chậm: gắn cờ nhầm **0-1,67%** trên traffic hợp lệ - số chi tiết trong bảng đầy đủ |

**Tổng kết lại.** Kiểu clone một-phát-xong ở mức casual đã biến mất.
Trích xuất hàng loạt trở thành bài toán danh tính: mỗi lát dữ liệu
thêm tốn thêm một tài khoản và thêm dấu vết. Nó không chặn được
người tái dựng quyết tâm và có nguồn lực - và cái giá thật của một
danh tính (ma sát đăng ký, tài khoản đã xác minh, thanh toán) là do
bạn đặt ra, đó là lý do ngân sách được tính theo danh tính và cờ bầy
đàn phân biệt "cắt ngân sách" với "tăng mức soi".

## Cũng nói được MCP

antiRea đi kèm một MCP server chính thức cho AI agent:
[`@dannyphan190/anti-rea-mcp`](https://www.npmjs.com/package/@dannyphan190/anti-rea-mcp)
([mã nguồn](https://github.com/dankezo/anti-rea-mcp)), xây trên
`@modelcontextprotocol/sdk` chính thức, nói MCP qua stdio.

Nó mở tám loại tín hiệu tư vấn của thư viện thành sáu công cụ -
`list_signals`, `create_signal`, `observe`, `observe_reference`,
`evaluate`, `close_signal` - để một agent có thể mở một phiên tín
hiệu, nạp sự kiện vào và đọc phán quyết.

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

Đây là kênh đánh giá và demo. Bảo vệ production vẫn thuộc về
in-process, trong chính ứng dụng của bạn.

## Bản phát hành mới nhất

### v3.0.0 - Chuyển hóa tier-2, khoá năng lực bulk và thống kê pin hiệu chuẩn farm

Ba hệ thống đã đo tốt nghiệp từ lab và farm. Tất cả đều opt-in; không mặc định nào thay đổi.

- **Chuyển hóa tier-2 (`createTier2Conversion`, MỚI):** lớp thực thi C27+C35, dựng theo các quyết định đã khóa ngày 2026-11-04. Một cờ C27 bền vững (có mặt trong >= 2 epoch bằng chứng khác nhau) kèm corroboration độc lập từ một họ detector khác sẽ hạ ngân sách bản ghi của identity về phía sàn 500 bản ghi/identity/24h - không bao giờ dưới sàn, không bao giờ chặn cứng. Lần chạm decoy C35 đầu tiên áp taint + step-up ngay lập tức, với cơ chế tự giải trừ V-C và void hồi tố tích hợp sẵn, không phải tùy chọn. Một ngân sách FP toàn fleet kiểu alpha-wealth đi kèm lớp này: khi cạn, nó tự động rơi về observe-only. Strata chỉ vào bằng khai báo của host. Cơ sở bằng chứng: FC-03R PREMISE-CONFIRMED trên thống kê farm căn theo tuổi (tuổi 1-12) cộng pin lab; chân C35 là bằng chứng lab-only và không có tuyên bố farm nào cho nó.
- **Khoá năng lực bulk (`createBulkAccessKeyAuthority`, MỚI):** truy cập bulk - bản ghi mới vượt vùng miễn phí 150 bản ghi, mọi bản ghi thuộc phần đuôi, mọi export mới - đều cần một khoá do server cấp, và việc CẤP khoá là sự kiện bị đo: kênh ẩn danh bị bound bởi pool toàn fleet (6 khoá/24h theo giá trị lab), mỗi khoá mở một lát 150 bản ghi không liên tục của một hoán vị epoch có seed, và bản ghi được phục vụ dưới một khoá mang biến thể watermark của khoá đó. Trong probe lab đông cứng (GATEKEY-01 Step-0), độc giả thường và độc giả nặng được phục vụ đủ với 0 lần bị từ chối và 0 lần bị đòi step-up, trong khi farm xoay 200 identity bị giữ ở nhịp pool và cần 12 ngày cho phần đuôi. Các số kinh tế đó chỉ phủ phần đuôi, export và phần phục vụ vượt vùng miễn phí; phần đầu vẫn không khoá theo thiết kế.
- **Thống kê pin FC-07 (`fitPinNovelStatistic` / `scorePinNovelStatistic`, MỚI, opt-in):** đếm phơi nhiễm bản ghi mới theo identity, ngưỡng fit theo stratum do host khai báo theo C-LAW, luật cờ strict (novel > tau). Trên cửa sổ hiệu chuẩn farm, nó gắn cờ 0% cả hai stratum hợp lệ trong khi phát hiện attacker chậm 2/2 và các shape bulk 4/4; cái giá của nó được in kèm (traffic dạng review-team crossing 100%), và kiểm chứng holdout trên trace 16-22/11 vẫn đang chờ. Các dạng (novel, total) đã ship và mặc định không đổi.
- Mới nữa: trục stuffing hàng chờ của luật vote-brigading (`createQueueStuffingSignal`; PASS-LAB trong mô phỏng có seed), ba module advisory ở dạng hạn chế đã đo (`analyzeHeaderCoherence` V1, `classifyUserAgent` catalogue tên riêng, `createFakeEndpoints` gói decoy opt-in), lưu referer chỉ theo origin kèm bản vá WART-1, và một test conformance rác vĩnh viễn ghim cả 7 bề mặt verify (146 lời gọi: 0 throw, 0 verdict thành công).

1056 test: 1054 đạt, không lỗi, 2 bỏ qua (đo trên Linux x64, Node 24.22.1).

Các bản phát hành trước: xem [Changelog](CHANGELOG.md).

## Bước đầu tiên: quota guard

Quota phía server và giới hạn phân trang, thực thi theo tài khoản,
API key và IP. Trả về HTTP `429` kèm `Retry-After`, và ghi log sự
kiện có cấu trúc cho người vận hành.

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
    accountId: req.headers.get("x-verified-account") ?? undefined, // từ auth phía server của bạn
    apiKeyId: req.headers.get("x-verified-key-id") ?? undefined,
    tier: "free",
  }),
  onQuotaExceeded: event => {
    console.warn("[quota-exceeded]", event);
  },
}));
```

### Thêm mẫu sử dụng

- **Endpoint canary** - các route bẫy ghi lại hành vi dò quét bất
  thường, kèm chuẩn hóa đường dẫn để các biến thể không lách qua
  được.
  Ví dụ chạy được: [examples/node-canary-server.cjs](examples/node-canary-server.cjs).
- **Agent có ký** - xác minh chữ ký Web Bot Auth (RFC 9421) và áp
  chính sách quota theo một danh tính ổn định. Demo đầu-cuối chạy
  được: [examples/web-bot-auth-verify.cjs](examples/web-bot-auth-verify.cjs).
- **Python / FastAPI** - quota guard được port sang với tiers y hệt,
  ngữ nghĩa `429` và giới hạn phân trang y hệt, giữ cùng một hợp
  đồng kiểm thử: [examples/python-fastapi](examples/python-fastapi).
- **Trần cohort chia sẻ và bộ máy bằng chứng CUSUM** -
  đặt chỗ giao dịch trên toàn bộ một cohort đã khai báo, với các
  cohort được bảo vệ mà telemetry vẫn tích lũy nhưng không bao giờ
  chuốc hậu quả: ngữ nghĩa trong [docs/LIMITATIONS.md](docs/LIMITATIONS.md).
- **Watermark và phong bì** - xem nhóm Trace ở trên; không bao giờ
  nhúng email, IP hay ID người dùng thô của một người vào pixel
  watermark.

## Giới hạn, nói thẳng

- Nó **không thể** giấu code đã gửi tới trình duyệt, hay ngăn bất
  kỳ ai kiểm tra những gì trình duyệt của chính họ đã tải về.
- Nó **không thể** chặn người tái dựng quyết tâm và có nguồn lực.
  Thay vào đó, nó khiến việc sao chép hàng loạt trở nên chậm, tốn
  kém và có dấu vết.
- Các bảng có sẵn của bộ máy bằng chứng được fit trên dấu vết lab,
  không phải trên một quần thể người dùng thật, và được gắn nhãn
  `uncalibrated: true` ở mọi nơi chúng được nhắc tới. Xem chương
  trình hiệu chuẩn thí điểm bên dưới.
- Các mảnh phía client là công cụ truy vết, không phải kiểm soát
  truy cập.
- Không thủ thuật chặn bot phía client và không prompt injection:
  chúng không trụ được, và chúng không phải biện pháp kiểm soát có
  đạo đức.
  Xem [docs/REFERENCES.md](docs/REFERENCES.md).

Danh sách đầy đủ: [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Tái lập các con số

Repo đi kèm một bộ khung Playwright chạy một SaaS giả lập
(**Northstar**: dashboard, tìm kiếm khách hàng, tạo lead, xuất CSV,
xem biểu đồ) ở chế độ baseline (`:4173`) và protected (`:4174`),
trên Chromium, Firefox và WebKit.

```bash
npm install
npm run build && npm run benchmark:build-sdk
python -m pip install playwright
python -m playwright install chromium firefox webkit
python benchmark/run_all.py --browsers chromium,firefox,webkit --iterations 5
```

Làm việc trên chính repo: `npm run check` biên dịch, chạy **1056
test tự động** (1054 đạt, không lỗi, 2 bỏ qua, đo trên Linux x64 với Node 24.22.1) và thực
hiện các kiểm tra tĩnh. Quét một bản build công khai trước khi
deploy bằng `node scripts/run-audit.cjs /path/to/dist` hoặc
`python3 scripts/verify-build.py /path/to/dist`.

## Giúp hiệu chuẩn

Điều duy nhất dự án này không tự tạo ra được cho mình là traffic
thật. Nếu bạn chạy antiRea (hoặc đang đánh giá nó), hãy chạy
tripwire CUSUM ở `mode: "observe"` - các lần vượt ngưỡng được ghi
log, không có gì bị giới hạn - và chia sẻ **các snapshot tổng hợp
đã ẩn danh** mà nó phát ra: kích thước cohort, điểm số, số bản ghi
union.

Không dữ liệu người dùng thô, không nội dung bản ghi, không định
danh. Hãy xem lại và lược bỏ một snapshot trước khi gửi; nếu một
trường trông có vẻ định danh, hãy bỏ nó ra và nói rõ. Bộ snapshot
thật đầu tiên là cách nhãn `uncalibrated` được gỡ xuống.

Quan tâm, hoặc muốn xem định dạng snapshot trước?
Email **dannyphan190@gmail.com**.

## Tài liệu

- [Mô hình đe dọa](docs/THREAT_MODEL_REA.md) - antiRea giả định gì về kẻ tấn công
- [Giới hạn](docs/LIMITATIONS.md) - những gì nó không làm
- [Bằng chứng](docs/EVIDENCE.vi.md) - toàn bộ kết quả đã đo và phương pháp
- [Ghi chú pháp lý và quyền riêng tư](docs/LEGAL_PRIVACY.md)
- Tìm hiểu sâu: [v2.9.0](docs/v2.9.0-deep-dive.vi.md) - [v2.8.1](docs/v2.8.1-deep-dive.vi.md) - [v2.8.0](docs/v2.8.0-deep-dive.vi.md)
- [v2.9.1 deep dive](docs/v2.9.1-deep-dive.vi.md)
- [v2.9.2 deep dive](docs/v2.9.2-deep-dive.vi.md)
- [Changelog](CHANGELOG.md)

## Đóng góp và bảo mật

Đọc [CONTRIBUTING.md](.github/CONTRIBUTING.md) và
[SECURITY.md](.github/SECURITY.md) trước khi mở pull request
hoặc báo cáo lỗ hổng.

**Tài trợ dự án:** [Ủng hộ người duy trì](https://www.paypal.com/paypalme/dannyphan190)
(tùy chọn; không bao giờ cần thiết để sử dụng).

<p>
  Featured on
  <a href="https://launchnest.io/p/antirea" target="_blank"><img src="https://launchnest.io/badge/antirea.svg?variant=featured" alt="antiRea on LaunchNest" width="160" height="40" /></a>
</p>
