#pragma once
#include <array>
#include <atomic>
#include <chrono>
#include <docscan/docscan.h>
#include <opencv2/core.hpp>
#include <stdexcept>
#include <vector>
namespace docscan {
using Clock = std::chrono::steady_clock;
inline double elapsed(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
struct Failure : std::exception {
    ds_status status;
    explicit Failure(ds_status s) : status(s) {}
};
inline void require(bool condition, ds_status status = DS_INVALID_ARGUMENT) {
    if (!condition)
        throw Failure(status);
}
inline void check_cancel(const std::atomic<bool> &cancel) {
    if (cancel.load(std::memory_order_relaxed))
        throw Failure(DS_CANCELLED);
}
enum class RasterBackend { compatible, opencv };
using Quad = std::array<cv::Point2d, 4>;
struct Quality {
    double mean = 0, dark = 0, bright = 255, contrast = 0, edge = 0, illumination = 0, periodic = 0,
           highlight = 0;
    double background_dark = 0, background_bright = 255;
    bool color = false;
};
struct Plan {
    Quality quality;
    double shadow = 0, lift = 0, contrast = 0, sharpen = 0, smooth = 0;
    bool protect_color = false;
    uint32_t warnings = 0;
};
Quality measure(const cv::Mat &);
Plan make_plan(const std::array<double, 7> &, const Quality &);
cv::Rect warp_source_region(const Quad &, cv::Size, cv::Size, cv::Rect);
void warp_region(const cv::Mat &, cv::Point, cv::Size, const Quad &, cv::Rect, cv::Mat &,
                 const std::atomic<bool> &);
cv::Size output_size(const Quad &, cv::Size, uint32_t);
bool full_frame_copy(const Quad &, cv::Size source, cv::Size output);
cv::Mat warp(const cv::Mat &, const Quad &, uint32_t, const std::atomic<bool> &);
void enhance(cv::Mat &, int, const Plan &, const std::atomic<bool> &);
} // namespace docscan
