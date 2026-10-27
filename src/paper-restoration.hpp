#pragma once
#include "pixels.hpp"
namespace docscan {
// Conservative, bounded paper/ink evidence. No geometry or output-size changes.
void restore_paper(cv::Mat &, const std::atomic<bool> &);
} // namespace docscan
