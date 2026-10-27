#include "adaptive-enhancement.hpp"
#include "pixels.hpp"
#include "corner-refinement.hpp"
#include <algorithm>
#include <cstdint>
#include <opencv2/imgproc.hpp>

namespace {
cv::Mat output;
}

void release_production();
extern "C" void ds_wasm_release() {
    output.release();
    release_production();
}
extern "C" const uint8_t *ds_wasm_output() {
    return output.data;
}
extern "C" int ds_wasm_width() {
    return output.cols;
}
extern "C" int ds_wasm_height() {
    return output.rows;
}
// RGBA and clockwise corners use the same decoded image-edge axes as the web.
// This bridge deliberately excludes native decode, inference, JPEG and PDF.
int process_rgba(const uint8_t *rgba, int width, int height, const double *points, int filter,
                 uint8_t *owned_rgba = nullptr) {
    output.release();
    try {
        docscan::require(rgba && points && width > 0 && height > 0 && width <= 16384 && height <= 16384);
        docscan::require(uint64_t(width) * height <= 50000000, DS_LIMIT_EXCEEDED);
        docscan::require(filter == DS_FILTER_ORIGINAL || filter == DS_FILTER_ENHANCED_COLOR);
        docscan::Quad quad;
        for (size_t i = 0; i < 4; ++i)
            quad[i] = {points[2 * i], points[2 * i + 1]};
        docscan::output_size(quad, {width, height}, 3000);
        std::atomic<bool> cancel{false};
        // The browser transfers an expendable staging buffer. Compact RGBA into
        // BGR in that same allocation; each pixel is read before writing behind it.
        // Legacy exports keep their read-only input contract via a separate Mat.
        cv::Mat source =
            owned_rgba ? cv::Mat(height, width, CV_8UC3, owned_rgba) : cv::Mat(height, width, CV_8UC3);
        for (int y = 0; y < height; ++y) {
            auto *row = source.ptr<cv::Vec3b>(y);
            for (int x = 0; x < width; ++x) {
                const auto *p = rgba + (size_t(y) * width + x) * 4;
                const auto blue = p[2], green = p[1], red = p[0];
                row[x] = cv::Vec3b(blue, green, red); // Already composited on white.
            }
        }
        auto image = docscan::warp(source, quad, 3000, cancel);
        source.release();
        docscan::Plan plan;
        if (filter == DS_FILTER_ENHANCED_COLOR)
            plan.quality = docscan::measure(image);
        docscan::enhance(image, filter, plan, cancel);
        cv::cvtColor(image, output, cv::COLOR_BGR2RGBA);
        return DS_OK;
    } catch (const docscan::Failure &e) {
        return e.status;
    } catch (const std::bad_alloc &) {
        return DS_OUT_OF_MEMORY;
    } catch (const cv::Exception &e) {
        return e.code == cv::Error::StsNoMem ? DS_OUT_OF_MEMORY : DS_PROCESSING_FAILED;
    } catch (...) {
        return DS_PROCESSING_FAILED;
    }
}

extern "C" int ds_wasm_process(const uint8_t *rgba, int w, int h, const double *points, int filter) {
    return process_rgba(rgba, w, h, points, filter);
}
// Private browser ABI: staging pixels are consumed; callers refill before reuse.
extern "C" int ds_wasm_process_owned(uint8_t *rgba, int w, int h, const double *points, int filter) {
    return process_rgba(rgba, w, h, points, filter, rgba);
}

// Private v8 bridge: shared ORT predicts only the bounded illumination tensor;
// native C++ owns sample analysis, color protection and final pixel processing.
extern "C" int ds_wasm_enhance_owned(uint8_t *rgba, int width, int height, const float *field, int fw,
                                     int fh) {
    output.release();
    try {
        docscan::require(rgba && width > 0 && height > 0 && width <= 3000 && height <= 3000);
        docscan::require((!field && fw == 0 && fh == 0) ||
                         (field && fw > 0 && fh > 0 && fw <= 384 && fh <= 384));
        std::atomic<bool> cancel{false};
        cv::Mat image(height, width, CV_8UC3, rgba);
        for (int y = 0; y < height; ++y)
            for (int x = 0; x < width; ++x) {
                const auto *p = rgba + (size_t(y) * width + x) * 4;
                const auto b = p[2], g = p[1], r = p[0];
                image.at<cv::Vec3b>(y, x) = {b, g, r};
            }
        const auto sample = docscan::shadow_sample(image, cancel);
        docscan::ShadowField prediction;
        if (field)
            prediction = {fw, fh, std::vector<float>(field, field + size_t(fw) * fh * 3)};
        const auto plan = docscan::enhancement_plan(sample, field ? &prediction : nullptr,
                                                    docscan::measure(image).periodic);
        docscan::apply_enhancement(image, plan, cancel);
        cv::cvtColor(image, output, cv::COLOR_BGR2RGBA);
        return DS_OK;
    } catch (const docscan::Failure &e) {
        return e.status;
    } catch (const std::bad_alloc &) {
        return DS_OUT_OF_MEMORY;
    } catch (const cv::Exception &e) {
        return e.code == cv::Error::StsNoMem ? DS_OUT_OF_MEMORY : DS_PROCESSING_FAILED;
    } catch (...) {
        return DS_PROCESSING_FAILED;
    }
}

