#pragma once
#include "pixels.hpp"
namespace docscan {
inline constexpr double minimum_corner_support = 24;
struct CornerRefinement {
    Quad corners{};
    double support = 0;
};
// Bounded still-photo refinement. Input is BGR; output keeps source pixel axes.
CornerRefinement refine_document_corners(const cv::Mat &, const Quad &,
                                         const std::atomic<bool> &);
enum class CornerAction { reject = 0, accept = 1, verify = 2 };
CornerAction corner_action(double confidence, double support);
bool confirm_document_corners(const Quad &candidate, const Quad &confirmation, double confidence);
}
