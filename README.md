# Docscan — thư viện C++ xử lý ảnh tài liệu → PDF

Thư viện native độc lập, gọi **trong cùng tiến trình** qua C ABI. Web chính hiện dùng SDK `@docscan/browser` được đóng gói từ `browser/`, với bản WASM của lõi C++; DLL Windows không chạy trong trình duyệt. Nhánh JavaScript cũ được giữ cho so sánh và kiểm thử. Không cần chạy server xử lý ảnh khi gọi thư viện.

## Có thể dùng ngay

- Nhập một hoặc nhiều ảnh theo thứ tự; nhận JPEG từng trang và PDF nhiều trang.
- Tự nhận diện bốn góc bằng cùng mô hình DocCornerNet của web; cho phép truyền bốn góc thủ công hoặc giữ toàn khung.
- Nắn phối cảnh, tự điều chỉnh theo nội dung, tăng màu, ảnh xám và trắng đen Sauvola.
- Giữ màu bằng Lab và giới hạn vùng sáng; cảnh báo ảnh mờ, cong, có ngón tay hoặc moiré để bên gọi quyết định chụp lại.
- **Bộ lọc mặc định: Tăng cường màu** (`DS_FILTER_ENHANCED_COLOR`). Có thể chọn Auto/Gốc/Xám/Đen trắng qua `ds_page_options.filter`.
- Tăng cường hiện kết hợp chính sách thích ứng, bảo vệ màu/chữ và GCNet bù bóng khi cần; model được nạp theo nhu cầu. Không chạy được model thì có cảnh báo và bản tăng cường nhẹ. Xem `docs/adaptive-enhancement.md`; `paper-v2` là một bước phát triển trước đó.
- JPEG chất lượng 96, lấy mẫu màu **4:4:4** mặc định. PDF nhúng đúng JPEG đã xử lý, không nén JPEG thêm lần nữa.
- Hỗ trợ EXIF 1–8; PNG có alpha được ghép nền trắng. JPEG/PNG/WebP SDR; PNG 1/2/4/8/16 bit hợp lệ. PNG 16 bit được quy đổi về 8 bit trước khi tạo JPEG.

Bản đã dựng và kiểm tra: **Windows x64 / Release**. Gói dùng thử nằm ở `dist/docscan-win-x64.zip`, DLL ở `dist/docscan-win-x64/bin/docscan.dll`. Mã nguồn dùng C++17 và CMake; Linux/macOS cần biên dịch với dependency tương ứng và chưa được xác minh trên máy này.

## Chạy thử trên máy hiện tại

```powershell
.\build\Release\docscan_cli.exe models build\sample.pdf tests\fixtures\synthetic\perspective-document.png
```

Hoặc Python (chỉ dùng thư viện chuẩn Python khi gọi DLL):

```python
from docscan import Library  # examples/docscan.py

lib = Library(r"dist/docscan-win-x64/bin/docscan.dll")
with lib.engine(lib.config(r"dist/docscan-win-x64/share/docscan/models")) as engine:
    with engine.document() as document:
        document.add(open("page1.jpg", "rb").read(), lib.options())
        document.add(open("page2.png", "rb").read(), lib.options())
        with open("document.pdf", "wb") as output:
            output.write(document.pdf())
```

**Tái dùng một engine** cho nhiều tài liệu để mô hình chỉ tải một lần. Thực hiện các lời gọi đồng bộ trên worker/thread do ứng dụng quản lý nếu ứng dụng có giao diện. Không gọi xử lý nặng ngay trên UI thread.

## Gọi từ hệ thống khác

Khi phân phối ứng dụng Windows, đặt **toàn bộ DLL trong `bin/` của gói bên cạnh EXE**; không chỉ trỏ PATH tới một DLL. Nếu host đã nạp ONNX Runtime khác, phải bảo đảm runtime hỗ trợ API 27 hoặc tách tiến trình. Thư viện kiểm tra API trước khi khởi tạo và trả `DS_MODEL_UNAVAILABLE` nếu không tương thích.

Header công khai: `include/docscan/docscan.h`. Không để `cv::Mat`, STL hoặc kiểu C++ đi qua ranh giới thư viện. C++/C gọi trực tiếp; Python đã có ví dụ ctypes. C#/Rust/Go/Java/Node cần một lớp binding mỏng phù hợp FFI của ngôn ngữ đó. Không cần viết lại thuật toán cho từng ngôn ngữ; DLL và bên gọi phải cùng kiến trúc x64.

