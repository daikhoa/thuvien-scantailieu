#pragma once
#include "pixels.hpp"
namespace docscan {
struct PaperField {
    int columns, rows;
    std::vector<double> background;
    std::vector<uint8_t> connected;
    bool has_narrow_shadow = false;
};
PaperField refine_paper_background(const cv::Mat &, const PaperField &, const std::vector<double> &,
                                   const std::atomic<bool> &);
} // namespace docscan
