#include "adaptive-enhancement.hpp"
#include <algorithm>
#include <cmath>
namespace docscan {
namespace {
double quantile(std::vector<double> values, double q) {
    std::sort(values.begin(), values.end());
    return values.empty() ? 0 : values[std::min(values.size() - 1, size_t(std::floor(values.size() * q)))];
}
void validate(const ShadowField &s, bool illumination = false) {
    require(s.width > 0 && s.height > 0 && s.width <= 384 && s.height <= 384 &&
            s.data.size() == size_t(s.width) * s.height * 3);
    for (float v : s.data)
        require(std::isfinite(v) && v >= 0 && v <= 1.5f && (!illumination || v > 0), DS_PROCESSING_FAILED);
}
} // namespace
ShadowField shadow_sample(const cv::Mat &image, const std::atomic<bool> &cancel) {
    require(image.type() == CV_8UC3 && !image.empty());
    const double scale = std::min(1.0, 384.0 / std::max(image.cols, image.rows));
    ShadowField out;
    out.width = std::min(384, std::max(32, int(std::ceil(image.cols * scale / 32)) * 32));
    out.height = std::min(384, std::max(32, int(std::ceil(image.rows * scale / 32)) * 32));
    const size_t plane = size_t(out.width) * out.height;
    out.data.resize(plane * 3);
    for (int y = 0; y < out.height; ++y) {
        check_cancel(cancel);
        const double yy = std::clamp((y + .5) * image.rows / out.height - .5, 0.0, double(image.rows - 1));
        const int top = int(yy), bottom = std::min(top + 1, image.rows - 1);
        const double fy = yy - top;
        for (int x = 0; x < out.width; ++x) {
            const double xx = std::clamp((x + .5) * image.cols / out.width - .5, 0.0, double(image.cols - 1));
            const int left = int(xx), right = std::min(left + 1, image.cols - 1);
            const double fx = xx - left;
            for (int c = 0; c < 3; ++c) {
                const double a = image.at<cv::Vec3b>(top, left)[c] / 255.0 * (1 - fx) +
                                 image.at<cv::Vec3b>(top, right)[c] / 255.0 * fx,
                             b = image.at<cv::Vec3b>(bottom, left)[c] / 255.0 * (1 - fx) +
                                 image.at<cv::Vec3b>(bottom, right)[c] / 255.0 * fx;
                out.data[c * plane + size_t(y) * out.width + x] = float(a * (1 - fy) + b * fy);
            }
        }
    }
    return out;
}
EnhancementPlan enhancement_plan(const ShadowField &s, const ShadowField *field, double periodic) {
    validate(s);
    if (field) {
        validate(*field, true);
        require(s.width == field->width && s.height == field->height);
    }
    const int width = s.width, height = s.height, plane = width * height;
    EnhancementPlan p;
    p.columns = std::min(16, width);
    p.rows = std::min(16, height);
    const int count = p.columns * p.rows;
    std::vector<int> hist(count * 64), totals(count), amounts(count), strokes(count);
    std::vector<double> luma(plane), levels(count), backgrounds(count * 3), model(count * 3), ink(count);
    const auto cell = [&](int x, int y) { return (y * p.rows / height) * p.columns + x * p.columns / width; };
    for (int y = 0; y < height; ++y)
        for (int x = 0; x < width; ++x) {
            const int at = y * width + x, tile = cell(x, y);
            const double v =
                (54.0 * s.data[plane * 2 + at] + 183.0 * s.data[plane + at] + 19.0 * s.data[at]) / 256;
            luma[at] = v;
            ++hist[tile * 64 + std::clamp(int(std::floor(v * 64)), 0, 63)];
            ++totals[tile];
        }
    for (int i = 0; i < count; ++i) {
        int seen = 0;
        for (int b = 0; b < 64; ++b) {
            seen += hist[i * 64 + b];
            if (seen >= std::max(1, int(std::ceil(totals[i] * .85)))) {
                levels[i] = (b + .5) / 64;
                break;
            }
        }
    }
    const auto light = [&](int x, int y) {
        return luma[std::clamp(y, 0, height - 1) * width + std::clamp(x, 0, width - 1)];
    };
    for (int y = 0; y < height; ++y)
        for (int x = 0; x < width; ++x) {
            const int at = y * width + x, i = cell(x, y);
            const double v = luma[at], bg = levels[i];
            if (std::abs(v - bg) < .025) {
                ++amounts[i];
                for (int c = 0; c < 3; ++c) {
                    backgrounds[i * 3 + c] += s.data[c * plane + at];
                    model[i * 3 + c] += field ? field->data[c * plane + at] : 1;
                }
            }
            if (v < bg * .78 && ((light(x - 2, y) > v + .03 && light(x + 2, y) > v + .03) ||
                                 (light(x, y - 2) > v + .03 && light(x, y + 2) > v + .03))) {
                ink[i] += v / std::max(bg, .05);
                ++strokes[i];
            }
        }
    std::vector<uint8_t> candidates(count), trusted(count), blocked(count);
    p.ink_support.resize(count);
    int colored = 0, anchors = 0;
    const double bright = quantile(levels, .9), low = quantile(levels, .1);
    std::vector<double> references;
    for (int i = 0; i < count; ++i) {
        const int n = amounts[i];
        for (int c = 0; c < 3; ++c) {
            backgrounds[i * 3 + c] = n ? backgrounds[i * 3 + c] / n : levels[i];
            model[i * 3 + c] = n ? model[i * 3 + c] / n : 1;
        }
        const double b = backgrounds[i * 3], g = backgrounds[i * 3 + 1], r = backgrounds[i * 3 + 2];
        const double chroma = (std::max({r, g, b}) - std::min({r, g, b})) / std::max({.001, r, g, b});
        if (chroma > .18)
            ++colored;
        const double fraction = double(strokes[i]) / std::max(1, totals[i]);
        ink[i] = strokes[i] ? ink[i] / strokes[i] : 1;
        p.ink_support[i] = std::clamp((.22 - fraction) / .08, 0.0, 1.0);
        if (n >= 3 && chroma < .18 && levels[i] > .15 && strokes[i] >= 2 && fraction < .22) {
            candidates[i] = 1;
            ++anchors;
            if (levels[i] >= bright - .08)
                references.push_back(ink[i]);
        }
    }
    const double reference = references.empty() ? .25 : quantile(references, .5);
    for (int i = 0; i < count; ++i) {
        const bool mismatch = ink[i] > reference * 1.8 + .025 || ink[i] < reference * .6 - .025;
        if (levels[i] < bright * .85 && strokes[i] >= 2 && mismatch)
            blocked[i] = 1;
        if (candidates[i] && !blocked[i])
            trusted[i] = 1;
    }
    const bool colorful = colored > count * .2;
    p.needs_model = anchors >= std::max(4.0, count * .025) && bright - low > (colorful ? .24 : .12);
    p.coverage.resize(count);
    p.ratios.assign(count * 3, 1);
    if (p.needs_model && field) {
        for (int y = 0; y < p.rows; ++y)
            for (int x = 0; x < p.columns; ++x) {
                const int i = y * p.columns + x;
                if (trusted[i]) {
                    p.coverage[i] = 1;
                    continue;
                }
                if (blocked[i])
                    continue;
                std::array<double, 3> total{};
                double weight = 0;
                for (int dy = -3; dy <= 3; ++dy)
                    for (int dx = -3; dx <= 3; ++dx) {
                        const int xx = x + dx, yy = y + dy;
                        if (xx < 0 || xx >= p.columns || yy < 0 || yy >= p.rows ||
                            !trusted[yy * p.columns + xx])
                            continue;
                        const double w = 1.0 / (dx * dx + dy * dy);
                        weight += w;
                        for (int c = 0; c < 3; ++c)
                            total[c] += model[(yy * p.columns + xx) * 3 + c] * w;
                    }
                if (weight > 0) {
                    p.coverage[i] = 1;
                    for (int c = 0; c < 3; ++c)
                        p.ratios[i * 3 + c] =
                            std::clamp(total[c] / weight / std::max(.05, model[i * 3 + c]), .35, 3.0);
                }
            }
        p.field = *field;
    }
    p.background = std::move(levels);
    p.base_gain = !field && !colorful && anchors >= 8 ? std::clamp(.94 / std::max(.1, bright), 1.0, 1.25) : 1;
    p.periodic = periodic > .35;
    return p;
}
void apply_enhancement(cv::Mat &image, const EnhancementPlan &p, const std::atomic<bool> &cancel) {
    require(image.type() == CV_8UC3 && !image.empty());
    const int width = image.cols, height = image.rows,
              radius = std::clamp(int(std::lround(double(std::max(width, height)) / 400)), 2, 8),
              ring_rows = 2 * radius + 1;
    std::vector<uint8_t> ring(size_t(ring_rows) * width);
    const auto remember = [&](int y) {
        for (int x = 0; x < width; ++x) {
            const auto v = image.at<cv::Vec3b>(y, x);
            ring[(y % ring_rows) * width + x] = uint8_t((54 * v[2] + 183 * v[1] + 19 * v[0]) >> 8);
        }
    };
    const auto gray = [&](int x, int y) {
        return ring[(std::clamp(y, 0, height - 1) % ring_rows) * width + std::clamp(x, 0, width - 1)];
    };
    for (int y = 0; y <= std::min(radius, height - 1); ++y)
        remember(y);
    const auto &f = p.field;
    const bool has_field = !f.data.empty();
    const int field_plane = f.width * f.height;
    std::vector<double> field_row(size_t(std::max(1, f.width)) * 3), row(p.columns * 6);
    for (int y = 0; y < height; ++y) {
        if ((y & 31) == 0)
            check_cancel(cancel);
        if (y > 0 && y + radius < height)
            remember(y + radius);
        const double yy = std::clamp((y + .5) * p.rows / height - .5, 0.0, double(p.rows - 1));
        const int top = int(yy), bottom = std::min(top + 1, p.rows - 1);
        const double fy = yy - top;
        for (int x = 0; x < p.columns; ++x) {
            const int a = top * p.columns + x, b = bottom * p.columns + x;
            row[x * 6] = p.background[a] * (1 - fy) + p.background[b] * fy;
            row[x * 6 + 1] = p.coverage[a] * (1 - fy) + p.coverage[b] * fy;
            row[x * 6 + 2] = p.ink_support[a] * (1 - fy) + p.ink_support[b] * fy;
            for (int c = 0; c < 3; ++c)
                row[x * 6 + 3 + c] = p.ratios[a * 3 + c] * (1 - fy) + p.ratios[b * 3 + c] * fy;
        }
        if (has_field) {
            const double yf = std::clamp((y + .5) * f.height / height - .5, 0.0, double(f.height - 1));
            const int a = int(yf), b = std::min(a + 1, f.height - 1);
            const double t = yf - a;
            for (int c = 0; c < 3; ++c)
                for (int x = 0; x < f.width; ++x)
                    field_row[c * f.width + x] = f.data[c * field_plane + a * f.width + x] * (1 - t) +
                                                 f.data[c * field_plane + b * f.width + x] * t;
        }
        auto *pixels = image.ptr<cv::Vec3b>(y);
        for (int x = 0; x < width; ++x) {
            const double value = gray(x, y);
            const bool pulse = (gray(x - radius, y) > value + 8 && gray(x + radius, y) > value + 8) ||
                               (gray(x, y - radius) > value + 8 && gray(x, y + radius) > value + 8);
            if (!has_field && p.base_gain == 1 && !pulse)
                continue;
            const double xx = std::clamp((x + .5) * p.columns / width - .5, 0.0, double(p.columns - 1));
            const int left = int(xx), right = std::min(left + 1, p.columns - 1);
            const double fx = xx - left;
            const auto interpolate = [&](int c) {
                return row[left * 6 + c] * (1 - fx) + row[right * 6 + c] * fx;
            };
            const double paper = interpolate(0) * 255;
            const double ink =
                value < paper * (p.periodic ? .62 : .82) && pulse
                    ? 1 - (1 - std::max(.72, std::pow(std::max(.01, value / std::max(1.0, paper)), .25))) *
                              interpolate(2)
                    : 1;
            int fl = 0, fr = 0;
            double ff = 0;
            if (has_field) {
                const double xf = std::clamp((x + .5) * f.width / width - .5, 0.0, double(f.width - 1));
                fl = int(xf);
                fr = std::min(fl + 1, f.width - 1);
                ff = xf - fl;
            }
            for (int c = 0; c < 3; ++c) {
                double gain = p.base_gain;
                if (has_field) {
                    const double light =
                        (field_row[c * f.width + fl] * (1 - ff) + field_row[c * f.width + fr] * ff) *
                        interpolate(3 + c);
                    gain = 1 + (std::clamp(.96 / std::max(.05, light), 1.0, 4.0) - 1) * interpolate(1);
                }
                pixels[x][c] = uint8_t(std::min(255l, std::lround(pixels[x][c] * gain * ink)));
            }
        }
    }
}
void apply_shadow_illumination(cv::Mat &image, const ShadowField &prediction,
                               const std::atomic<bool> &cancel) {
    validate(prediction, true);
    const int width = prediction.width, height = prediction.height;
    const size_t plane = size_t(width) * height;
    const auto *field = prediction.data.data();
    std::vector<double> row(size_t(width) * 3);
    for (int y = 0; y < image.rows; ++y) {
        if ((y & 31) == 0)
            check_cancel(cancel);
        const double yy = std::clamp((y + .5) * height / image.rows - .5, 0.0, double(height - 1));
        const int top = int(yy), bottom = std::min(top + 1, height - 1);
        const double fy = yy - top;
        for (int c = 0; c < 3; ++c)
            for (int x = 0; x < width; ++x)
                row[c * width + x] = field[c * plane + size_t(top) * width + x] * (1 - fy) +
                                     field[c * plane + size_t(bottom) * width + x] * fy;
        auto *pixels = image.ptr<cv::Vec3b>(y);
        for (int x = 0; x < image.cols; ++x) {
            const double xx = std::clamp((x + .5) * width / image.cols - .5, 0.0, double(width - 1));
            const int left = int(xx), right = std::min(left + 1, width - 1);
            const double fx = xx - left;
            for (int c = 0; c < 3; ++c) {
                const double light = row[c * width + left] * (1 - fx) + row[c * width + right] * fx;
                pixels[x][c] = static_cast<uint8_t>(
                    std::min(255l, std::lround(pixels[x][c] * std::clamp(.96 / light, 1.0, 4.0))));
            }
        }
    }
}
} // namespace docscan