Luồng gọi:

```text
engine_create → document_create → add_image (lặp từng ảnh)
                             → get_page (nếu cần xem JPEG/cảnh báo)
                             → document_pdf → buffer_bytes → buffer_destroy
                             → document_destroy → engine_destroy
```

Kiểm tra `ds_abi_version() == DS_ABI_VERSION` trước khi truyền struct. Mọi hàm trả `ds_status` phải được kiểm tra. Khởi tạo cấu hình bằng `ds_engine_config_init`, tùy chọn bằng `ds_page_options_init`; không tự đặt packing khác cho struct. Chi tiết quyền sở hữu, đồng thời và pipeline nằm trong `docs/architecture.md`.

## Chất lượng và giới hạn tài nguyên

Mặc định: đầu vào tối đa **128 MiB / 64 megapixel**, mỗi cạnh không quá 16384; tối đa 100 trang; tổng JPEG và PDF đều không quá 128 MiB. Bộ đệm xử lý pixel có ngân sách 512 MiB. Đây là **ước lượng kiểm tra trước**, không phải giới hạn RAM toàn tiến trình; bộ nhớ model/codec, ảnh của bên gọi, JPEG giữ lại và PDF đầu ra được tính riêng.

Cạnh dài ảnh xuất mặc định 3000 như web, có thể chọn 4096 hoặc tối đa 8192 qua `maximum_output_side`, trong ngân sách bộ nhớ; không phóng lớn toàn bộ ảnh nhỏ chỉ để tăng số pixel. Ảnh phân tích 720 và tensor AI 224×224 tách riêng khỏi ảnh xuất. JPEG vẫn là định dạng mất dữ liệu, kể cả quality 100; không hứa khôi phục chi tiết không có trong ảnh nguồn.

Tài liệu không nhận ra được sẽ giữ toàn khung và trả `DS_WARN_NO_DOCUMENT`; không tự cắt đoán bằng thuật toán cổ điển. Engine không có model chỉ dùng được crop thủ công/toàn khung; chế độ auto báo `DS_MODEL_UNAVAILABLE`.

**Giới hạn bản này:** chưa có decoder HEIC/HEIF/AVIF/RAW; chưa chuyển profile ICC Display-P3/Adobe RGB về sRGB, chưa xử lý HDR. Bên tích hợp cần chuẩn hóa các ảnh đó thành JPEG/PNG/WebP **sRGB SDR** trước khi truyền vào. Không nên coi kết quả màu của ảnh wide gamut là tương đương canvas trình duyệt. Việc thêm codec/color management là một thay đổi riêng, không thay đổi C ABI hiện tại.

## Biên dịch và kiểm thử

Cần Visual Studio 2022 C++ x64, Windows SDK và CMake ≥3.24; máy chỉ chạy DLL cần Microsoft Visual C++ 2015–2022 x64 Redistributable.

```powershell
# Lần đầu: tải dependency đã ghim SHA-256, dựng OpenCV tối thiểu.
.\scripts\bootstrap-windows.ps1

# Python là tùy chọn cho bộ kiểm thử tích hợp độc lập.
python -m pip install -r requirements-test.txt
.\scripts\build-windows.ps1 -Python (Get-Command python).Source -Package
```

Không có Python vẫn build được thư viện và chạy các bài native trên Windows; CMake thông báo khi không có dependency để chạy integration. Để kiểm tra đủ, bảo đảm CTest liệt kê cả `integration`. Gói runtime chỉ chứa DLL cần dùng, model, header, import library, ví dụ và giấy phép; không chứa source/build OpenCV, PDB, bộ dữ liệu kiểm thử hoặc Python.

Đọc `docs/verification.md` để xem phép thử, số đo và những phần chưa được xác minh. Dependency/model và nguồn cấp phép được ghi trong `docs/dependencies.md`.

## Cập nhật Tăng cường v2 — 24/10/2026

Bộ lọc mặc định có cùng thuật toán tăng rõ cạnh chữ nhẹ với web; đo chất lượng ở ảnh đầu ra để tránh mất dấu hiệu chữ nhỏ do ảnh phân tích thu nhỏ. Không đổi C ABI, tên hàm, bộ lọc mặc định, độ phân giải hay mức nén JPEG/PDF. `analysis_side` vẫn dùng cho Auto/Xám/Đen trắng; Tăng cường và Gốc không cần lượt phân tích thu nhỏ này.

