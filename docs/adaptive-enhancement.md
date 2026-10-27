# Tăng cường theo vùng — Web và C++ (26/10/2026)

Chế độ **Tăng cường** mặc định đã tích hợp bù bóng. Ảnh gốc, kích thước đầu ra và các bộ lọc còn lại được giữ lại. Không huấn luyện model mới, không tải ảnh lên dịch vụ OCR.

## Luồng hiện tại

1. Giải mã ảnh và cắt/chỉnh phối cảnh như trước.
2. Lấy mẫu màu tối đa 384 px mỗi cạnh, chuẩn hóa BGR. Đây chỉ là mẫu phân tích ánh sáng, không phải ảnh xuất. Chặn lỗi làm tròn vượt 384 ở một số tỷ lệ ảnh.
3. Phân tích tối đa 16 × 16 vùng: nền theo phân vị 85%, độ màu, các nét mảnh và tương quan độ tối của mực/nền. Nền màu hoặc mảng in xám không tự động được coi là bóng.
4. Chỉ khi có bằng chứng về giấy và ánh sáng không đều mới tải/chạy GCNet có sẵn (~6 MB). Dùng một luồng xử lý CPU, suy luận ở độ phân giải nhỏ. Trang sáng đều và bìa màu thiếu bằng chứng sẽ bỏ qua model.
5. Lấy trường ánh sáng từ model, kiểm tra toàn bộ dữ liệu trước khi thay đổi pixel. Bù sáng theo vùng; điều chỉnh các vùng màu theo giấy tham chiếu gần đó. Giới hạn hệ số sáng 1–4. Các quy tắc bảo vệ là heuristic, không thể phân biệt hoàn hảo mọi bóng và mọi màu in.
6. Làm đậm **nét tối mảnh đã có**, không lan nét hay vẽ thêm ký tự. Giấy ô ly/vân đều có ngưỡng bảo vệ riêng. Bỏ đường cong tăng tương phản RGB toàn ảnh khỏi luồng mặc định mới.
7. Áp dụng trên buffer ảnh đầy đủ bằng một lượt, dùng vòng đệm vài dòng ảnh; không tạo thêm bản float toàn ảnh. Nền màu phẳng không cần thay đổi được bỏ qua tính toán/ghi pixel.
8. Xuất ảnh/PDF như cũ. Bóng sâu, ánh phản chiếu làm mất dữ liệu và nếp gấp vẫn có thể còn. Không phục dựng chữ bị che hoặc lóa mất.

Nếu bộ khử bóng không tải/chạy được, Tăng cường trả bản xử lý nhẹ và thông báo rõ; không ghi nhận đó là kết quả AI. Cache dùng định danh fallback riêng để có thể thử lại. Nút **Khử bóng AI** cũ vẫn là lựa chọn thử nghiệm độc lập, áp dụng trường model mạnh hơn và có thể đổi màu nền.

## Các bản triển khai

- Web: `src/imaging/restoration/adaptive-enhancement.ts`, gọi qua `enhanced-appearance.ts`; worker và iframe dùng chung facade. Preset `enhanced-color-v6-adaptive`, engine `filter-v13-adaptive`.
- C++ native: `thuvien/src/adaptive-enhancement.{hpp,cpp}`, `shadow-model.cpp`, `pipeline.cpp`. C API ABI1 giữ nguyên; mặc định `DS_FILTER_ENHANCED_COLOR` đi luồng mới. Thiếu model khi cần bù bóng trả trang hợp lệ với `DS_WARN_SHADOW_UNAVAILABLE=64`; explicit AI vẫn báo lỗi khi không có model. Package kèm model đã xác minh.
- So sánh trên Web: WASM **v8** chạy cắt và bộ lọc C++ thực sự. ORT của trình duyệt cung cấp tensor ánh sáng chung; C++ tự phân tích và áp dụng pixel. Giải mã/PNG/PDF dùng chung. Không dùng kết quả này để kết luận tốc độ DLL, bộ mã hóa native hay nhiệt điện thoại. Các tài nguyên v7 cũ được giữ để tái hiện baseline.
- OpenCV vẫn là phụ thuộc hạ tầng Mat/codec trong DLL; không đưa trở lại lựa chọn bộ lọc OpenCV trên giao diện.

## Kiểm tra 10 ảnh thật và OCR

Bộ ảnh gồm giấy trắng có bóng rộng/nếp gấp, ảnh đề thi nhỏ và xoay ngang, bìa màu có bóng, bìa ô ly và bìa xanh phản sáng. Cố định vùng cắt thủ công và chiều xoay để so riêng bộ lọc. Đây **không phải** chứng nhận độ chính xác tự nhận diện/cắt hay tự xoay.

