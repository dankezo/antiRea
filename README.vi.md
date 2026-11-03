# antiRea

**Bảo vệ phần giá trị thật của ứng dụng, không dựa vào ảo tưởng rằng giao diện có thể bị giấu khỏi trình duyệt.**

**Bộ công cụ đánh giá rủi ro · TypeScript SDK · AI Agent Skill**

[English](README.md) · [中文](README.zh.md) · [Español](README.es.md) · [Mô hình rủi ro](docs/THREAT_MODEL_REA.md) · [Giới hạn](docs/LIMITATIONS.md) · [Changelog](CHANGELOG.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@dannyphan190/anti-rea.svg)](https://www.npmjs.com/package/@dannyphan190/anti-rea)
[![CI](https://github.com/dankezo/antiRea/actions/workflows/ci.yml/badge.svg)](https://github.com/dankezo/antiRea/actions/workflows/ci.yml)
[![độ phủ dòng của dist](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dankezo/antiRea/badges/badges/coverage.json)](https://github.com/dankezo/antiRea/blob/main/docs/LIMITATIONS.md)
[![tests](https://img.shields.io/badge/tests-583%20passing-informational)](tests/)

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

## Mới trong v2.7.0

Nói ngắn gọn: hệ thống báo động trước đây dựa vào các ngưỡng được hiệu chuẩn trong phòng lab - số đẹp, nhưng không có lời hứa nào đứng sau. v2.7.0 bổ sung một engine bằng chứng có lời hứa toán học về báo động giả, hai tín hiệu tư vấn mới, và một đợt hợp nhất củng cố bên dưới.

- **Một báo động có lời hứa đi kèm.** Tripwire e-value mới (tùy chọn bật) tích lũy bằng chứng như cách một tay cược cẩn thận làm lớn vốn: nếu người dùng hợp lệ của bạn nằm dưới một ngưỡng cường độ do bạn đặt, khả năng nó *bao giờ* bắn nhầm cũng không vượt quá mức bạn chọn (ví dụ 5%) - bảo đảm theo cấu trúc. Trong 10.000 lượt mô phỏng người dùng hợp lệ nó bắn 0 lần; ở biên trung thực khắc nghiệt nhất: 4,2% so với lời hứa 5%. Nó bắt slicing ở trung vị 400 bản ghi so với 1.225 của engine hiện tại.
- **Một dạng thứ hai cho kiểu tấn công im lặng rồi bùng nổ.** Hình dạng tích lũy thường phản ứng chậm sau thời gian dài yên lặng, nên bản này kèm chế độ Shiryaev-Roberts: trung vị 14 bước để bắt tấn công sau thời gian yên lặng, so với 774 - với một bảo đảm riêng, khác hẳn, ghi rõ là như vậy. Một công cụ hiệu chuẩn đo ngưỡng từ chính lưu lượng của bạn.
- **Cái giá nói thẳng, in ngay trên hộp.** Lời hứa chỉ tốt đúng bằng ngưỡng bạn đặt: một workflow hợp lệ chạy nóng hơn ngưỡng sẽ *chắc chắn* vấp phải nó theo thời gian - các việc nóng-nhưng-thật như nhập dữ liệu hàng loạt thuộc về làn khai báo hoặc cần ngưỡng riêng.
- **Trần cứng, chính xác giữa đám đông.** Bốn mươi worker cùng đập vào một trần khai báo 600 bản ghi: đường check-then-serve cũ vượt tới 1.575. Đường reserve-first mới giữ đúng 600, vượt 0 - và các lượt giữ chỗ nay hết hạn theo đồng hồ đơn điệu, nên một bước nhảy đồng hồ hệ thống không kéo dài hay giết chết chúng được.
- **Một tín hiệu mới cho hành vi liệt kê qua tính năng (tư vấn).** Độ phủ không gian đầu vào theo dõi *những* tính năng và tài nguyên nào một tài khoản chạm tới, không chỉ lượng dữ liệu nó lấy. Trong lab nó gắn cờ hành vi quét và dò ngẫu nhiên 9/9 ngay checkpoint đầu (engine hiện tại: 0/9) và một đội chia việc 72/72 thành viên - ở tỉ lệ gắn cờ người dùng hợp lệ 1,15%. Nó chỉ chấm những gì bạn khai báo, và tự nó không chặn bất cứ thứ gì.
- **Một tín hiệu mới cho trình duyệt kiểu crawler (tư vấn).** Hồ sơ asset/referrer nhận ra các trình duyệt không bao giờ tải ảnh và không bao giờ mang referrer: 0 gắn cờ nhầm trong lab (6.658 luồng người dùng hợp lệ, 923 luồng tuần sale), crawler bị gắn cờ 9/9 - và bản này cố ý giao chậm-mà-chắc, cần hai cửa sổ xấu liên tiếp mới gắn cờ.
- **Người dùng đã xác minh không bị thách lại liên tục.** Qua được một lần kiểm tra step-up thì một cửa sổ ân hạn mới (mặc định 24 giờ) để bạn yên ở mức bằng chứng thường. Nó vỡ ngay khi bằng chứng vọt lên gấp đôi vạch gắn cờ - và nó không bao giờ nâng bất kỳ ngân sách hay trần nào.
- **Một bug thật được tìm thấy và sửa.** Các bài test tấn công tìm kiếm nặng bắt gặp một người đứng ngoài bị cuốn vào cờ của một nhóm tấn công - tệ hơn, tai nạn đó *che chắn* cho một kẻ tấn công khỏi ma sát. Quy tắc gom nhóm đã sửa: người đứng ngoài sạch, cả 16 kẻ tấn công đều bị enroll.
- **Xác thực bot ký tên, kiểm chứng lại.** Một gói conformance độc lập cho bộ xác thực RFC 9421, xây từ chính các khóa ví dụ của đặc tả: cả 12 biến thể chữ ký hỏng bị từ chối, chấp nhầm 0.
- **Chính sách của bạn, ở các định dạng agent đọc được.** Một bộ sinh nhỏ phát hành chính sách dùng dữ liệu của bạn dưới dạng tín hiệu robots.txt, một tệp đặt chỗ TDM và một JSON chính sách - chỉ tuyên bố đúng định dạng, không tuyên bố thực thi.
- **Toàn bộ đợt củng cố gần đây, hợp nhất vào.** Mọi bản vá đã phát hành ở các bản 2.6.1-2.6.3 (gắn khóa idempotency vào chủ thể, thực thi quota nguyên tử, tính giá xuất CSV, đồng hồ chống bước nhảy, và hơn nữa) đều nằm trong dòng này - một đợt audit tiền phát hành đã bắt gặp cây phát triển 2.7 tách nhánh từ trước các bản vá đó, và không có gì được phát hành cho tới khi chúng được hợp nhất trở lại và kiểm chứng lại.

Bản kỹ thuật đầy đủ với mọi cơ chế, chứng minh và số đo: [Tìm hiểu sâu v2.7.0](docs/v2.7.0-deep-dive.vi.md). Dòng bản vá trước thay đổi những gì: [Tìm hiểu sâu v2.6.3](docs/v2.6.3-deep-dive.vi.md).

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
| Ngân sách hành động đấu với đàn lạm dụng tính năng (lab) | Đàn chạy script chia các hành động đắt qua 24 danh tính (vòng kinh điển vế tính năng v2.6.0, phía protected, số đo lab) | Baseline (không bảo vệ): **80/80 thao tác hoàn thành trong 241 ms, 0 lần ngắt**. Khi có bảo vệ, sau vòng fix: **16/80 hoàn thành (20,0%)**, số đích phân biệt tối đa mỗi danh tính bị giữ ở **500**, và độ phủ ma sát đo bằng enrollment là **24/24** danh tính (bộ đếm flag union đọc được 14/24 - cơ chế enroll ngay tại attempt chặn thành viên gia nhập trước khi chúng sinh ra observation mà bộ đếm đó đếm; cả hai con số đều được báo cáo trong bản tìm hiểu sâu). Kinh tế kẻ tấn công cùng vòng: 220 lượt thử, 108 lần ngắt, 96 lần HTTP 429 rate-limit, thời gian thực 480.445 ms (chạm trần của driver) |
| Người dùng hợp lệ ở vế tính năng (lab) | Đội đã khai báo, đội chưa khai báo, người dùng thường dưới lớp hành động (vòng kinh điển vế tính năng v2.6.0, phía protected, số đo lab) | Đội 6 người đã khai báo: **40/40 thao tác, 0 ma sát, 0 enrollment**. Đội 6 người chưa khai báo: **40/40, 0 việc bị mất, không bị từ chối cứng**. Đội 8 người chưa khai báo: tại mốc 15 phút **20/40 hoàn thành** qua 3.205 lượt thử với 3.185 sự kiện ma sát - tất cả ở bậc step-up + sàn mềm, **0 lần từ chối cứng**; việc không bao giờ bị từ chối thẳng, nó chỉ chảy ở tốc độ bị chặn trên đã công bố. Người dùng thường (8 người): **48/48 thành công ngay lần đầu, 0 hậu quả** |
| Canary actions (lab) | Đích hành động giả đã đăng ký (một mã khuyến mãi / lát export mà UI thật không bao giờ phát ra) bị một danh tính tấn công chạm vào (vòng kinh điển vế tính năng v2.6.0, phía protected, số đo lab) | Chạm vào đích canary (lát 40) chỉ làm taint đúng kẻ chạm, nối nó vào nhóm bị gắn cờ qua `taintedMembers`, và enroll nó vào step-up bằng bằng chứng trực tiếp; người đứng ngoài trong cùng ô đo được **0 taint, 0 enrollment, 0 override**. Vòng 1 của ô này trượt tiểu mục kiểm tra người đứng ngoài vì materiality theo cost thô; vòng fix với materiality theo đóng góp đã đạt cả bốn tiểu mục - xem bản tìm hiểu sâu |

| Trần khai báo dưới tải song song (lab) | 40 worker đồng thời đập vào trần cứng 600 của một cohort khai báo (ô kinh điển v2.7.0) | Đường check-then-serve cũ vượt trần: union **639** (request 1 bản ghi) và **1.575** (request 25 bản ghi). Đường đặt chỗ mới (`reserveServe`) giữ **đúng 600, vượt 0**, cả hai dạng; làn kiểm soát khai báo-bảo vệ phục vụ **1.200/1.200**, 0 can thiệp |
| Engine bằng chứng anytime-valid (lab, mô phỏng) | Tripwire e-value (`createEvalueTripwire`): tỉ lệ gắn cờ giả bảo đảm theo cấu trúc (Ville) dưới một ngưỡng cường độ hợp lệ do host đặt; mô phỏng đăng ký trước, có seed, tái lập được | **0 lần bắn nhầm trong 10.000** lượt hợp lệ ở mức danh nghĩa 5% và 1%; ở biên khắc nghiệt nhất (trung bình hợp lệ đúng bằng ngưỡng, phương sai tối đa) **4,2% so với lời hứa 5%**. Phát hiện: slicing bị bắt ở trung vị **400** bản ghi union (CUSUM trên cùng traces: 1.225). Cái giá in rõ: một lớp hợp lệ chạy chỉ hơi trên ngưỡng bị gắn cờ với xác suất gần 1 (ngưỡng là điều kiện của bảo đảm - một công cụ hiệu chuẩn đi kèm engine), cho ăn từng bản ghi thì mù trước ID-walk chậm, và dạng tích thường cần trung vị **774** bước để bắt một cuộc tấn công sau thời gian dài yên lặng - dạng Shiryaev-Roberts đi kèm cắt con số đó xuống **14** với bảo đảm thời-gian-trung-bình-giữa-hai-lần-báo-nhầm riêng |
| Các ô tấn công vế tính năng S2 + S3, kẻ tấn công LLM (lab) | Đàn tìm kiếm nặng (16 danh tính), săn khuyến mãi (12 danh tính), và một kẻ tấn công điều khiển bằng LLM trực tiếp trên ô export (v2.7.0, phía protected) | Tìm kiếm nặng: cờ phủ **10/16**, hoàn thành **30%** so với baseline - ô này còn bắt được một bug gom nhóm thật (người đứng ngoài bị hút vào cờ, che chắn cho một kẻ tấn công); sau khi sửa: hoàn thành **25%**, người đứng ngoài nằm trong **không** cờ nào, **16/16** kẻ tấn công bị enroll. Săn khuyến mãi: **12/12** bị gắn cờ, lượt nhận mỗi danh tính bị chặn ở **2-3 mỗi cửa sổ phút**, lượt nhận đầu của control sạch. Kẻ tấn công LLM (một model, SambaNova gemma-4-31B-it, 2 lượt): **16/80 (20%)** - kết quả y hệt đàn chạy script, **24/24** bị enroll; nó không hề thử chiến lược né sàn đã ghi sẵn trong prompt của nó |

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

`npm run check` gồm biên dịch, **585 kiểm thử tự động** (583 đạt, 2 vector RSA-PSS bị bỏ qua) và kiểm tra tĩnh. Có thể quét thư mục build công khai bằng `node scripts/run-audit.cjs dist` hoặc `python3 scripts/verify-build.py dist`.

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
