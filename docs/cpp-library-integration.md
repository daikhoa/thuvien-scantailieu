# Thư viện Docscan và web sử dụng

Nguồn chính nằm trong `../thuvien`. Web cài gói `@docscan/browser` từ `vendor/`;
gói chứa SDK, C++ WebAssembly, các model và runtime cần thiết. SDK tự nối detector,
khử bóng và tăng cường. Các đường import cũ là re-export để giữ tương thích;
thuật toán JavaScript cũ chỉ còn làm mốc trong trang so sánh.

## Gọi từ web khác

```ts
// vite.config.ts: thêm docscanAssets() vào plugins hiện có
import { docscanAssets } from '@docscan/browser/vite';

// Mã ứng dụng
import { createDocscan } from '@docscan/browser';
const scanner = createDocscan();
const page = await scanner.process(file);
const pdf = await scanner.processPdf([file1, file2]);
// Khi ứng dụng đóng:
await scanner.dispose();
```

`process()` sở hữu nhập ảnh, phát hiện tài liệu, cắt/chỉnh phối cảnh, lựa chọn
chạy GCNet, bù bóng và tăng cường mặc định. `page.image` là Blob kèm kích thước;
`page.variant.enhancement` cho biết model đã chạy hay phải dùng fallback nhẹ.
`render(original, recipe)` áp dụng chỉnh sửa, không cần caller chạy model.
`createPdf(pages)` ghép các trang đã xử lý. Có `AbortSignal`, hàng đợi, giải phóng
runtime khi nhàn rỗi và `dispose()`.

Giao diện quản lý camera, thao tác người dùng, ảnh gốc, danh sách tài liệu và
lưu/chia sẻ kết quả. SDK sở hữu worker, codec, detector, classifier, GCNet,
renderer và PDF. Không gửi ảnh lên máy chủ. Model được đóng gói thành file tài
nguyên, tải lười và do SDK quản lý; không nhúng trọng số trực tiếp vào mã DLL.

Gói browser hiện dành cho TypeScript/ESM với Vite. Plugin SDK tự cung cấp asset
và cấu hình worker an toàn; không cần sao chép model từ web cũ. Build system khác
cần adapter asset/worker tương ứng một lần, không viết lại xử lý ảnh.

## Gọi trực tiếp trong hệ thống native

Gói `../thuvien/dist/docscan-win-x64.zip` chứa DLL, header C ABI, runtime, model,
tài liệu và ví dụ. DLL tự gọi ONNX Runtime để chạy model trong cùng tiến trình;
không cần web hoặc một dịch vụ xử lý từ xa.

Facade Python có sẵn trong `share/docscan/examples/docscan_sdk.py`:

```python
from docscan_sdk import Scanner
with Scanner(package_directory) as scanner:
    page = scanner.process(image_bytes)
    pdf_bytes = scanner.process_pdf([image1_bytes, image2_bytes])
```

C/C++ gọi C ABI trong `include/docscan/docscan.h`; ngôn ngữ khác dùng FFI/binding
cho ABI này. Gói native hiện được build và xác minh trên Windows x64. OS/kiến trúc
khác cần build tương ứng và binding phù hợp, không cần viết lại thuật toán.
Browser dùng cùng lõi C++ qua WASM, nhưng codec/runtime model và PDF theo nền tảng;
không cam kết kết quả byte giống hệt DLL ở mọi định dạng.

## Nơi sửa và build

| Phần | Nguồn chính trong thuvien |
| --- | --- |
| Phối cảnh, lấy mẫu, vùng nguồn | `src/geometry.cpp` |
| Đánh giá, tham số và tăng cường | `src/quality.cpp`, `src/appearance-plan.cpp`, `src/adaptive-enhancement.cpp`, `src/filters.cpp` |
| Model và pipeline native | `src/models.cpp`, `src/shadow-model.cpp`, `src/pipeline.cpp` |
| SDK browser, lifecycle và model orchestration | `browser/src/` |
| Cầu nối C++/WASM | `wasm/bridge.cpp` |

Từ thư mục web, chạy `npm run library:build` để build C++ đã cấu hình, đóng gói SDK
theo hash nguồn/asset và cập nhật dependency. Sau đó chạy `npm run library:test`,
`npm test -- --maxWorkers=2`, `npm run build`. Máy mới cần CMake/Emscripten và
OpenCV core/imgproc cho Emscripten, theo `thuvien/docs/wasm.md`. Build native bằng
`thuvien/scripts/build-windows.ps1 -Package`.

Chỉ sửa nguồn trong thư viện rồi build/phát hành lại các ứng dụng dùng nó. Không
sửa tay file generated, tarball hoặc bản trong `node_modules`. Hosted build dùng
gói đã kiểm tra nên không cần compiler C++ hay đường dẫn `../thuvien` trên host.

## Giới hạn và xác minh

Giữ nguyên model, tham số và giới hạn ảnh đã được duyệt. Đọc ảnh lớn theo vùng để
tránh tạo nhiều bản RGBA toàn ảnh; xử lý tuần tự và giải phóng tài nguyên khi hủy.
Model lỗi được báo thật; không dùng kết quả giả hoặc âm thầm chuyển lại kernel JS.

Đã kiểm tra SDK trong một dự án riêng ngoài cây nguồn web: tự nhận diện, GCNet,
C++ và PDF hai trang, chỉ cài package và plugin. Có kiểm tra public API, hủy/đóng,
chỉnh sửa, giới hạn batch, checksum package, worker import graph và bộ kiểm tra
ứng dụng hiện có. Python facade kiểm tra với DLL và model đóng gói thật. Không có
đo nhiệt độ, pin hoặc xác minh mới trên iPhone/Android vật lý trong lần thay đổi này.

## Sửa vòng đời chỉnh sửa (2026-10-27)

Nhập ảnh, đổi bộ lọc, xoay và cắt lại dùng cùng `BackgroundPageProcessor.render()`
và hàng đợi SDK. Không tạo thêm editor engine chứa một bộ detector/WASM/model
riêng. Runtime lỗi được thu hồi; lần chỉnh sửa tiếp theo được khởi tạo lại,
trang trước vẫn giữ nguyên khi một lượt xử lý thất bại.

SDK đóng bitmap nguồn và thu nhỏ canvas tạm ngay sau lần đọc vùng cuối, trước
khi GCNet cấp phát tensor. Với ảnh 2880 × 3840, riêng bitmap RGBA tương đương
44.236.800 byte được phép thu hồi sớm. Đây là giới hạn vòng đời tài nguyên,
không phải số đo giảm RSS thực tế của Safari. Giữ nguyên mẫu model tối đa 384,
trọng số, tham số tăng cường và giới hạn đầu ra 3000; không hạ chất lượng để né lỗi.

Hồi quy bao gồm thiết bị giả lập chỉ đủ một runtime, thay bộ lọc/xoay/cắt lại,
thu hồi bitmap trước inference và xử lý lại sau lỗi editor. Chưa có phép đo hay
xác minh trên iPhone thật; thiếu bộ nhớ thực sự vẫn được báo thay vì giả thành công.
AgentMemory không khả dụng trong phiên này; bàn giao được lưu tại tài liệu này.
