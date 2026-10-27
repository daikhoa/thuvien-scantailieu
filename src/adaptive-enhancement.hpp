#pragma once
#include "pixels.hpp"
namespace docscan {
struct ShadowField {
    int width = 0, height = 0;
    std::vector<float> data;
};
struct EnhancementPlan {
    int columns = 0, rows = 0;
    std::vector<double> background, ratios, coverage, ink_support;
    bool needs_model = false, periodic = false;
    double base_gain = 1;
    ShadowField field;
};
ShadowField shadow_sample(const cv::Mat &, const std::atomic<bool> &);
EnhancementPlan enhancement_plan(const ShadowField &, const ShadowField * = nullptr, double periodic = 0);
void apply_shadow_illumination(cv::Mat &, const ShadowField &, const std::atomic<bool> &);
void apply_enhancement(cv::Mat &, const EnhancementPlan &, const std::atomic<bool> &);
} // namespace docscan
