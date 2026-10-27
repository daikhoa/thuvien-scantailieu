# Nhận diện góc ảnh tĩnh — 27/10/2026

## Lựa chọn

Giữ DocCornerNet LEAN hiện có, thêm tinh chỉnh cạnh trong C++ và phục hồi có giới hạn cho ảnh khó. Không hạ ngưỡng hiện diện mặc định 0,5 cho mọi ảnh. Không thêm model vào gói chạy chính.

Đã thử hai model có sẵn của [DocAligner](https://github.com/DocsaidLab/DocAligner): LCNet100 heatmap và LCNet050 point, theo tiền xử lý BGR/255 và hậu xử lý của tác giả. Heatmap bỏ sót hai cảnh nhiều vật trên bàn; point tìm được thêm một số ảnh nhưng góc chưa sát bằng phương án được chọn trên bộ ảnh này. Các model thử nghiệm được tải từ URL tác giả công bố, không huấn luyện lại. Chúng không được đưa vào gói phát hành.

## Nguyên nhân đã tái hiện

Hai ảnh trên bàn thực sự bị model trả điểm dưới 0,5 trên đường web (khoảng 0,17 và 0,26), khiến ứng dụng giữ toàn ảnh. Không có bằng chứng model chưa được tải trong lần tái hiện này.

DLL cũ và trình duyệt thu nhỏ ảnh khác nhau: DLL dùng nội suy tuyến tính trực tiếp từ ảnh lớn về 224; web qua khung 960 rồi canvas 224. Khác biệt lọc khi thu nhỏ làm thay đổi điểm và cả góc, đặc biệt với lưới ô vuông/hoa văn nhỏ. Điểm hiện diện cao cũng không bảo đảm bốn góc chính xác. DLL mới thu nhỏ có chống alias trước khi suy luận; classifier/tone/filter không thay tham số trong lần sửa này.

## Luồng được chọn

1. Ảnh tĩnh được giảm về cạnh tối đa 960 cho nhận diện, tách khỏi ảnh nguồn dùng để xuất.
2. DocCornerNet nhận tensor 224 × 224 như cũ. Với ảnh tĩnh, SDK lấy cả đề xuất yếu để kiểm tra bằng chứng; camera trực tiếp vẫn dùng ngưỡng 0,5 và một lượt model như trước.
3. C++ tinh chỉnh trên ảnh cạnh tối đa 768: tìm cạnh bằng Canny/Hough, xét tối đa 240 đoạn thẳng quanh các cạnh được đề xuất, chấm mức đổi màu hai phía đường biên và giao các đường để điều chỉnh góc. Có các giả thuyết sửa một góc lệch, không ép mọi giấy thành hình bình hành.
4. Nếu model đã đủ tin cậy, giữ khung hợp lệ và tinh chỉnh khi có đủ bằng chứng cạnh. Nếu model yếu, phải có hỗ trợ cạnh ít nhất 24/100, sau đó suy luận lại vùng bao quanh ứng viên. Chỉ nhận khi điểm xác nhận ≥0,65 và IoU giữa hai đề xuất ≥0,75.
5. Nếu toàn cảnh không thành công, thử thêm đúng một vùng trung tâm. Không nhận khung bám sát biên vùng cắt phụ để tránh cắt cụt tài liệu.
6. Tối đa hai vùng thử và hai lượt xác nhận, **không quá bốn lần suy luận cho một ảnh khó**; ảnh thông thường chỉ cần một lần. Tất cả chạy tuần tự, dùng cùng session. Không lặp phục hồi này trên từng khung video.
7. Không đủ bằng chứng vẫn giữ toàn ảnh để chỉnh thủ công. Khung do người dùng chọn không bị thuật toán tự thay khi đổi bộ lọc/xoay trang.

`src/corner-refinement.cpp` trong thư viện sở hữu toán tinh chỉnh, mức hỗ trợ và kiểm tra xác nhận; DLL và WASM dùng cùng nguồn đó. SDK chỉ lo chuẩn bị ảnh, gọi model, chuyển tọa độ và gọi các hàm C++ tương ứng. C ABI công khai vẫn là phiên bản 1. Canny/Hough tận dụng dependency OpenCV imgproc sẵn có trong thư viện; không thêm lại một lựa chọn xử lý OpenCV độc lập trên giao diện.

## Đo và xác minh

Chi tiết theo ảnh, hash, góc tham chiếu và số đo ở [báo cáo JSON](corner-refinement-results.json).

| Bộ ảnh | Trước | Sau |
| --- | --- | --- |
| 9 ảnh người dùng, web thực trong trình duyệt | 6/9 có khung; IoU trung bình 0,638 | 9/9 có khung; IoU trung bình 0,963 |
| 9 ảnh người dùng, DLL | 7/9 có khung; IoU trung bình 0,648 | 9/9 có khung; IoU trung bình 0,965 |
| 10 ảnh SmartDoc development, DLL | IoU 0,976 | IoU 0,980 |
| 5 ảnh SmartDoc holdout, DLL | IoU 0,958 | IoU 0,983 |
| 2 ảnh không có tài liệu, DLL | 0 cắt nhầm | 0 cắt nhầm |

Góc tham chiếu cho 9 ảnh người dùng được đánh dấu thủ công gần đúng; các số này không phải tuyên bố độ chính xác trên mọi tài liệu. SmartDoc dùng nhãn chính thức; ảnh không tìm được khung được tính IoU bằng 0. Không dùng nhãn holdout để chọn ngưỡng hình học.

DLL: trung vị bước nhận diện trên bộ ảnh người dùng tăng từ khoảng 7 ms lên khoảng 59 ms trên máy thử. Web: một lượt đo trong trình duyệt có trung vị khoảng 98 ms, lượt đầu gồm nạp WASM khoảng 316 ms. Đây là chi phí riêng nhận diện, không phải toàn bộ giải mã/khử bóng/xuất ảnh.

Đo hai tiến trình native độc lập, chế độ Gốc, đầu ra cạnh 300 để tách chi phí nhận diện: peak working set khoảng 100 MB → 110 MB; working set sau 9 ảnh khoảng 61 MB → 64 MB. Không dùng số này làm ước lượng RAM khi xuất ảnh lớn hoặc chạy GCNet. WASM tăng từ 732.684 lên 1.400.493 byte; không thêm trọng số model. Kiểm thử lặp tinh chỉnh kiểm tra heap không tăng; kiểm thử ảnh 48MP và pixel đầu ra được giữ.

Đã kiểm tra luồng web chính nhập hai ảnh khó đến màn hình xem tài liệu, dùng gói SDK mới. Kiểm thử bao gồm giữ đường camera nhẹ, phục hồi giới hạn, xác nhận không khớp, tọa độ vùng cắt, huỷ công việc và ABI/WASM thực.

## Giới hạn

- Chưa đo trực tiếp nhiệt độ, pin hoặc thời gian trên điện thoại iPhone/Android thật. Số đo nêu trên là máy tính, không cam kết thiết bị nào cũng có cùng thời gian.
- Nhiều tài liệu chồng lên nhau vẫn có thể làm mục tiêu không rõ ràng; thuật toán không biết chắc người dùng muốn chọn vật nào.
- Biên bị che, phản sáng mất dữ liệu hoặc quá ít pixel vẫn có thể cần chỉnh tay. Không tuyên bố trải phẳng mọi dạng giấy cong.
- Giữ tham số màu/khử bóng và độ phân giải xuất hiện tại; việc thay khung cắt có thể làm nội dung vùng tăng cường khác trước.

Sau khi phát hành, dọn các model/môi trường thử nghiệm và bản đóng gói trung gian; giữ nguồn, bài kiểm thử, số đo và bản SDK/DLL đang dùng. AgentMemory đã được đối chiếu khi tiếp tục công việc; không có kết quả cũ phù hợp. Tài liệu này và ghi chú bàn giao lưu quyết định, kiểm thử và giới hạn.

Bản SDK cuối: `0.2.0-ca50b01a16a7`. Đã vượt qua 608 kiểm thử web, 10 nhóm CTest native, kiểm thử gói/WASM thực (gồm lặp 20 lượt không tăng heap), lint, TypeScript và kiểm tra worker production không tự import lại entry.