Đã kiểm tra 23 bộ pixel đối chiếu web và 5 nhóm CTest. Trong phép đo luân phiên DLL cũ/mới trên máy Windows hiện tại, tổng xử lý JPEG+PDF ảnh 12MP là 253.85 → 256.92ms; ảnh 48MP là 558.66 → 596.98ms. Có thêm chi phí cho độ rõ; không khẳng định mọi ảnh đều nhanh hơn. Bộ nhớ chi tiết thêm tối đa 9KB ở chiều rộng 3000px. Đọc điều kiện và giới hạn đo trong `docs/verification.md`. Chưa kiểm tra tốc độ/nhiệt trên điện thoại; không hứa khôi phục chi tiết đã mất do rung/mờ mạnh.

## Bản thử trong trình duyệt

Đã bổ sung target WebAssembly riêng tại `wasm/`, dùng chung mã cắt phối cảnh, đo chất lượng và bộ lọc với DLL. Web cũ vẫn giữ nguyên; khu vực `?compare=1` chỉ dùng để đối chiếu cùng ảnh/vùng cắt. Giải mã và xuất PNG/PDF dùng chung bên trình duyệt, không đo toàn bộ DLL. Xem `docs/wasm.md` và `../camscanner2/docs/wasm-comparison.md` để dựng, kiểm thử và hiểu giới hạn đo.

## OpenCV thử nghiệm — 24/10/2026

Có hàm C mới `ds_document_add_image_opencv` để chọn cắt phối cảnh và tăng cường
bằng OpenCV. Hàm cũ, bộ lọc mặc định và ABI1 giữ nguyên. Có ba mức Nhẹ, Cân bằng,
Rõ chữ; bản mới hỗ trợ Gốc/Tăng cường, không tự chuyển bộ lọc khác. Cần dùng
header và DLL mới cùng nhau. Xem `docs/opencv.md` để gọi, chọn tham số và hiểu
giới hạn đo. Web so sánh dùng WASM v2, có đủ các cặp Web/C++ cũ/OpenCV.

## OpenCV tăng cường v2 — 25/10/2026

Nhánh OpenCV đã có cân bằng nền giấy, hạn chế tăng nhiễu và bảo vệ màu theo ảnh.
Mức Cân bằng mặc định dùng CLAHE clip2.0, trộn tối đa70%, tự giảm khi cần.
Đầu ra, hàm C và thuật toán tự viết giữ nguyên. DLL và WASM v3 dùng chung mã mới;
xem `docs/opencv.md` và báo cáo bên web để đọc phép đo và giới hạn.

## Adaptive default — 2026-10-26

`DS_FILTER_ENHANCED_COLOR` now includes selective pretrained illumination correction and local ink enhancement. Color/gray artwork is protected conservatively. Native ABI1 is unchanged; `DS_WARN_SHADOW_UNAVAILABLE` (64) identifies a usable lightweight fallback. See [adaptive-enhancement.md](docs/adaptive-enhancement.md) for pipeline, local OCR checks and limitations. Explicit `DS_FILTER_SHADOW_REMOVAL` retains its opt-in behavior. The packaged optional GCNet model is loaded lazily.

## Dọn dung lượng — 27/10/2026

Đã xoá archive tải dependency đã giải nén, PDB debug ONNX Runtime và thư mục build OpenCV trung gian. Giữ source/install dependency đang được CMake tham chiếu, model, SDK browser, build native, bộ kiểm thử và gói phát hành hiện tại. Native Release và CTest đã được chạy lại sau khi dọn. Các mục OpenCV thử nghiệm theo ngày trong tài liệu này là lịch sử, không phải luồng mặc định của web.

## Nhận diện góc ảnh tĩnh — 27/10/2026

DocCornerNet giữ ngưỡng hiện diện mặc định 0,5. C++ tinh chỉnh đường biên trên ảnh nhỏ, xác nhận lại ứng viên yếu và thử thêm một vùng trung tâm khi cần; tối đa bốn lượt model cho ảnh khó. DLL và SDK/WASM dùng cùng lõi tinh chỉnh, không thêm trọng số model. C ABI1 giữ nguyên. Xem `docs/corner-refinement.md` và số đo trong gói phát hành.
