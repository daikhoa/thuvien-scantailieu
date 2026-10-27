#include "pixels.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
namespace docscan {
namespace {
struct Transform {
    double a, b, c, d, e, f, g, h;
};
Transform transform(const Quad &q) {
    const auto &p = q[0];
    const auto &r = q[1];
    const auto &s = q[2];
    const auto &t = q[3];
    const double x1 = r.x - s.x, x2 = t.x - s.x, y1 = r.y - s.y, y2 = t.y - s.y;
    const double sx = p.x - r.x + s.x - t.x, sy = p.y - r.y + s.y - t.y;
    double g = 0, h = 0;
    if (sx != 0 || sy != 0) {
        const double determinant = x1 * y2 - x2 * y1;
        require(std::abs(determinant) > std::max({std::abs(x1 * y2), std::abs(x2 * y1), 1.0}) *
                                            std::numeric_limits<double>::epsilon() * 16);
        g = (sx * y2 - x2 * sy) / determinant;
        h = (x1 * sy - sx * y1) / determinant;
    }
    return {
        r.x - p.x + g * r.x, t.x - p.x + h * t.x, p.x, r.y - p.y + g * r.y, t.y - p.y + h * t.y, p.y, g, h};
}
double length(const cv::Point2d &a, const cv::Point2d &b) {
    return std::hypot(a.x - b.x, a.y - b.y);
}
} // namespace
cv::Size output_size(const Quad &q, cv::Size source, uint32_t maximum) {
    double signed_area = 0;
    for (size_t i = 0; i < 4; ++i) {
        const auto &a = q[i];
        const auto &b = q[(i + 1) % 4];
        const auto &c = q[(i + 2) % 4];
        require(std::isfinite(a.x) && std::isfinite(a.y) && a.x >= 0 && a.y >= 0 && a.x <= source.width &&
                a.y <= source.height);
        require((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) > 1e-8);
        signed_area += a.x * b.y - a.y * b.x;
    }
    require(signed_area >= 2.0);
    // Exact full-frame requests must not grow by one pixel from sqrt/ceil roundoff.
    if (full_frame_copy(q, source, source)) {
        const double scale = std::min(1.0, double(maximum) / std::max(source.width, source.height));
        return {std::max(1, int(std::floor(source.width * scale))),
                std::max(1, int(std::floor(source.height * scale)))};
    }
    const double edge_width = std::max(length(q[0], q[1]), length(q[3], q[2]));
    const double edge_height = std::max(length(q[0], q[3]), length(q[1], q[2]));
    const auto m = transform(q);
    const double cx = source.width / 2.0, cy = source.height / 2.0;
    const double ax = m.a - cx * m.g, ay = m.d - cy * m.g, bx = m.b - cx * m.h, by = m.e - cy * m.h;
    const double short_side = std::min(source.width, source.height), product = m.g * m.h;
    double focal = short_side * .75;
    if (product != 0) {
        const double f2 = -(ax * bx + ay * by) / product;
        if (f2 > 0 && std::isfinite(f2)) {
            const double candidate = std::sqrt(f2),
                         bounded = std::clamp(candidate, short_side * .45, short_side * 1.8);
            const double strength = std::abs(product),
                         confidence = strength * strength / (strength * strength + 1e-12) *
                                      std::exp(-4 * std::abs(std::log(candidate / bounded)));
            focal += (bounded - focal) * confidence;
        }
    }
    const double ratio = std::sqrt(ax * ax / (focal * focal) + ay * ay / (focal * focal) + m.g * m.g) /
                         std::sqrt(bx * bx / (focal * focal) + by * by / (focal * focal) + m.h * m.h);
    require(ratio > 0 && std::isfinite(ratio));
    const double budget = edge_width * edge_height;
    const double width = std::ceil(std::sqrt(budget * ratio)), height = std::ceil(std::sqrt(budget / ratio));
    require(width > 0 && height > 0 && std::isfinite(width) && std::isfinite(height));
    const double scale = std::min(1.0, maximum / std::max(width, height));
    return {std::max(1, static_cast<int>(std::floor(width * scale))),
            std::max(1, static_cast<int>(std::floor(height * scale)))};
}
bool full_frame_copy(const Quad &q, cv::Size source, cv::Size output) {
    return source == output && q[0] == cv::Point2d(0, 0) && q[1] == cv::Point2d(source.width, 0) &&
           q[2] == cv::Point2d(source.width, source.height) && q[3] == cv::Point2d(0, source.height);
}
cv::Rect warp_source_region(const Quad &corners, cv::Size source, cv::Size output, cv::Rect region) {
    require(region.width > 0 && region.height > 0 && region.x >= 0 && region.y >= 0 &&
            region.x + region.width <= output.width && region.y + region.height <= output.height);
    if (full_frame_copy(corners, source, output))
        return region;
    const auto m = transform(corners);
    double min_x = source.width - 1, max_x = 0, min_y = source.height - 1, max_y = 0;
    for (int y : {region.y, region.y + region.height - 1})
        for (int x : {region.x, region.x + region.width - 1}) {
            const double u = (x + .5) / output.width, v = (y + .5) / output.height;
            const double den = m.g * u + m.h * v + 1;
            require(std::isfinite(den) && std::abs(den) > 1e-12);
            const double sx = std::clamp((m.a * u + m.b * v + m.c) / den - .5, 0.0, double(source.width - 1));
            const double sy =
                std::clamp((m.d * u + m.e * v + m.f) / den - .5, 0.0, double(source.height - 1));
            min_x = std::min(min_x, sx);
            max_x = std::max(max_x, sx);
            min_y = std::min(min_y, sy);
            max_y = std::max(max_y, sy);
        }
    const int left = int(min_x), top = int(min_y);
    const int right = std::min(source.width, int(max_x) + 2),
              bottom = std::min(source.height, int(max_y) + 2);
    return {left, top, right - left, bottom - top};
}
void warp_region(const cv::Mat &source, cv::Point origin, cv::Size source_size, const Quad &corners,
                 cv::Rect region, cv::Mat &output, const std::atomic<bool> &cancel) {
    require(source.type() == CV_8UC3 && output.type() == CV_8UC3);
    const auto needed = warp_source_region(corners, source_size, output.size(), region);
    require(origin.x <= needed.x && origin.y <= needed.y &&
            origin.x + source.cols >= needed.x + needed.width &&
            origin.y + source.rows >= needed.y + needed.height);
    if (full_frame_copy(corners, source_size, output.size())) {
        source(cv::Rect(region.x - origin.x, region.y - origin.y, region.width, region.height))
            .copyTo(output(region));
        return;
    }
    const auto m = transform(corners);
    for (int y = region.y; y < region.y + region.height; ++y) {
        if ((y & 31) == 0)
            check_cancel(cancel);
        auto *destination = output.ptr<cv::Vec3b>(y);
        const double v = (y + .5) / output.rows;
        for (int x = region.x; x < region.x + region.width; ++x) {
            const double u = (x + .5) / output.cols, den = m.g * u + m.h * v + 1;
            require(std::isfinite(den) && std::abs(den) > 1e-12);
            const double sx = std::clamp((m.a * u + m.b * v + m.c) / den - .5, 0.0,
                                         static_cast<double>(source_size.width - 1));
            const double sy = std::clamp((m.d * u + m.e * v + m.f) / den - .5, 0.0,
                                         static_cast<double>(source_size.height - 1));
            const int left = static_cast<int>(sx), top = static_cast<int>(sy),
                      right = std::min(left + 1, source_size.width - 1),
                      bottom = std::min(top + 1, source_size.height - 1);
            require(left >= origin.x && right < origin.x + source.cols && top >= origin.y &&
                    bottom < origin.y + source.rows);
            const double dx = sx - left, dy = sy - top;
            const auto *first = source.ptr<cv::Vec3b>(top - origin.y);
            const auto *second = source.ptr<cv::Vec3b>(bottom - origin.y);
            for (int c = 0; c < 3; ++c)
                destination[x][c] = cv::saturate_cast<uint8_t>(
                    first[left - origin.x][c] * (1 - dx) * (1 - dy) +
                    first[right - origin.x][c] * dx * (1 - dy) + second[left - origin.x][c] * (1 - dx) * dy +
                    second[right - origin.x][c] * dx * dy);
        }
    }
}
cv::Mat warp(const cv::Mat &source, const Quad &corners, uint32_t maximum, const std::atomic<bool> &cancel) {
    check_cancel(cancel);
    require(!source.empty() && source.type() == CV_8UC3);
    const auto dimensions = output_size(corners, source.size(), maximum);
    cv::Mat output(dimensions, CV_8UC3);
    warp_region(source, {0, 0}, source.size(), corners, {0, 0, output.cols, output.rows}, output, cancel);
    return output;
}
} // namespace docscan
