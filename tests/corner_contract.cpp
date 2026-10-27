#include "corner-refinement.hpp"
#include <cmath>
#include <iostream>
#include <opencv2/imgproc.hpp>

int main() {
    using namespace docscan;
    std::atomic<bool> cancel{false};
    cv::Mat image(768, 576, CV_8UC3, cv::Scalar(35, 30, 25));
    cv::rectangle(image, {185, 310}, {365, 540}, cv::Scalar(160, 210, 185), -1);
    // One confused corner extends into the background, as in a distant document.
    Quad rough{{{185, 310}, {365, 310}, {550, 370}, {185, 540}}};
    const auto result = refine_document_corners(image, rough, cancel);
    Quad expected{{{185, 310}, {365, 310}, {365, 540}, {185, 540}}};
    if (result.support < 30) return 1;
    for (size_t i = 0; i < 4; ++i)
        if (cv::norm(result.corners[i] - expected[i]) > 6) return 2;
    cv::Mat blank(768, 576, CV_8UC3, cv::Scalar(110, 110, 110));
    const auto none = refine_document_corners(blank, expected, cancel);
    if (none.support != 0 || none.corners != expected) return 3;
    if (corner_action(.49, 60) != CornerAction::verify ||
        corner_action(.5, 0) != CornerAction::accept ||
        corner_action(.1, 23) != CornerAction::reject) return 6;
    if (!confirm_document_corners(expected, expected, .9) ||
        confirm_document_corners(expected, expected, .64)) return 7;
    auto wrong = expected;
    for (auto &p : wrong) p.x += 150;
    if (confirm_document_corners(expected, wrong, .99)) return 8;
    cancel = true;
    try {
        refine_document_corners(image, rough, cancel);
        return 4;
    } catch (const Failure &error) {
        if (error.status != DS_CANCELLED) return 5;
    }
    std::cout << "corner refinement: outlier recovery, blank input and cancellation passed\n";
}
