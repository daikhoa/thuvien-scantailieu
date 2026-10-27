#include "opencv-raster.hpp"
#include "paper-restoration.hpp"
#include <algorithm>
#include <cmath>
#include <opencv2/imgproc.hpp>
namespace docscan {
cv::Mat warp_opencv(const cv::Mat &source, const Quad &corners, uint32_t maximum,
                    const std::atomic<bool> &cancel) {
    check_cancel(cancel);
    require(!source.empty() && source.type() == CV_8UC3);
    const auto size = output_size(corners, source.size(), maximum);
    if (full_frame_copy(corners, source.size(), size)) {
        auto output = source.clone();
        check_cancel(cancel);
        return output;
    }
    cv::Point2f from[4], to[4] = {{-.5f, -.5f},
                                  {float(size.width) - .5f, -.5f},
                                  {float(size.width) - .5f, float(size.height) - .5f},
                                  {-.5f, float(size.height) - .5f}};
    // Public corners describe image edges; OpenCV coordinates describe pixel centers.
    for (size_t i = 0; i < 4; ++i)
        from[i] = {float(corners[i].x - .5), float(corners[i].y - .5)};
    const auto matrix = cv::getPerspectiveTransform(from, to);
    cv::Mat output;
    cv::warpPerspective(source, output, matrix, size, cv::INTER_LINEAR, cv::BORDER_REPLICATE);
    check_cancel(cancel);
    return output;
}
namespace {
int residual_noise(const cv::Mat &gray) {
    const double scale = std::min(1.0, 256.0 / std::max(gray.cols, gray.rows));
    cv::Mat sample, median, residual;
    // Nearest sampling retains source noise rather than hiding it through averaging.
    cv::resize(
        gray, sample,
        {std::max(1, int(std::lround(gray.cols * scale))), std::max(1, int(std::lround(gray.rows * scale)))},
        0, 0, cv::INTER_NEAREST);
    cv::medianBlur(sample, median, 3);
    cv::absdiff(sample, median, residual);
    const int bins = 256, channel = 0;
    const float range[] = {0, 256};
    const float *ranges[] = {range};
    cv::Mat histogram;
    cv::calcHist(&residual, 1, &channel, {}, histogram, 1, &bins, ranges);
    float seen = 0;
    for (int i = 0; i < bins; ++i) {
        seen += histogram.at<float>(i);
        if (seen >= residual.total() * .5)
            return i;
    }
    return 0;
}

void apply_luminance_delta(cv::Mat &image, const cv::Mat &light, const cv::Mat &target, double blend,
                           const std::atomic<bool> &cancel) {
    // One bounded RGB policy pass replaces split/merge and six full-image
    // intermediates. Filtering itself stays in OpenCV; channel differences
    // remain exact and new clipping is prohibited, including saturated logos.
    for (int y = 0; y < image.rows; ++y) {
        if ((y & 31) == 0)
            check_cancel(cancel);
        auto *pixels = image.ptr<cv::Vec3b>(y);
        const auto *before = light.ptr<uint8_t>(y), *after = target.ptr<uint8_t>(y);
        for (int x = 0; x < image.cols; ++x) {
            auto &pixel = pixels[x];
            const int minimum = std::min({pixel[0], pixel[1], pixel[2]});
            const int maximum = std::max({pixel[0], pixel[1], pixel[2]});
            const int delta = std::clamp(cvRound((int(after[x]) - before[x]) * blend),
                                         std::min(0, 1 - minimum), std::max(0, 254 - maximum));
            for (int c = 0; c < 3; ++c)
                pixel[c] = static_cast<uint8_t>(pixel[c] + delta);
        }
    }
}
} // namespace

void enhance_opencv(cv::Mat &image, ds_opencv_preset preset, const std::atomic<bool> &cancel) {
    check_cancel(cancel);
    require(!image.empty() && image.type() == CV_8UC3);
    require(preset >= DS_OPENCV_GENTLE && preset <= DS_OPENCV_TEXT);
    struct Settings {
        double clip, blend, detail;
    };
    constexpr Settings settings[] = {{1.4, .45, .25}, {2.0, .7, .45}, {2.8, .85, .6}};
    const auto parameters = settings[static_cast<size_t>(preset)];
    cv::Mat light;
    cv::cvtColor(image, light, cv::COLOR_BGR2GRAY);
    double low = 0, high = 0;
    cv::minMaxLoc(light, &low, &high);
    if (high - low < 8)
        return;
    const int noise = residual_noise(light);
    // Blank noisy paper has no reliable strokes to enhance.
    if (noise >= 3 && high - low <= 40)
        return;
    const auto quality = measure(image);
    const double noise_protection = 1 / (1 + noise * .3);
    const double color_protection = quality.color ? .45 : 1;
    const double periodic_protection = quality.periodic >= .25 ? .4 : 1;
    const double blend = parameters.blend * noise_protection * color_protection * periodic_protection;
    restore_paper(image, cancel);
    cv::cvtColor(image, light, cv::COLOR_BGR2GRAY);
    check_cancel(cancel);
    cv::Mat contrast;
    const int tiles_x = std::clamp((image.cols + 159) / 160, 2, 8);
    const int tiles_y = std::clamp((image.rows + 159) / 160, 2, 8);
    auto clahe = cv::createCLAHE(noise >= 2 ? 1.2 : parameters.clip,
                                 {std::min(tiles_x, image.cols), std::min(tiles_y, image.rows)});
    clahe->apply(light, contrast);
    check_cancel(cancel);
    if (noise < 2 && quality.periodic < .25) {
        cv::Mat blurred, detail;
        cv::GaussianBlur(contrast, blurred, {}, .85, .85, cv::BORDER_REPLICATE);
        cv::subtract(blurred, contrast, detail);
        blurred.release();
        // Ignore tiny residuals and cap dark detail; never add bright halos.
        cv::subtract(detail, 1, detail);
        cv::min(detail, 12, detail);
        detail.convertTo(detail, CV_8U, parameters.detail);
        cv::subtract(contrast, detail, contrast);
    }
    apply_luminance_delta(image, light, contrast, blend, cancel);
    check_cancel(cancel);
}

} // namespace docscan
