#include "internal.hpp"
#include <algorithm>
#include <cstdio>
#include <locale>
#include <sstream>
namespace docscan {
std::vector<uint8_t> make_pdf(const std::vector<std::unique_ptr<Page>> &pages,
                              const std::atomic<bool> &cancel, uint64_t maximum_bytes) {
    require(!pages.empty());
    uint64_t image_bytes = 0;
    for (const auto &p : pages) {
        image_bytes += p->jpeg.size();
    }
    require(image_bytes <= maximum_bytes, DS_LIMIT_EXCEEDED);
    std::vector<uint8_t> output;
    output.reserve(static_cast<size_t>(std::min(maximum_bytes, image_bytes + pages.size() * 1100 + 1024)));
    const auto text = [&](const std::string &value) {
        require(value.size() <= maximum_bytes - output.size(), DS_LIMIT_EXCEEDED);
        output.insert(output.end(), value.begin(), value.end());
    };
    const size_t object_count = 2 + 3 * pages.size();
    std::vector<size_t> offsets(object_count + 1);
    const auto object = [&](size_t id) {
        offsets[id] = output.size();
        text(std::to_string(id) + " 0 obj\n");
    };
    text("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    object(1);
    text("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    object(2);
    text("<< /Type /Pages /Count " + std::to_string(pages.size()) + " /Kids [");
    for (size_t i = 0; i < pages.size(); ++i)
        text(std::to_string(3 + 3 * i) + " 0 R ");
    text("] >>\nendobj\n");
    for (size_t i = 0; i < pages.size(); ++i) {
        check_cancel(cancel);
        const auto &p = *pages[i];
        const auto id = 3 + 3 * i;
        std::ostringstream dimensions;
        dimensions.imbue(std::locale::classic());
        dimensions.precision(12);
        dimensions << p.info.width * 72.0 / 300.0 << ' ' << p.info.height * 72.0 / 300.0;
        const auto dims = dimensions.str();
        object(id);
        text("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + dims + "] /Resources << /XObject << /Im0 " +
             std::to_string(id + 1) + " 0 R >> >> /Contents " + std::to_string(id + 2) + " 0 R >>\nendobj\n");
        object(id + 1);
        text("<< /Type /XObject /Subtype /Image /Width " + std::to_string(p.info.width) + " /Height " +
             std::to_string(p.info.height) +
             " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " +
             std::to_string(p.jpeg.size()) + " >>\nstream\n");
        require(p.jpeg.size() <= maximum_bytes - output.size(), DS_LIMIT_EXCEEDED);
        output.insert(output.end(), p.jpeg.begin(), p.jpeg.end());
        text("\nendstream\nendobj\n");
        const std::string stream = "q\n" + dims.substr(0, dims.find(' ')) + " 0 0 " +
                                   dims.substr(dims.find(' ') + 1) + " 0 0 cm\n/Im0 Do\nQ\n";
        object(id + 2);
        text("<< /Length " + std::to_string(stream.size()) + " >>\nstream\n" + stream +
             "endstream\nendobj\n");
    }
    const size_t xref = output.size();
    text("xref\n0 " + std::to_string(object_count + 1) + "\n0000000000 65535 f \n");
    char line[32];
    for (size_t id = 1; id <= object_count; ++id) {
        require(offsets[id] < 10000000000ull, DS_LIMIT_EXCEEDED);
        std::snprintf(line, sizeof(line), "%010llu 00000 n \n", static_cast<unsigned long long>(offsets[id]));
        text(line);
    }
    text("trailer\n<< /Size " + std::to_string(object_count + 1) + " /Root 1 0 R >>\nstartxref\n" +
         std::to_string(xref) + "\n%%EOF\n");
    check_cancel(cancel);
    return output;
}
} // namespace docscan
