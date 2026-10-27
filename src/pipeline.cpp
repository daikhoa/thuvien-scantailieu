#include "internal.hpp"
#include "opencv-raster.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
namespace docscan {
namespace {
uint32_t be32(const uint8_t *p) {
    return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3];
}
uint32_t le24(const uint8_t *p) {
    return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16);
}
cv::Size header_size(ds_bytes bytes) {
    const auto *p = bytes.data;
    const size_t n = static_cast<size_t>(bytes.size);
    const uint8_t png[] = {137, 80, 78, 71, 13, 10, 26, 10};
    if (n >= 24 && std::memcmp(p, png, 8) == 0) {
        require(std::memcmp(p + 12, "IHDR", 4) == 0, DS_DECODE_FAILED);
        require(n >= 26, DS_DECODE_FAILED);
        const auto depth = p[24], color = p[25];
        const bool allowed =
            (color == 0 && (depth == 1 || depth == 2 || depth == 4 || depth == 8 || depth == 16)) ||
            (color == 3 && (depth == 1 || depth == 2 || depth == 4 || depth == 8)) ||
            ((color == 2 || color == 4 || color == 6) && (depth == 8 || depth == 16));
        require(allowed, DS_UNSUPPORTED_FORMAT);
        const auto w = be32(p + 16), h = be32(p + 20);
        require(w <= 16384 && h <= 16384 && w > 0 && h > 0, DS_LIMIT_EXCEEDED);
        return {static_cast<int>(w), static_cast<int>(h)};
    }
    if (n >= 12 && std::memcmp(p, "RIFF", 4) == 0 && std::memcmp(p + 8, "WEBP", 4) == 0) {
        require(n >= 30, DS_DECODE_FAILED);
        uint32_t w = 0, h = 0;
        if (std::memcmp(p + 12, "VP8X", 4) == 0) {
            w = le24(p + 24) + 1;
            h = le24(p + 27) + 1;
        } else if (std::memcmp(p + 12, "VP8L", 4) == 0 && p[20] == 0x2f) {
            w = 1 + p[21] + ((p[22] & 63) << 8);
            h = 1 + (p[22] >> 6) + (p[23] << 2) + ((p[24] & 15) << 10);
        } else if (std::memcmp(p + 12, "VP8 ", 4) == 0 && p[23] == 0x9d && p[24] == 1 && p[25] == 0x2a) {
            w = (p[26] | p[27] << 8) & 16383;
            h = (p[28] | p[29] << 8) & 16383;
        }
        require(w && h && w <= 16384 && h <= 16384, DS_DECODE_FAILED);
        return {static_cast<int>(w), static_cast<int>(h)};
    }
    if (n >= 3 && p[0] == 0xff && p[1] == 0xd8 && p[2] == 0xff) {
        size_t pos = 2;
        while (pos + 3 < n) {
            require(p[pos++] == 0xff, DS_DECODE_FAILED);
            while (pos < n && p[pos] == 0xff)
                ++pos;
            require(pos < n, DS_DECODE_FAILED);
            const auto marker = p[pos++];
            if (marker == 0xda || marker == 0xd9)
                break;
            if (marker == 1 || (marker >= 0xd0 && marker <= 0xd8))
                continue;
            require(pos + 2 <= n, DS_DECODE_FAILED);
            const size_t length = (size_t(p[pos]) << 8) | p[pos + 1];
            require(length >= 2 && length <= n - pos, DS_DECODE_FAILED);
            if (marker >= 0xc0 && marker <= 0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc) {
                require(length >= 8 && p[pos + 2] == 8, DS_UNSUPPORTED_FORMAT);
                const int h = (p[pos + 3] << 8) | p[pos + 4], w = (p[pos + 5] << 8) | p[pos + 6];
                require(w > 0 && h > 0 && w <= 16384 && h <= 16384, DS_LIMIT_EXCEEDED);
                return {w, h};
            }
            pos += length;
        }
        throw Failure(DS_DECODE_FAILED);
    }
    throw Failure(DS_UNSUPPORTED_FORMAT);
}
int tiff_orientation(const uint8_t *p, size_t n) {
    if (n < 8)
        return 1;
    const bool little = p[0] == 'I' && p[1] == 'I';
    if (!little && !(p[0] == 'M' && p[1] == 'M'))
        return 1;
    const auto word = [&](size_t at) -> uint32_t {
        return little ? uint32_t(p[at]) | (uint32_t(p[at + 1]) << 8) : (uint32_t(p[at]) << 8) | p[at + 1];
    };
    const auto dword = [&](size_t at) -> uint32_t {
        return little ? word(at) | (word(at + 2) << 16) : (word(at) << 16) | word(at + 2);
    };
    if (word(2) != 42)
        return 1;
    const uint64_t offset = dword(4);
    if (offset > n - 2)
        return 1;
    const auto count = word(static_cast<size_t>(offset));
    if (count > (n - static_cast<size_t>(offset) - 2) / 12)
        return 1;
    for (uint32_t i = 0; i < count; ++i) {
        const size_t at = static_cast<size_t>(offset) + 2 + 12 * i;
        if (word(at) == 274 && word(at + 2) == 3 && dword(at + 4) == 1) {
            const auto value = word(at + 8);
            return value >= 1 && value <= 8 ? static_cast<int>(value) : 1;
        }
    }
    return 1;
}
int orientation(ds_bytes bytes) {
    const auto *p = bytes.data;
    const size_t n = static_cast<size_t>(bytes.size);
    if (n >= 2 && p[0] == 0xff && p[1] == 0xd8) {
        size_t at = 2;
        while (at + 4 <= n && p[at++] == 0xff) {
            while (at < n && p[at] == 0xff)
                ++at;
            if (at >= n)
                break;
            const auto marker = p[at++];
            if (marker == 0xda || marker == 0xd9)
                break;
            if (marker == 1 || (marker >= 0xd0 && marker <= 0xd8))
                continue;
            if (at + 2 > n)
                break;
            const size_t length = (size_t(p[at]) << 8) | p[at + 1];
            if (length < 2 || length > n - at)
                break;
            if (marker == 0xe1 && length >= 8 && std::memcmp(p + at + 2, "Exif\0\0", 6) == 0)
                return tiff_orientation(p + at + 8, length - 8);
            at += length;
        }
    } else if (n >= 8 && p[0] == 137 && p[1] == 'P') {
        size_t at = 8;
        while (at + 12 <= n) {
            const size_t length = be32(p + at);
            if (length > n - at - 12)
                break;
            if (std::memcmp(p + at + 4, "eXIf", 4) == 0)
                return tiff_orientation(p + at + 8, length);
            at += 12 + length;
        }
    } else if (n >= 12 && std::memcmp(p, "RIFF", 4) == 0 && std::memcmp(p + 8, "WEBP", 4) == 0) {
        size_t at = 12;
        while (at + 8 <= n) {
            const size_t length = le24(p + at + 4) | (size_t(p[at + 7]) << 24);
            if (length > n - at - 8)
                break;
            if (std::memcmp(p + at, "EXIF", 4) == 0) {
                const auto *data = p + at + 8;
                size_t size = length;
                if (size >= 6 && std::memcmp(data, "Exif\0\0", 6) == 0) {
                    data += 6;
                    size -= 6;
                }
                return tiff_orientation(data, size);
            }
            at += 8 + length + (length & 1);
        }
    }
    return 1;
}
void orient(cv::Mat &image, int value) {
    switch (value) {
    case 2:
        cv::flip(image, image, 1);
        break;
    case 3:
        cv::rotate(image, image, cv::ROTATE_180);
        break;
    case 4:
        cv::flip(image, image, 0);
        break;
    case 5:
        cv::transpose(image, image);
        break;
    case 6:
        cv::rotate(image, image, cv::ROTATE_90_CLOCKWISE);
        break;
    case 7:
        cv::transpose(image, image);
        cv::flip(image, image, -1);
        break;
    case 8:
        cv::rotate(image, image, cv::ROTATE_90_COUNTERCLOCKWISE);
        break;
    default:
        break;
    }
}
cv::Mat decode(ds_bytes source, cv::Size expected) {
    cv::Mat encoded(1, static_cast<int>(source.size), CV_8U, const_cast<uint8_t *>(source.data));
    cv::Mat image = cv::imdecode(encoded, cv::IMREAD_UNCHANGED);
    require(!image.empty(), DS_DECODE_FAILED);
    if (image.depth() == CV_16U) {
        cv::Mat sdr;
        image.convertTo(sdr, CV_8U, 1.0 / 257);
        image = std::move(sdr);
    }
    require(image.depth() == CV_8U, DS_UNSUPPORTED_FORMAT);
    require(image.size() == expected, DS_DECODE_FAILED);
    if (image.channels() == 4) {
        const int rows = image.rows;
        const size_t count = image.total();
        auto *data = image.data;
        for (size_t i = 0; i < count; ++i) {
            const cv::Vec4b pixel = image.ptr<cv::Vec4b>()[i];
            for (size_t c = 0; c < 3; ++c)
                data[i * 3 + c] = static_cast<uint8_t>(
                    (pixel[static_cast<int>(c)] * pixel[3] + 255 * (255 - pixel[3]) + 127) / 255);
        }
        image = image.reshape(1, 1).colRange(0, static_cast<int>(count * 3)).reshape(3, rows);
    } else if (image.channels() == 1) {
        cv::Mat color;
        cv::cvtColor(image, color, cv::COLOR_GRAY2BGR);
        image = std::move(color);
    }
    require(image.type() == CV_8UC3, DS_UNSUPPORTED_FORMAT);
    orient(image, orientation(source));
    return image;
}
Quad full_frame(cv::Size size) {
    return {{{0, 0},
             {double(size.width), 0},
             {double(size.width), double(size.height)},
             {0, double(size.height)}}};
}
} // namespace
Page process(Engine &engine, ds_bytes source, const ds_page_options &options, const std::atomic<bool> &cancel,
             RasterBackend backend, ds_opencv_preset preset) {
    check_cancel(cancel);
    require(source.size <= engine.config.max_input_bytes && source.size <= INT_MAX, DS_LIMIT_EXCEEDED);
    auto started = Clock::now();
    const auto dimensions = header_size(source);
    const uint64_t pixels = uint64_t(dimensions.width) * dimensions.height;
    require(pixels <= engine.config.max_input_pixels, DS_LIMIT_EXCEEDED);
    const uint64_t decode_bytes_per_pixel =
        source.size >= 26 && source.data[0] == 137 && source.data[24] == 16 ? 12ull
        : orientation(source) >= 5                                          ? 7ull
                                                                            : 4ull;
    require(pixels * decode_bytes_per_pixel + 8ull * 1024 * 1024 <= engine.config.working_memory_bytes,
            DS_LIMIT_EXCEEDED);
    cv::Mat image = decode(source, dimensions);
    check_cancel(cancel);
    Page page;
    auto &info = page.info;
    info.struct_size = sizeof(info);
    info.abi_version = DS_ABI_VERSION;
    info.source_width = image.cols;
    info.source_height = image.rows;
    info.decode_ms = elapsed(started);
    Quad corners = full_frame(image.size());
    started = Clock::now();
    if (options.crop_mode == DS_CROP_AUTO) {
        auto detected = detect(engine, image, cancel);
        info.confidence = detected.confidence;
        if (detected.found) {
            try {
                output_size(detected.corners, image.size(), options.maximum_output_side);
                double area = 0;
                for (size_t i = 0; i < 4; ++i)
                    area += detected.corners[i].cross(detected.corners[(i + 1) % 4]);
                if (area >= pixels * .04) {
                    corners = detected.corners;
                    info.document_detected = 1;
                }
            } catch (const Failure &) {
            }
        }
        if (!info.document_detected)
            info.warnings |= DS_WARN_NO_DOCUMENT;
    } else if (options.crop_mode == DS_CROP_MANUAL) {
        for (size_t i = 0; i < 4; ++i) {
            require(std::isfinite(options.corners[2 * i]) && std::isfinite(options.corners[2 * i + 1]) &&
                    options.corners[2 * i] >= 0 && options.corners[2 * i] <= 1 &&
                    options.corners[2 * i + 1] >= 0 && options.corners[2 * i + 1] <= 1);
            corners[i] = {options.corners[2 * i] * image.cols, options.corners[2 * i + 1] * image.rows};
        }
        output_size(corners, image.size(), options.maximum_output_side);
        info.document_detected = 1;
        info.confidence = 1;
    }
    info.detect_ms = elapsed(started);
    for (size_t i = 0; i < 4; ++i) {
        info.corners[2 * i] = corners[i].x / image.cols;
        info.corners[2 * i + 1] = corners[i].y / image.rows;
    }
    const auto output_dimensions = output_size(corners, image.size(), options.maximum_output_side);
    const uint64_t output_pixels = uint64_t(output_dimensions.width) * output_dimensions.height;
    require(std::max(pixels * 4 + output_pixels * 3 + 8ull * 1024 * 1024,
                     output_pixels * (backend == RasterBackend::opencv ? 20 : 8) + 8ull * 1024 * 1024) <=
                engine.config.working_memory_bytes,
            DS_LIMIT_EXCEEDED);
    Plan plan;
    started = Clock::now();
    if (backend == RasterBackend::compatible && options.filter != DS_FILTER_ORIGINAL &&
        options.filter != DS_FILTER_ENHANCED_COLOR && options.filter != DS_FILTER_SHADOW_REMOVAL) {
        cv::Mat sample = warp(image, corners, options.analysis_side, cancel);
        plan = analyze(engine, sample, cancel);
        info.warnings |= plan.warnings;
    }
    info.analyze_ms = elapsed(started);
    started = Clock::now();
    auto final = backend == RasterBackend::opencv
                     ? warp_opencv(image, corners, options.maximum_output_side, cancel)
                     : warp(image, corners, options.maximum_output_side, cancel);
    image.release();
    info.warp_ms = elapsed(started);
    if (backend == RasterBackend::compatible && options.filter == DS_FILTER_ENHANCED_COLOR) {
        started = Clock::now();
        plan.quality = measure(final);
        info.analyze_ms += elapsed(started);
    }
    started = Clock::now();
    if (backend == RasterBackend::compatible && options.filter == DS_FILTER_SHADOW_REMOVAL) {
        correct_shadow(engine, final, cancel);
        plan.quality = measure(final);
    }
    if (backend == RasterBackend::opencv) {
        if (options.filter == DS_FILTER_ENHANCED_COLOR)
            enhance_opencv(final, preset, cancel);
    } else if (options.filter == DS_FILTER_ENHANCED_COLOR) {
        const auto sample = shadow_sample(final, cancel);
        auto adaptive = enhancement_plan(sample, nullptr, plan.quality.periodic);
        if (adaptive.needs_model) {
            try {
                require(final.total() * 3 + 64ull * 1024 * 1024 <= engine.config.working_memory_bytes,
                        DS_LIMIT_EXCEEDED);
                const auto field = predict_shadow(engine, sample, cancel);
                adaptive = enhancement_plan(sample, &field, plan.quality.periodic);
            } catch (const Failure &e) {
                if (e.status == DS_CANCELLED)
                    throw;
                info.warnings |= DS_WARN_SHADOW_UNAVAILABLE;
            } catch (const Ort::Exception &) {
                info.warnings |= DS_WARN_SHADOW_UNAVAILABLE;
            }
        }
        apply_enhancement(final, adaptive, cancel);
    } else
        enhance(final, options.filter, plan, cancel);
    if (options.rotation) {
        const int rotation = options.rotation == 90    ? cv::ROTATE_90_CLOCKWISE
                             : options.rotation == 180 ? cv::ROTATE_180
                                                       : cv::ROTATE_90_COUNTERCLOCKWISE;
        cv::rotate(final, final, rotation);
    }
    info.filter_ms = elapsed(started);
    check_cancel(cancel);
    started = Clock::now();
    const std::vector<int> parameters = {cv::IMWRITE_JPEG_QUALITY, static_cast<int>(options.jpeg_quality),
                                         cv::IMWRITE_JPEG_SAMPLING_FACTOR,
                                         cv::IMWRITE_JPEG_SAMPLING_FACTOR_444};
    require(cv::imencode(".jpg", final, page.jpeg, parameters), DS_PROCESSING_FAILED);
    info.encode_ms = elapsed(started);
    info.width = final.cols;
    info.height = final.rows;
    check_cancel(cancel);
    return page;
}
} // namespace docscan
