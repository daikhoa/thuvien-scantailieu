#pragma once
#include "pixels.hpp"
namespace docscan {
cv::Mat warp_opencv(const cv::Mat &, const Quad &, uint32_t, const std::atomic<bool> &);
void enhance_opencv(cv::Mat &, ds_opencv_preset, const std::atomic<bool> &);
} // namespace docscan