// Private v9 ABI. One page per realm; the JS adapter only reads/encodes browser pixels.
namespace {
cv::Mat production_image;
docscan::Quad production_quad;
cv::Size production_source;
std::vector<std::pair<cv::Rect, cv::Rect>> patches;
size_t next_patch = 0;
int prepared_filter = -1;
std::array<int, 4> patch_info;
docscan::ShadowField production_sample;
docscan::EnhancementPlan production_enhancement;
docscan::Plan production_plan;
std::atomic<bool> production_cancel{false};

void add_patch(cv::Rect region) {
    auto source =
        docscan::warp_source_region(production_quad, production_source, production_image.size(), region);
    if (source.area() <= 1024 * 1024 && source.width <= 4096 && source.height <= 4096) {
        patches.emplace_back(region, source);
        return;
    }
    if (region.width >= region.height && region.width > 1) {
        const int half = region.width / 2;
        add_patch({region.x, region.y, half, region.height});
        add_patch({region.x + half, region.y, region.width - half, region.height});
    } else {
        docscan::require(region.height > 1);
        const int half = region.height / 2;
        add_patch({region.x, region.y, region.width, half});
        add_patch({region.x, region.y + half, region.width, region.height - half});
    }
}
template <typename Job> int production_call(Job job) {
    try {
        job();
        return DS_OK;
    } catch (const docscan::Failure &e) {
        ds_wasm_release();
        return e.status;
    } catch (const std::bad_alloc &) {
        ds_wasm_release();
        return DS_OUT_OF_MEMORY;
    } catch (const cv::Exception &e) {
        ds_wasm_release();
        return e.code == cv::Error::StsNoMem ? DS_OUT_OF_MEMORY : DS_PROCESSING_FAILED;
    } catch (...) {
        ds_wasm_release();
        return DS_PROCESSING_FAILED;
    }
}
} // namespace
void release_production() {
    production_image.release();
    patches.clear();
    production_sample = {};
    production_enhancement = {};
    production_plan = {};
    next_patch = 0;
    prepared_filter = -1;
}
extern "C" int ds_wasm_begin(const double *points, int width, int height, int maximum) {
    ds_wasm_release();
    return production_call([&] {
        docscan::require(points && width > 0 && height > 0 && width <= 16384 && height <= 16384 &&
                         uint64_t(width) * height <= 50000000 && maximum > 0 && maximum <= 3000);
        for (size_t i = 0; i < 4; ++i)
            production_quad[i] = {points[i * 2], points[i * 2 + 1]};
        production_source = {width, height};
        const auto size = docscan::output_size(production_quad, production_source, maximum);
        production_image.create(size, CV_8UC3);
        for (int y = 0; y < size.height; y += 256)
            for (int x = 0; x < size.width; x += 256)
                add_patch({x, y, std::min(256, size.width - x), std::min(256, size.height - y)});
    });
}
extern "C" int ds_wasm_patch_count() {
    return int(patches.size());
}
extern "C" const int *ds_wasm_patch(int index) {
    if (index < 0 || size_t(index) >= patches.size())
        return nullptr;
    const auto region = patches[index].second;
    patch_info = {region.x, region.y, region.width, region.height};
    return patch_info.data();
}
extern "C" int ds_wasm_write_patch(uint8_t *rgba, int index) {
    return production_call([&] {
        docscan::require(rgba && index >= 0 && size_t(index) == next_patch && next_patch < patches.size() &&
                         prepared_filter == -1);
        const auto [region, source] = patches[next_patch];
        // Read each RGBA pixel before compacting behind it. Composite transparency on white.
        cv::Mat patch(source.height, source.width, CV_8UC3, rgba);
        for (size_t i = 0; i < patch.total(); ++i) {
            const auto *p = rgba + i * 4;
            const uint32_t a = p[3], b = p[2], g = p[1], r = p[0];
            patch.ptr<cv::Vec3b>()[i] = {uint8_t((b * a + 255 * (255 - a) + 127) / 255),
                                         uint8_t((g * a + 255 * (255 - a) + 127) / 255),
                                         uint8_t((r * a + 255 * (255 - a) + 127) / 255)};
        }
        docscan::warp_region(patch, source.tl(), production_source, production_quad, region, production_image,
                             production_cancel);
        ++next_patch;
    });
}
extern "C" int ds_wasm_prepare(int filter, const double *appearance) {
    return production_call([&] {
        docscan::require(!production_image.empty() && next_patch == patches.size() && prepared_filter == -1 &&
                         filter >= 0 && filter <= 5);
        if (filter != DS_FILTER_ORIGINAL) {
            std::array<double, 7> scores{};
            if (appearance) {
                for (size_t i = 0; i < scores.size(); ++i) {
                    docscan::require(std::isfinite(appearance[i]) && appearance[i] >= 0 &&
                                     appearance[i] <= 1);
                    scores[i] = appearance[i];
                }
            }
            production_plan = docscan::make_plan(scores, docscan::measure(production_image));
        }
        if (filter == DS_FILTER_ENHANCED_COLOR || filter == DS_FILTER_SHADOW_REMOVAL) {
            production_sample = docscan::shadow_sample(production_image, production_cancel);
            production_enhancement =
                docscan::enhancement_plan(production_sample, nullptr, production_plan.quality.periodic);
        }
        prepared_filter = filter;
    });
}
extern "C" int ds_wasm_needs_model() {
    return prepared_filter == DS_FILTER_SHADOW_REMOVAL || production_enhancement.needs_model;
}
extern "C" const float *ds_wasm_sample() {
    return production_sample.data.data();
}
extern "C" int ds_wasm_sample_width() {
    return production_sample.width;
}
extern "C" int ds_wasm_sample_height() {
    return production_sample.height;
}
extern "C" int ds_wasm_finish(int filter, int rotation, const float *field, int fw, int fh) {
    return production_call([&] {
        docscan::require(!production_image.empty() && prepared_filter == filter &&
                         (rotation == 0 || rotation == 90 || rotation == 180 || rotation == 270));
        docscan::ShadowField prediction;
        if (field) {
            docscan::require(fw == production_sample.width && fh == production_sample.height && fw > 0 &&
                             fh > 0 && fw <= 384 && fh <= 384);
            prediction = {fw, fh, std::vector<float>(field, field + size_t(fw) * fh * 3)};
        } else
            docscan::require(fw == 0 && fh == 0);
        if (filter == DS_FILTER_ENHANCED_COLOR) {
            if (field)
                production_enhancement = docscan::enhancement_plan(production_sample, &prediction,
                                                                   production_plan.quality.periodic);
            docscan::apply_enhancement(production_image, production_enhancement, production_cancel);
        } else {
            if (filter == DS_FILTER_SHADOW_REMOVAL) {
                docscan::require(field, DS_MODEL_UNAVAILABLE);
                docscan::apply_shadow_illumination(production_image, prediction, production_cancel);
                production_plan.quality = docscan::measure(production_image);
            }
            docscan::enhance(production_image, filter, production_plan, production_cancel);
        }
        if (rotation != 0)
            cv::rotate(production_image, production_image,
                       rotation == 90    ? cv::ROTATE_90_CLOCKWISE
                       : rotation == 180 ? cv::ROTATE_180
                                         : cv::ROTATE_90_COUNTERCLOCKWISE);
        cv::cvtColor(production_image, output, cv::COLOR_BGR2RGBA);
        release_production();
    });
}

