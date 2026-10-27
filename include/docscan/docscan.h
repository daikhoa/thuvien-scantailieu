#ifndef DOCSCAN_DOCSCAN_H
#define DOCSCAN_DOCSCAN_H
#include <stdint.h>
#if defined(_WIN32) && defined(DOCSCAN_SHARED)
#ifdef DOCSCAN_BUILD
#define DS_API __declspec(dllexport)
#else
#define DS_API __declspec(dllimport)
#endif
#elif defined(__GNUC__)
#define DS_API __attribute__((visibility("default")))
#else
#define DS_API
#endif
#ifdef __cplusplus
extern "C" {
#endif
#define DS_ABI_VERSION 1u

typedef struct ds_engine ds_engine;
typedef struct ds_document ds_document;
typedef struct ds_buffer ds_buffer;
typedef enum ds_status {
    DS_OK = 0,
    DS_INVALID_ARGUMENT = 1,
    DS_UNSUPPORTED_FORMAT = 2,
    DS_LIMIT_EXCEEDED = 3,
    DS_DECODE_FAILED = 4,
    DS_MODEL_UNAVAILABLE = 5,
    DS_CANCELLED = 6,
    DS_PROCESSING_FAILED = 7,
    DS_OUT_OF_MEMORY = 8,
    DS_BUSY = 9
} ds_status;
typedef enum ds_filter {
    DS_FILTER_ORIGINAL = 0,
    DS_FILTER_AUTO = 1,
    DS_FILTER_ENHANCED_COLOR = 2,
    DS_FILTER_GRAYSCALE = 3,
    DS_FILTER_BLACK_WHITE = 4,
    DS_FILTER_SHADOW_REMOVAL = 5 /* Optional GCNet illumination model; lazy, no training. */
} ds_filter;
typedef enum ds_opencv_preset {
    DS_OPENCV_GENTLE = 0,
    DS_OPENCV_BALANCED = 1,
    DS_OPENCV_TEXT = 2
} ds_opencv_preset;

typedef enum ds_crop_mode { DS_CROP_AUTO = 0, DS_CROP_FULL_FRAME = 1, DS_CROP_MANUAL = 2 } ds_crop_mode;
enum {
    DS_WARN_NO_DOCUMENT = 1u,
    DS_WARN_RETAKE_BLUR = 2u,
    DS_WARN_RETAKE_FINGER = 4u,
    DS_WARN_RETAKE_CURVED = 8u,
    DS_WARN_MOIRE = 16u,
    DS_WARN_CLASSIFIER_UNAVAILABLE = 32u,
    DS_WARN_SHADOW_UNAVAILABLE = 64u
};
enum {
    DS_CAP_JPEG = 1u,
    DS_CAP_PNG = 2u,
    DS_CAP_WEBP = 4u,
    DS_CAP_CORNER_MODEL = 8u,
    DS_CAP_DEFECT_MODEL = 16u,
    DS_CAP_SHADOW_MODEL = 32u
};
typedef struct ds_bytes {
    const uint8_t *data;
    uint64_t size;
} ds_bytes;
typedef struct ds_engine_config {
    uint32_t struct_size, abi_version;
    const char *model_directory; /* UTF-8; NULL explicitly creates an engine without ML. */
    uint64_t max_input_bytes, max_input_pixels, working_memory_bytes, max_document_bytes;
    uint32_t max_pages, reserved;
} ds_engine_config;
typedef struct ds_page_options {
    uint32_t struct_size, abi_version;
    int32_t filter, crop_mode;
    uint32_t maximum_output_side, rotation, jpeg_quality, analysis_side;
    double corners[8]; /* Manual: TL,TR,BR,BL, normalized source edges in [0,1]. */
} ds_page_options;
typedef struct ds_page_info {
    uint32_t struct_size, abi_version;
    uint32_t source_width, source_height, width, height, warnings, document_detected;
    double confidence, corners[8];
    double decode_ms, detect_ms, analyze_ms, warp_ms, filter_ms, encode_ms;
} ds_page_info;
DS_API uint32_t ds_abi_version(void);
DS_API const char *ds_version(void);
DS_API const char *ds_status_message(ds_status status);
DS_API void ds_engine_config_init(ds_engine_config *config);
DS_API void ds_page_options_init(ds_page_options *options);
DS_API ds_status ds_engine_create(const ds_engine_config *config, ds_engine **output);
DS_API uint32_t ds_engine_capabilities(const ds_engine *engine);
DS_API void ds_engine_destroy(ds_engine *engine);
DS_API ds_status ds_document_create(ds_engine *engine, ds_document **output);
DS_API void ds_document_destroy(ds_document *document);
/* Mutating document calls are synchronous and must not overlap. Cancel is thread-safe. */
DS_API void ds_document_cancel(ds_document *document);
DS_API ds_status ds_document_reset_cancel(ds_document *document);
DS_API ds_status ds_document_add_image(ds_document *document, ds_bytes source, const ds_page_options *options,
                                       uint32_t *page_index);
/* Opt-in OpenCV raster: only ORIGINAL/ENHANCED_COLOR; existing API/defaults unchanged. */
DS_API ds_status ds_document_add_image_opencv(ds_document *document, ds_bytes source,
                                              const ds_page_options *options, ds_opencv_preset preset,
                                              uint32_t *page_index);
DS_API uint32_t ds_document_page_count(const ds_document *document);
/* Borrowed output remains valid until document destruction. Never free with caller allocator. */
DS_API ds_status ds_document_get_page(const ds_document *document, uint32_t index, const ds_page_info **info,
                                      ds_bytes *jpeg);
/* Output owns its storage independently of document lifetime. */
DS_API ds_status ds_document_pdf(ds_document *document, ds_buffer **output);
DS_API ds_status ds_buffer_bytes(const ds_buffer *buffer, ds_bytes *output);
DS_API void ds_buffer_destroy(ds_buffer *buffer);
#ifdef __cplusplus
}
#endif
#endif
