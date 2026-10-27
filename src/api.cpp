#include "internal.hpp"
#include <algorithm>
#include <cstring>
#include <limits>
namespace {
template <class F> ds_status boundary(F &&function) noexcept {
    try {
        function();
        return DS_OK;
    } catch (const docscan::Failure &error) {
        return error.status;
    } catch (const std::bad_alloc &) {
        return DS_OUT_OF_MEMORY;
    } catch (...) {
        return DS_PROCESSING_FAILED;
    }
}
std::unique_lock<std::mutex> acquire(ds_document &document) {
    std::unique_lock<std::mutex> lock(document.mutex, std::try_to_lock);
    docscan::require(lock.owns_lock(), DS_BUSY);
    return lock;
}
ds_status add_image(ds_document *d, ds_bytes source, const ds_page_options *o, uint32_t *index,
                    docscan::RasterBackend backend, ds_opencv_preset preset) {
    if (index)
        *index = UINT32_MAX;
    return boundary([&] {
        docscan::require(d && o && index && source.data && source.size);
        docscan::require(
            o->struct_size == sizeof(*o) && o->abi_version == DS_ABI_VERSION &&
            o->filter >= DS_FILTER_ORIGINAL && o->filter <= DS_FILTER_SHADOW_REMOVAL &&
            o->crop_mode >= DS_CROP_AUTO && o->crop_mode <= DS_CROP_MANUAL && o->maximum_output_side >= 64 &&
            o->maximum_output_side <= 8192 &&
            (o->rotation == 0 || o->rotation == 90 || o->rotation == 180 || o->rotation == 270) &&
            o->jpeg_quality >= 80 && o->jpeg_quality <= 100 && o->analysis_side >= 224 &&
            o->analysis_side <= 1440);
        docscan::require(preset >= DS_OPENCV_GENTLE && preset <= DS_OPENCV_TEXT);
        if (backend == docscan::RasterBackend::opencv)
            docscan::require(o->filter == DS_FILTER_ORIGINAL || o->filter == DS_FILTER_ENHANCED_COLOR);
        auto lock = acquire(*d);
        docscan::check_cancel(d->cancelled);
        docscan::require(d->pages.size() < d->engine->config.max_pages, DS_LIMIT_EXCEEDED);
        auto page = std::make_unique<docscan::Page>(
            docscan::process(*d->engine, source, *o, d->cancelled, backend, preset));
        docscan::check_cancel(d->cancelled);
        docscan::require(page->jpeg.size() <= d->engine->config.max_document_bytes - d->encoded_bytes,
                         DS_LIMIT_EXCEEDED);
        const auto next_index = static_cast<uint32_t>(d->pages.size());
        const auto size = page->jpeg.size();
        d->pages.push_back(std::move(page));
        d->encoded_bytes += size;
        *index = next_index;
    });
}
} // namespace
extern "C" {
uint32_t ds_abi_version(void) {
    return DS_ABI_VERSION;
}
const char *ds_version(void) {
    return "docscan/0.1.0";
}
const char *ds_status_message(ds_status s) {
    static const char *messages[] = {"Success",
                                     "Invalid argument or ABI version",
                                     "Unsupported image format",
                                     "Resource limit exceeded",
                                     "Image decode failed",
                                     "Required model or runtime unavailable",
                                     "Operation cancelled",
                                     "Processing failed",
                                     "Allocation failed",
                                     "Document is busy"};
    return s >= DS_OK && s <= DS_BUSY ? messages[s] : "Unknown status";
}
void ds_engine_config_init(ds_engine_config *c) {
    if (!c)
        return;
    std::memset(c, 0, sizeof(*c));
    c->struct_size = sizeof(*c);
    c->abi_version = DS_ABI_VERSION;
    c->max_input_bytes = 128ull * 1024 * 1024;
    c->max_input_pixels = 64000000;
    c->working_memory_bytes = 512ull * 1024 * 1024;
    c->max_document_bytes = 128ull * 1024 * 1024;
    c->max_pages = 100;
}
void ds_page_options_init(ds_page_options *o) {
    if (!o)
        return;
    std::memset(o, 0, sizeof(*o));
    o->struct_size = sizeof(*o);
    o->abi_version = DS_ABI_VERSION;
    o->filter = DS_FILTER_ENHANCED_COLOR;
    o->crop_mode = DS_CROP_AUTO;
    o->maximum_output_side = 3000;
    o->jpeg_quality = 96;
    o->analysis_side = 720;
}
ds_status ds_engine_create(const ds_engine_config *c, ds_engine **output) {
    if (output)
        *output = nullptr;
    return boundary([&] {
        docscan::require(c && output);
        docscan::require(c->struct_size == sizeof(*c) && c->abi_version == DS_ABI_VERSION &&
                         c->reserved == 0);
        docscan::require(c->max_input_bytes > 0 && c->max_input_bytes <= 1024ull * 1024 * 1024 &&
                         c->max_input_pixels > 0 && c->max_input_pixels <= 256000000 &&
                         c->working_memory_bytes >= 1024 * 1024 &&
                         c->working_memory_bytes <= 16ull * 1024 * 1024 * 1024 && c->max_document_bytes > 0 &&
                         c->max_document_bytes <= 1024ull * 1024 * 1024 && c->max_pages > 0 &&
                         c->max_pages <= 10000);
        docscan::initialize_runtime();
        auto result = std::make_unique<ds_engine>();
        result->value = std::make_shared<docscan::Engine>(*c);
        *output = result.release();
    });
}
uint32_t ds_engine_capabilities(const ds_engine *e) {
    if (!e)
        return 0;
    return DS_CAP_JPEG | DS_CAP_PNG | DS_CAP_WEBP | (e->value->corner ? DS_CAP_CORNER_MODEL : 0) |
           (e->value->defect ? DS_CAP_DEFECT_MODEL : 0) |
           (!e->value->shadow_path.empty() ? DS_CAP_SHADOW_MODEL : 0);
}
void ds_engine_destroy(ds_engine *e) {
    delete e;
}
ds_status ds_document_create(ds_engine *e, ds_document **output) {
    if (output)
        *output = nullptr;
    return boundary([&] {
        docscan::require(e && output);
        auto result = std::make_unique<ds_document>();
        result->engine = e->value;
        *output = result.release();
    });
}
void ds_document_destroy(ds_document *d) {
    delete d;
}
void ds_document_cancel(ds_document *d) {
    if (d)
        d->cancelled.store(true, std::memory_order_relaxed);
}
ds_status ds_document_reset_cancel(ds_document *d) {
    return boundary([&] {
        docscan::require(d);
        auto lock = acquire(*d);
        d->cancelled.store(false, std::memory_order_relaxed);
    });
}
ds_status ds_document_add_image(ds_document *d, ds_bytes source, const ds_page_options *o, uint32_t *index) {
    return add_image(d, source, o, index, docscan::RasterBackend::compatible, DS_OPENCV_BALANCED);
}
ds_status ds_document_add_image_opencv(ds_document *d, ds_bytes source, const ds_page_options *o,
                                       ds_opencv_preset preset, uint32_t *index) {
    return add_image(d, source, o, index, docscan::RasterBackend::opencv, preset);
}
uint32_t ds_document_page_count(const ds_document *d) {
    if (!d)
        return 0;
    std::lock_guard<std::mutex> lock(d->mutex);
    return static_cast<uint32_t>(d->pages.size());
}
ds_status ds_document_get_page(const ds_document *d, uint32_t index, const ds_page_info **info,
                               ds_bytes *bytes) {
    if (info)
        *info = nullptr;
    if (bytes)
        *bytes = {nullptr, 0};
    return boundary([&] {
        docscan::require(d && info && bytes);
        std::lock_guard<std::mutex> lock(d->mutex);
        docscan::require(index < d->pages.size());
        const auto &page = *d->pages[index];
        *info = &page.info;
        *bytes = {page.jpeg.data(), static_cast<uint64_t>(page.jpeg.size())};
    });
}
ds_status ds_document_pdf(ds_document *d, ds_buffer **output) {
    if (output)
        *output = nullptr;
    return boundary([&] {
        docscan::require(d && output);
        auto lock = acquire(*d);
        docscan::check_cancel(d->cancelled);
        docscan::require(!d->pages.empty());
        auto result = std::make_unique<ds_buffer>();
        result->value = docscan::make_pdf(d->pages, d->cancelled, d->engine->config.max_document_bytes);
        *output = result.release();
    });
}
ds_status ds_buffer_bytes(const ds_buffer *b, ds_bytes *output) {
    if (output)
        *output = {nullptr, 0};
    return boundary([&] {
        docscan::require(b && output);
        *output = {b->value.data(), static_cast<uint64_t>(b->value.size())};
    });
}
void ds_buffer_destroy(ds_buffer *b) {
    delete b;
}
}