- Cùng RGBA và cùng trường ánh sáng: Web và C++ WASM cho đầu ra trùng từng byte trên 10/10 ảnh. Bốn tình huống hồi quy tổng hợp cũng trùng; native cho sai khác tối đa không quá 1 mức màu theo hợp đồng kiểm tra.
- Chênh nền sáng/tối theo P90–P10 của các vùng nền mẫu, thang 0–255: ảnh 1 **64→8**, ảnh 2 **64→8**, ảnh 3 **92→20**, ảnh 4 **36→8**, ảnh 5 **139→8**, ảnh 6 **163→88**. Đây chỉ là chỉ báo ánh sáng, không phải điểm chất lượng chữ/OCR. Ảnh 6 vẫn còn bóng trên bìa màu; ảnh 8–9 giữ mức nền gần nguyên để tránh tẩy màu.
- OCR chạy cục bộ bằng Tesseract.js 6.0.1, `tessdata_fast` vie+eng, PSM AUTO. Đối chiếu **61 cụm chữ mẫu đọc thủ công**, cùng phép chuẩn hóa và ngưỡng sai khác ký tự tối đa 20% cho mọi bản. Đếm cụm được tìm thấy là kiểm tra độ bao phủ, **không phải tỷ lệ chính xác toàn văn**.

| Ảnh | Cụm mẫu | Tăng cường cũ | Web mới / C++ WASM cùng pixel | DLL mới |
|---|---:|---:|---:|---:|
| 1 | 7 | 1 | 4 | 5 |
| 2 | 7 | 2 | 5 | 5 |
| 3 | 7 | 7 | 7 | 7 |
| 4 | 6 | 4 | 4 | 4 |
| 5 | 7 | 5 | 4 | 7 |
| 6 | 5 | 2 | 2 | 2 |
| 7 | 6 | 0 | 2 | 3 |
| 8 | 5 | 2 | 2 | 2 |
| 9 | 5 | 1 | 0 | 0 |
| 10 | 6 | 1 | 3 | 4 |
| Tổng | 61 | 25 | 33 | 39 |

DLL xử lý từ ảnh gốc và xuất JPEG; bộ Web đo từ crop baseline đã giải mã rồi xuất PNG. Khác biệt codec/ảnh vào làm OCR dao động; không quy chênh lệch DLL/Web cho chất lượng thuật toán. Với cùng pixel, C++ WASM có cùng dữ liệu OCR đầu vào như Web. Không so sánh OCR của CamScanner vì không có file xuất gốc tương ứng để đo công bằng.

Các ảnh 5 và 9 cho thấy OCR không tăng ở mọi trường hợp. Bìa xanh lóa và chữ rất nhỏ chưa đọc ổn định; công thức logic, sơ đồ, chữ viết tay chưa có bản chép chuẩn đầy đủ để tính độ chính xác. Không dùng điểm confidence làm bằng chứng đúng toàn văn. Ảnh và toàn bộ bản OCR được giữ trong thư mục tạm cục bộ; báo cáo công khai chỉ chứa số tổng hợp.

## Chi phí và giới hạn đo

Một lượt desktop trước tối ưu bỏ qua nền phẳng: DLL lọc **36–376 ms/trang**, gồm lần đầu tải session; không gồm giải mã/cắt/JPEG. Web áp dụng chính sách **67–593 ms**, chưa gồm suy luận. Các phạm vi này là quan sát đơn, không phải p95 hay benchmark đối đầu.

Smoke test trình duyệt production trên ảnh 720 × 960 toàn khung: Web giải mã→PNG **671 ms**, C++ WASM **538 ms**, gồm tải/suy luận lần đầu; UI không có khoảng khung hình >50 ms trong lượt đó. Chưa đo nóng máy, pin, tổng RAM cao nhất hoặc xác minh trực tiếp trên iPhone/Android. Bản mới làm thêm việc bù bóng nên không cam kết luôn nhanh hơn bộ lọc cũ.

## Tái kiểm tra

- `npm test -- src tests` (không quét tests của SDK trong thư mục `.tmp-wasm`).
- `npm run typecheck`, ESLint các file thay đổi, `npm run build` (kèm kiểm tra worker Safari không import ngược entry).
- `node scripts/test-adaptive-enhancement.mjs`: WASM thật, controls bóng/mảng xám/bìa màu/ô ly, buffer release và tensor hỏng. Fixtures tổng hợp tái tạo dưới `.tmp-adaptive-parity`.
- Native CMake Release + CTest: ABI, API C, runtime không tương thích, pixel cũ, bộ lọc native cũ, adaptive mới, model thật/thiếu model/hủy, paper và integration/PDF.

Nguồn model và giấy phép: xem `public/models/shadow/MODEL-CARD.md` và các thông báo giấy phép hiện có. Model không được huấn luyện lại hay thay trọng số.
