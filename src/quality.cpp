#include "pixels.hpp"
#include <algorithm>
#include <cmath>
namespace docscan {
namespace {
double luminance(const cv::Mat &image, int x, int y) {
    const auto p = image.at<cv::Vec3b>(y, x);
    return (54 * p[2] + 183 * p[1] + 19 * p[0]) >> 8;
}
int percentile(const std::array<uint32_t, 256> &histogram, uint32_t count, double ratio) {
    uint32_t seen = 0, target = std::max(1u, static_cast<uint32_t>(std::ceil(count * ratio)));
    for (int i = 0; i < 256; ++i) {
        seen += histogram[i];
        if (seen >= target)
            return i;
    }
    return 255;
}
} // namespace
Quality measure(const cv::Mat &image) {
    require(!image.empty() && image.type() == CV_8UC3);
    const int stride = std::max(1, static_cast<int>(std::ceil(std::sqrt(image.total() / 65536.0))));
    std::array<uint32_t, 256> histogram{}, background{};
    std::array<std::array<uint32_t, 256>, 64> tiles{};
    std::array<uint32_t, 64> counts{};
    uint32_t samples = 0, saturated = 0, clipped = 0, edge_samples = 0, periodic = 0;
    double sum = 0, squares = 0, edges = 0;
    const auto alternates = [](double a, double b) {
        return a * b < 0 && std::min(std::abs(a), std::abs(b)) >= 3 &&
               std::max(std::abs(a), std::abs(b)) <= 32;
    };
    for (int y = 0; y < image.rows; y += stride)
        for (int x = 0; x < image.cols; x += stride) {
            const auto p = image.at<cv::Vec3b>(y, x);
            const int maximum = std::max({p[0], p[1], p[2]}), minimum = std::min({p[0], p[1], p[2]});
            const int value = static_cast<int>(luminance(image, x, y));
            sum += value;
            squares += value * value;
            ++histogram[value];
            ++samples;
            const int tile = std::min(7, y * 8 / image.rows) * 8 + std::min(7, x * 8 / image.cols);
            ++tiles[tile][value];
            ++counts[tile];
            if (maximum - minimum >= 32 && maximum >= 96)
                ++saturated;
            if (maximum >= 250)
                ++clipped;
            if (x >= stride && y >= stride && x + stride < image.cols && y + stride < image.rows) {
                const double left = luminance(image, x - stride, y), right = luminance(image, x + stride, y),
                             above = luminance(image, x, y - stride), below = luminance(image, x, y + stride);
                edges += std::abs(4 * value - left - right - above - below) / 4;
                ++edge_samples;
                if (alternates(value - left, right - value) || alternates(value - above, below - value))
                    ++periodic;
            }
        }
    uint32_t tile_count = 0;
    for (size_t i = 0; i < 64; ++i)
        if (counts[i]) {
            ++background[percentile(tiles[i], counts[i], .85)];
            ++tile_count;
        }
    Quality q;
    q.mean = sum / samples;
    q.dark = percentile(histogram, samples, .05);
    q.bright = percentile(histogram, samples, .95);
    q.contrast = std::sqrt(std::max(0.0, squares / samples - q.mean * q.mean));
    q.edge = edge_samples ? edges / edge_samples : 0;
    q.illumination = percentile(background, tile_count, .9) - percentile(background, tile_count, .1);
    q.color = static_cast<double>(saturated) / samples >= .12;
    q.periodic = edge_samples ? static_cast<double>(periodic) / edge_samples : 0;
    q.highlight = static_cast<double>(clipped) / samples;
    q.background_dark = percentile(background, tile_count, .1);
    q.background_bright = percentile(background, tile_count, .9);
    return q;
}
} // namespace docscan