// Still-photo corner support is shared with the native DLL; no ONNX session lives here.
extern "C" int ds_wasm_refine_corners(const uint8_t *rgba, int width, int height,
                                      double *points, double confidence) {
    try {
        docscan::require(rgba && points && width > 0 && height > 0 && width <= 960 && height <= 960);
        cv::Mat image;
        cv::cvtColor(cv::Mat(height, width, CV_8UC4, const_cast<uint8_t *>(rgba)), image, cv::COLOR_RGBA2BGR);
        docscan::Quad rough;
        for (size_t i = 0; i < 4; ++i) rough[i] = {points[i * 2], points[i * 2 + 1]};
        std::atomic<bool> cancel{false};
        const auto result = docscan::refine_document_corners(image, rough, cancel);
        const auto &chosen = result.support >= docscan::minimum_corner_support ? result.corners : rough;
        for (size_t i = 0; i < 4; ++i) { points[i * 2] = chosen[i].x; points[i * 2 + 1] = chosen[i].y; }
        points[8] = result.support;
        points[9] = int(docscan::corner_action(confidence, result.support));
        return DS_OK;
    } catch (const docscan::Failure &e) { return e.status; }
      catch (const std::bad_alloc &) { return DS_OUT_OF_MEMORY; }
      catch (const cv::Exception &e) { return e.code == cv::Error::StsNoMem ? DS_OUT_OF_MEMORY : DS_PROCESSING_FAILED; }
      catch (...) { return DS_PROCESSING_FAILED; }
}
extern "C" int ds_wasm_confirm_corners(const double *candidate, const double *confirmation,
                                       double confidence) {
    if (!candidate || !confirmation) return 0;
    try {
        docscan::Quad a, b;
        for (size_t i = 0; i < 4; ++i) {
            a[i] = {candidate[2 * i], candidate[2 * i + 1]};
            b[i] = {confirmation[2 * i], confirmation[2 * i + 1]};
        }
        return docscan::confirm_document_corners(a, b, confidence) ? 1 : 0;
    } catch (...) { return 0; }
}
