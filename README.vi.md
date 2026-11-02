# antiRea

**Bảo vệ phần giá trị thật của ứng dụng, không dựa vào ảo tưởng rằng giao diện có thể bị giấu khỏi trình duyệt.**

**Bộ công cụ đánh giá rủi ro · TypeScript SDK · AI Agent Skill**

[English](README.md) · [Mô hình rủi ro](docs/THREAT_MODEL_REA.md) · [Giới hạn](docs/LIMITATIONS.md) · [Changelog](CHANGELOG.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@dannyphan190/anti-rea.svg)](https://www.npmjs.com/package/@dannyphan190/anti-rea)
[![CI](https://github.com/dankezo/antiRea/actions/workflows/ci.yml/badge.svg)](https://github.com/dankezo/antiRea/actions/workflows/ci.yml)
[![độ phủ dòng của dist](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dankezo/antiRea/badges/badges/coverage.json)](https://github.com/dankezo/antiRea/blob/main/docs/LIMITATIONS.md)
[![tests](https://img.shields.io/badge/tests-275%20passing-informational)](tests/)

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

## Mới trong v2.5.0: Gom nhóm bầy đàn trọn độ phủ, Canary-echo ID & Thi hành phân tầng

Bản 2.5.0 hiện thực hóa thiết kế hợp đồng SDK từ một phiên rà soát đối kháng qua đêm (bản tổng hợp đầy đủ nằm trong ghi chú nghiên cứu): các primitive bằng chứng, một bộ máy bằng chứng tuần tự, một sổ disclosure chính xác với trần campaign dùng chung, và cursor trói vào store - tất cả bị ràng bởi một luật, **không thi hành khi không có giao dịch, và không hậu quả cứng chỉ từ bằng chứng suy luận - nhưng ma sát thì bật mặc định.** Bản này đưa hậu quả rơi đúng vào thành viên đã tạo ra bằng chứng, dạy bộ máy bằng chứng gom cohort trên hai hình dạng nó từng mù, và đi kèm bộ công cụ fit hiệu chuẩn offline mô tả ở cuối mục này. Nó cũng khép khoảng trống gom nhóm mà các vòng trước đã đo - flag của herd không còn dừng ở những thành viên có mặt lúc nó bắn - thay cơ chế gom từng cặp bằng thiết kế leader-based chịu được quy mô lớn hơn, và đi kèm canary-echo id, một tham chiếu bề mặt có chữ ký nối danh tính luân phiên về danh tính nó luân phiên từ đó.

- **Gom nhóm bầy đàn trọn độ phủ (2.5.0):** cơ chế nối theo độ phủ bổ sung của herd detector nay là leader-based - nhóm độ phủ của một danh tính được so với aggregate (bitmap khối + map refcount) của các NHÓM khác, không còn trạng thái theo từng cặp (thiết kế từng cặp cần 131 giây cho một luồng 1.000 danh tính trong bench lab; thiết kế leader cần 1,6 giây, và gom một đàn bổ sung nhau 500 danh tính thành một nhóm trong 2,7 giây). Nhóm đã bị gắn cờ còn tự thông báo lại: khi một thành viên gia nhập muộn, hoặc một thành viên lúc flag bắn còn dưới sàn trọng yếu, cán sàn đó (mặc định 25 bản ghi riêng), một flag bổ sung sẽ bắn - gộp tối đa 1 lần mỗi 5 giây mỗi nhóm - để hậu quả chạm tới cả đàn, không chỉ những thành viên sớm nhất. Đo ở vòng kinh điển v2.5.0: tập bị flag/hậu quả của đàn slicing đi từ 8/18 danh tính phase 1 (2.4.0) lên **18/18**, và phase 1 của ID walk bị giữ đúng ở sàn mềm 500 bản ghi cho mỗi walker.
- **Canary-echo id (2.5.0):** `mintEchoId()` phát hành một id tham chiếu tổng hợp có chữ ký, được mint CHO một danh tính (toàn vẹn bằng HMAC, nonce ngẫu nhiên 128-bit mỗi lần mint - không giả mạo được, không đoán hàng loạt được), nhúng vào chính bề mặt của danh tính đó qua `mintEchoRecord()` hoặc `canaryEchoLink()`. Khi một danh tính *khác* trình lại id đó, host resolve bằng `resolveEchoFrom()` và đưa nguồn gốc vào tripwire dưới dạng `echoFrom` - hai danh tính hợp nhất thành một cohort ngay tại chỗ, nên luân phiên không còn reset đồng hồ bằng chứng. Đo ở vòng kinh điển v2.5.0: một danh tính luân phiên chạm echo id của danh tính gốc đã bị hợp nhất ngay tại cú chạm (chưa tự phục vụ bản ghi nào) và cohort chung crossing ~1 giây sau ở 1.392 bản ghi hợp, cả hai thành viên đều bị enroll step-up. Một cú chạm echo là tín hiệu tương quan, không bao giờ tự nó là bằng chứng ác ý - xem [Giới hạn](docs/LIMITATIONS.md).
- **Sổ disclosure giao dịch:** `createDisclosureLedger()` thi hành một trần *dùng chung* cho cả cohort (các danh tính liên kết rút từ một hợp chính xác duy nhất của các bản ghi đã phục vụ, dù chúng luân phiên thế nào) qua `reserveDisclosure()`, điểm thi hành nguyên tử duy nhất. Hợp đồng store trung thực về sức mạnh của chính nó: store cài được `transactLedger()` (CAS trên `ledgerVersion`, bao trùm bitmap hợp, các reservation, trần, bucket và bằng chứng trong một giao dịch) nhận `mode: "enforce"`; store chỉ có get/put nhận `mode: "audit_only"` và mọi quyết định mang `enforced: false` - SDK không bao giờ tuyên bố một trần mà store đua nhau (race) không giữ nổi. Reservation có giới hạn (TTL 60 giây, tối đa 2 reservation đang mở và 500 bản ghi được reserve mỗi subject theo mặc định, cap cohort tùy chọn, đường reservation dài riêng do host ủy quyền cho export chậm), và registry cohort đã khai báo thì fail-closed với subject chưa đăng ký, vì phòng lab đã đo registry thiếu một phần làm campaign guard thoái hóa lặng lẽ thành bảo vệ theo từng thành viên. Một conformance test đi kèm chứng minh các reservation song song trên store async chậm không bao giờ cộng lại vượt trần.
- **Bằng chứng tuần tự (CUSUM tripwire):** `createCusumTripwire()` hợp nhất bốn stream - kề predicate, lát rời rạc trên tập chính xác, fetch ID lạnh, vận tốc cursor - vào một bộ tích lũy mixture GLR-CUSUM một phía cho mỗi cohort (sàn 0, ngưỡng `ln(1/alpha)`), thay cho các ngưỡng cố định độc lập mà kẻ tấn công có thể ngồi dưới mức 85% của từng ngưỡng. Stream lát loại trừ các bản ghi đã được predicate kề giải thích, nên các stream tương quan không bị đếm trùng. **Mặc định trung thực:** bảng đi kèm `r6-calib-1` được fit trên trace script trong lab (N_eff = 189) và xuất xưởng với nhãn `uncalibrated: true` cùng ghi chú "uncalibrated - audit only"; bộ máy mặc định ở mode `enforce`, nhưng CHỈ ở bậc step-up - một crossing đủ điều kiện sẽ enroll ma sát step-up và pacing theo cohort, và không hậu quả nào cứng hơn engage được trên bảng này. Vì bảng chưa hiệu chuẩn, mặc định chỉ tuyên bố ma sát trên bằng chứng script mạnh, không bao giờ tuyên bố tỷ lệ phát hiện; `mode: "observe"` vẫn còn cho triển khai chỉ cần telemetry. Crossing là telemetry ở mọi quy mô, nhưng hậu quả đòi hỏi quy mô tuyệt đối: dưới sàn hậu quả mặc định 150 bản ghi union chính xác (hằng số cổng đánh giá của stream lát, host chỉnh qua `consequences.minUnionRecords`), một crossing không enroll ai vào step-up và không pacing gì - snapshot đánh dấu `consequenceEligible: false`.
- **Luật phân tầng, viết thành code:** `clampEnforcement()` cap các cohort *suy luận* từ hành vi ở **bậc ma sát**: step-up cộng hạ trần mềm - được hạ ngân sách của một thành viên nhưng không bao giờ xuống dưới 500 bản ghi phân biệt (`SOFT_BUDGET_FLOOR_RECORDS` - suy ra từ bound reservation theo subject của sổ; `softBudgetStepDown()` cho một yêu cầu cắt về 0 hạ cánh đúng trên sàn đó). Ma sát là mặc định: `defaultHerdBandResponse()` map cả hai band của herd sang bậc này cho cohort suy luận, và CUSUM tripwire xuất xưởng ở mode `enforce`. Trần cứng đòi hỏi cohort do host khai báo hoặc một calibration manifest ở tier cao nhất (`evaluateCalibrationManifest()` - phiên bản model, cỡ mẫu, FP/FN trên holdout, phương pháp, người xác nhận, hạn hiệu lực; không có cờ boolean "đã hiệu chuẩn"). Band `graduated_only` của herd detector mang giá 0 theo cấu trúc, và `validateHerdResponseConfig()` từ chối các cấu hình gắn giá vào band đó - prototype trong lab gắn giá vào band này (kèm hệ số fetch lạnh chồng lên override) đã cắt cứng một đội compliance giả lập ở 46% công việc hợp lệ của họ, và lỗi wiring đó giờ là lỗi lúc khởi động thay vì một vết cắt lặng lẽ.
- **Cohort được bảo vệ:** hình dạng dương tính giả đã đo được - một đội nhỏ rà soát hệ thống toàn bộ một phân đoạn - ngoài đời hiếm và, trong tổ chức thật, là một hoạt động *được khai báo* (audit có lịch, pentest chạy theo quy tắc giao ước). Nên thay vì làm yếu phát hiện cho mọi người, hãy khai báo họ: `createProtectedCohortRegistry()` ghi lại các subject compliance/audit/support/pentest (kèm lý do và hạn hết tùy chọn), và subject được bảo vệ vẫn tích lũy telemetry đầy đủ trong khi nhận **0** hậu quả từ bằng chứng suy luận - không step-up, không hạ trần, không pacing. Bảo vệ không bao giờ che hậu quả do chính host ủy quyền, cũng không che bằng chứng trực tiếp theo subject (một cú chạm decoy do chính subject được bảo vệ thực hiện vẫn làm nó bị taint).
- **Cursor V2:** `mintCursorV2()` / `verifyCursorV2()` trói phân trang vào trạng thái authority phía server: payload chỉ mang vị trí, binding subject/cohort/scope, sequence của chuỗi và `ledgerVersion` - không bao giờ mang LLR hay trạng thái bằng chứng - và khi có xung đột **store thắng**: version cũ hoặc tương lai và sequence lệch đều bị từ chối, không bao giờ được nâng cấp lặng lẽ. Cursor V1 không thay đổi.
- **Ghi công bằng chứng & hook reviewer:** `createEvidenceAttributor()` chỉ ghi bằng chứng cho subject đang hành động; đóng góp xuyên subject cần quan hệ do host khai báo và bị cap kèm decay, liên kết suy luận chỉ được quan sát, liên kết không rõ bị cách ly vào audit. `createReviewerChannel()` là ý defender-agent cắt về lát an toàn duy nhất của nó: một reviewer phía host (model rẻ, luật, hàng đợi người) nhận các bundle tổng hợp có giới hạn và có thể trả về đề xuất *tư vấn* đã qua kiểm tra schema từ một bộ hành động cố định - nó không có ngân sách, không có quyền deny, và output của nó không bao giờ chảy ngược vào luồng bằng chứng (làm vậy là đếm cùng quan sát hai lần; một test chứng minh tính một chiều này trước một tripwire đang sống).
- **Đưa hậu quả về đúng người đóng góp (2.5.0):** ma sát rơi vào thành viên đã tạo ra bằng chứng, không rơi vào mọi người đứng trong nhóm bị gắn cờ. `consequenceTargets()` chia một snapshot CUSUM thành target ma sát (đóng góp ròng > 0, không được bảo vệ), thành viên được bảo vệ và thành viên không đóng góp; flag của herd mang theo `memberCoverage` / `memberUniqueCoverage` theo từng thành viên, và `herdFrictionTargets()` chỉ target thành viên có độ phủ riêng đủ lớn (mặc định từ 25 bản ghi). Trần campaign hợp lệ thì khác hẳn theo chủ đích: nó cap TỔNG trích xuất của cohort trên mọi lượt phục vụ - một nắp dữ liệu, không phải hình phạt theo subject. Đo ở vòng kinh điển v2.5.0: người dùng lịch sự và một nhóm NAT 5 người đứng trong một nhóm bị gắn cờ nhận 0 ma sát, kể cả trong một ô riêng nơi người dùng lịch sự vẫn lướt giữa phiên xuyên qua lúc flag bắn.
- **Gom cohort + công cụ hiệu chuẩn (2.5.0):** tripwire nay gom được cohort trên hai hình dạng nó từng mù - bổ sung nhau theo tập đã phục vụ nối các slicer dùng list có filter (filter dạng text không có predicate khoảng trung thực, nhưng tập bản ghi đã phục vụ thì luôn biết chính xác), và bổ sung nhau theo cold-walk nối các walker ở kênh detail mà các fetch lạnh của chúng lát các khoảng ID rời nhau, dày theo khoảng (fetch warm không đóng góp gì; walker đơn độc vẫn không bao giờ thành cohort). Mỗi quyết định phơi bày nhãn `bins` theo từng stream cho công cụ hiệu chuẩn, và `scripts/fit-cusum-calibration.cjs` fit bảng LLR tùy chọn theo cách offline (leave-one-family-out trên các persona lab có nhãn): bảng `r7-labfit-1` đi kèm giảm crossing giả trên holdout so với `r6-calib-1` nhưng không thắng ở cả hai phía, nên mặc định vẫn là r6 và manifest mẫu của r7 (người xác nhận: lab-simulated) chỉ đạt tier step_down.

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

**Phương pháp.** Chúng tôi kiểm thử trên **Ledgerly**, một SaaS giả lập chứa 10.000 bản ghi sau 120 tài khoản, chạy hai bản: baseline không bảo vệ và protected có gắn antiRea trên *cùng* một ứng dụng. Các đợt tấn công được điều khiển bằng REA 6.8.0 (`rea-agents`) và bằng các agent đa năng đi theo quy trình clone tiêu chuẩn: đăng nhập, liệt kê, dò biên, phân trang tới phủ kín, xuất dữ liệu hàng loạt. (Một phát hiện định hình mọi thứ phía dưới: bản thân REA chỉ *quan sát* - nó đọc trình duyệt đang chạy qua CDP và tự nó gửi đúng 0 request. Hành vi mà server quan sát, đo và tính giá được là của quy trình điều khiển phía sau, nên phòng thủ nhắm vào đó.) Các lượt chạy đối chứng bằng người dùng lịch sự đo cái giá đối với traffic hợp lệ. Một benchmark độc lập về chính repo này cũng đã được công bố tại [issue #1](https://github.com/dankezo/antiRea/issues/1); phần lớn claim trụ vững qua đợt kiểm đó, và các điểm yếu nó tìm ra đều đã được sửa và ghi lại trong changelog.

| Lớp | Đã đo gì | Kết quả |
|---|---|---|
| Không bảo vệ (baseline) | Trích xuất toàn bộ bộ dữ liệu 10.000 bản ghi | **Tổng 160-193 request**; một lệnh export duy nhất lấy được tất cả |
| P0 quota + giới hạn phân trang | Lạm dụng export và phân trang | Export hàng loạt bị từ chối (HTTP 422), cỡ trang và độ sâu bị chặn - cần thiết, nhưng tự nó chưa đủ |
| Ngân sách bản ghi + export guard + cursor nối chuỗi | Một danh tính lấy được bao nhiêu (ngân sách đặt 2.000 bản ghi riêng biệt/ngày) | Trần mỗi danh tính giữ đúng ở **20% bộ dữ liệu**; phát lại cursor khác phiên bị chặn; muốn lấy trọn bộ phải dùng nhiều danh tính thay vì một tài khoản |
| Phát hiện bầy đàn + bộ máy bằng chứng CUSUM | Trích xuất phối hợp nhiều danh tính (vòng kinh điển v2.5.0) | Một lượt luân phiên danh tính kiểu REA bị chặn ở **5%** bộ dữ liệu; nhóm slicing và nhóm ID-walk bị gắn cờ bởi CẢ hai bộ phát hiện - crossing đầu tiên của bộ máy bằng chứng rơi ở **1.800** và **900** bản ghi hợp (cả hai hình dạng đều vô hình với nó trước 2.5.0), và tập flag/hậu quả của herd bao phủ **18/18** danh tính slicing phase 1 (2.4.0: 8/18). Flag của herd mang độ phủ theo từng thành viên, nên thành viên đóng góp 0 trong nhóm bị gắn cờ nhận 0 ma sát (xem hàng người dùng hợp lệ bên dưới) |
| Mê cung canary + route mồi | Chất lượng tín hiệu và độ an toàn | Đã kiểm chứng tính đúng đắn và accessibility (Playwright + axe, **0 vi phạm**), trần cứng được ép (240 hit / 10 phút / IP, 10.000 trang/ngày, quá trần trả HTTP 404). Đây là lớp phát hiện - chúng tôi không tuyên bố phần trăm chặn trích xuất cho chúng |
| Trần cohort dùng chung (cohort khai báo + manifest tier ceiling) | Đường trần cứng hợp lệ có chạy đầu-cuối được không? (vòng kinh điển v2.5.0; trần khai báo 600 bản ghi) | Đã armed từ lúc khai báo và test lại: union của cohort khai báo dừng ở **đúng 600 bản ghi phân biệt** trong cả hai lượt chạy (lượt đầu engage sau crossing vọt lên 2.700), toàn bộ 18 walker khai báo bị khóa, **710-714 lần từ chối vì trần** mỗi lượt và 0 bản ghi được phục vụ quá trần, controls trong cùng instance không bị ảnh hưởng (compliance 1.200/1.200, 0 ma sát). Cohort khai báo không có manifest tier ceiling thì không armed gì cả; cohort suy luận giữ nguyên đường engage sau crossing; xem [Giới hạn](docs/LIMITATIONS.md) |
| Toàn bộ stack đấu với kẻ tấn công thích ứng | Kẻ tấn công cố ý rải việc qua 18 danh tính và pha loãng hành vi (vòng kinh điển v2.5.0) | Vẫn trích xuất xong nhờ luân phiên - nhưng phase 1 (18 danh tính) bị giữ ở **78%** sau ~18 phút chịu ma sát step-up, hết hạn phiên và hạ trần mềm, mọi danh tính phase 1 đều nằm trong tập bị flag/hậu quả, và để lấy trọn bộ phải tốn **25 danh tính và ~19 phút**. Phase 1 của nhóm ID-walk bị giữ ở **90,0%** - đúng 500 bản ghi cho mỗi walker, sàn mềm của cohort suy luận - với toàn bộ 18 walker bị cap và 324 lần ngắt phiên trong phase 1 (vòng trước: 91,0%, 224 lần ngắt, 2 walker vượt sàn). Luân phiên vẫn là lối thoát cấu trúc chính của stack; xem [Giới hạn](docs/LIMITATIONS.md) |
| Người dùng hợp lệ | Đội compliance đã khai báo, đội rà soát hệ thống chưa khai báo, người dùng lịch sự, nhóm dùng chung IP (NAT) (vòng kinh điển v2.5.0, đo lại) | Compliance đã khai báo (được bảo vệ): **1.200/1.200 bản ghi, 0 ma sát**. Rà soát hệ thống chưa khai báo: bị gắn cờ và chịu ma sát (step-up + hạ trần mềm) nhưng **0 mất dữ liệu - phục vụ đủ 1.200/1.200**. Người dùng lịch sự và nhóm NAT: **0 hậu quả** - kể cả người dùng lịch sự vẫn lướt giữa phiên bên trong một nhóm đang bị gắn cờ (targeting theo đóng góp, mới trong 2.5.0) |

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

`npm run check` gồm biên dịch, **277 kiểm thử tự động** (275 đạt, 2 vector RSA-PSS bị bỏ qua) và kiểm tra tĩnh. Có thể quét thư mục build công khai bằng `node scripts/run-audit.cjs dist` hoặc `python3 scripts/verify-build.py dist`.

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
