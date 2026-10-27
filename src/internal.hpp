#pragma once
#include "adaptive-enhancement.hpp"
#include "pixels.hpp"
#include <array>
#include <atomic>
#include <chrono>
#include <docscan/docscan.h>
#include <memory>
#include <mutex>
#include <onnxruntime_cxx_api.h>
#include <opencv2/core.hpp>
#include <stdexcept>
#include <string>
#include <vector>
namespace docscan {
void initialize_runtime();
struct Engine {
    ds_engine_config config{};
    Ort::Env environment{ORT_LOGGING_LEVEL_FATAL, "docscan"};
    std::unique_ptr<Ort::Session> corner, defect, shadow;
    std::string shadow_path;
    std::mutex inference_mutex;
    explicit Engine(const ds_engine_config &config);
};
struct Page {
    ds_page_info info{};
    std::vector<uint8_t> jpeg;
};
struct Detection {
    Quad corners{};
    double confidence = 0;
    bool found = false;
};
Detection detect(Engine &, const cv::Mat &, const std::atomic<bool> &);
Plan analyze(Engine &, const cv::Mat &, const std::atomic<bool> &);
ShadowField predict_shadow(Engine &, const ShadowField &, const std::atomic<bool> &);
void correct_shadow(Engine &, cv::Mat &, const std::atomic<bool> &);
Page process(Engine &, ds_bytes, const ds_page_options &, const std::atomic<bool> &,
             RasterBackend = RasterBackend::compatible, ds_opencv_preset = DS_OPENCV_BALANCED);
std::vector<uint8_t> make_pdf(const std::vector<std::unique_ptr<Page>> &, const std::atomic<bool> &,
                              uint64_t);
} // namespace docscan
struct ds_engine {
    std::shared_ptr<docscan::Engine> value;
};
struct ds_document {
    std::shared_ptr<docscan::Engine> engine;
    std::vector<std::unique_ptr<docscan::Page>> pages;
    uint64_t encoded_bytes = 0;
    std::atomic<bool> cancelled{false};
    mutable std::mutex mutex;
};
struct ds_buffer {
    std::vector<uint8_t> value;
};
