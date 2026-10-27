#include "paper-restoration.hpp"
#include "paper-field.hpp"
#include <algorithm>
#include <array>
#include <cmath>
namespace docscan {
namespace {
constexpr int bins = 64, max_grid_side = 24;
int luma(const cv::Mat &image, int x, int y) {
    const auto p = image.at<cv::Vec3b>(y, x);
    return (54 * p[2] + 183 * p[1] + 19 * p[0]) >> 8;
}
int quantile(const std::vector<uint32_t> &histogram, int start, int count, double ratio) {
    const int wanted = std::max(1, int(std::ceil(count * ratio)));
    uint32_t seen = 0;
    for (int bin = 0; bin < bins; ++bin) {
        seen += histogram[start + bin];
        if (seen >= uint32_t(wanted))
            return std::min(255, bin * 4 + 2);
    }
    return 255;
}
double percentile(const std::vector<double> &values, double ratio) {
    return values[std::max(0, int(std::ceil(values.size() * ratio)) - 1)];
}
bool stroke_at(const cv::Mat &image, int x, int y, int radius, int center) {
    const int left = luma(image, std::max(0, x - radius), y),
              right = luma(image, std::min(image.cols - 1, x + radius), y),
              top = luma(image, x, std::max(0, y - radius)),
              bottom = luma(image, x, std::min(image.rows - 1, y + radius));
    return (left - center > 8 && right - center > 8) || (top - center > 8 && bottom - center > 8);
}
} // namespace
void restore_paper(cv::Mat &image, const std::atomic<bool> &cancel) {
    check_cancel(cancel);
    const int width = image.cols, height = image.rows;
    if (std::min(width, height) < 192)
        return;
    int columns = std::min(max_grid_side, std::max(4, (width + 47) / 48)),
        rows = std::min(max_grid_side, std::max(4, (height + 47) / 48));
    const int count = columns * rows, stride = std::max(1, (std::max(width, height) + 511) / 512),
              radius = std::clamp(int(std::floor(std::max(width, height) / 400.0 + .5)), 2, 8);
    std::vector<double> stroke_means(count);
    std::vector<uint32_t> histograms(count * bins), samples(count), backgrounds(count), dark(count),
        strokes(count);
    for (int y = 0; y < height; y += stride) {
        if ((y & 31) == 0)
            check_cancel(cancel);
        for (int x = 0; x < width; x += stride) {
            const int cell = (y * rows / height) * columns + x * columns / width;
            ++histograms[cell * bins + (luma(image, x, y) >> 2)];
            ++samples[cell];
        }
    }
    std::vector<double> levels(count), spreads(count), background(count * 3), ink(count * 3);
    for (int i = 0; i < count; ++i) {
        levels[i] = quantile(histograms, i * bins, samples[i], .85);
        spreads[i] = levels[i] - quantile(histograms, i * bins, samples[i], .6);
    }
    for (int y = 0; y < height; y += stride) {
        if ((y & 31) == 0)
            check_cancel(cancel);
        const auto *row = image.ptr<cv::Vec3b>(y);
        for (int x = 0; x < width; x += stride) {
            const int cell = (y * rows / height) * columns + x * columns / width, value = luma(image, x, y);
            if (std::abs(value - levels[cell]) <= 6) {
                ++backgrounds[cell];
                for (int c = 0; c < 3; ++c)
                    background[cell * 3 + c] += row[x][2 - c];
            }
            if (value < levels[cell] * .78) {
                ++dark[cell];
                for (int c = 0; c < 3; ++c)
                    ink[cell * 3 + c] += row[x][2 - c];
                if (stroke_at(image, x, y, radius, value)) {
                    ++strokes[cell];
                    stroke_means[cell] += value;
                }
            }
        }
    }
    std::vector<uint8_t> eligible(count), text(count), neutral(count);
    std::vector<double> paper_levels;
    for (int i = 0; i < count; ++i) {
        const double n = backgrounds[i], d = dark[i], total = samples[i];
        for (int c = 0; c < 3; ++c)
            background[i * 3 + c] = n ? background[i * 3 + c] / n : 255;
        if (n < 8 || total == 0)
            continue;
        const double r = background[i * 3], g = background[i * 3 + 1], b = background[i * 3 + 2],
                     maximum = std::max({r, g, b}), minimum = std::min({r, g, b});
        neutral[i] = maximum - minimum <= maximum * .06;
        if (levels[i] < 90 || levels[i] > 252 || spreads[i] > 20 || maximum - minimum > maximum * .22 ||
            d / total > .35)
            continue;
        eligible[i] = 1;
        if (d < 3 || d / total < .008 || strokes[i] / total < .003 || strokes[i] / total > .18)
            continue;
        // Black ink and paper share illumination; a printed colored substrate
        // usually changes only the background. Abstain without neutral anchors.
        const double ir = ink[i * 3] / d / std::max(1.0, r), ig = ink[i * 3 + 1] / d / std::max(1.0, g),
                     ib = ink[i * 3 + 2] / d / std::max(1.0, b), mean = (ir + ig + ib) / 3;
        if (mean > .03 ? std::max({ir, ig, ib}) - std::min({ir, ig, ib}) > mean * .18 : neutral[i] != 1)
            continue;
        text[i] = 1;
        paper_levels.push_back(levels[i]);
    }
    if (paper_levels.size() < std::max(4.0, count * .08))
        return;
    std::sort(paper_levels.begin(), paper_levels.end());
    const double bright = percentile(paper_levels, .9), low = percentile(paper_levels, .1);
    if (bright < 170)
        return;
    int anchors = 0;
    for (int i = 0; i < count; ++i)
        if (text[i] && neutral[i] && levels[i] >= bright - 12)
            ++anchors;
    if (anchors < 2)
        return;
    std::vector<uint8_t> supported(count), connected(count);
    std::vector<int> queue;
    for (int y = 0; y < rows; ++y)
        for (int x = 0; x < columns; ++x) {
            const int i = y * columns + x;
            if (!eligible[i])
                continue;
            for (int dy = -2; dy <= 2; ++dy)
                for (int dx = -2; dx <= 2; ++dx) {
                    const int xx = x + dx, yy = y + dy;
                    if (xx >= 0 && xx < columns && yy >= 0 && yy < rows && text[yy * columns + xx])
                        supported[i] = 1;
                }
            if (text[i] && neutral[i] && levels[i] >= bright - 12) {
                connected[i] = 1;
                queue.push_back(i);
            }
        }
    for (size_t next = 0; next < queue.size(); ++next) {
        const int i = queue[next], x = i % columns, y = i / columns;
        for (const int j : {x > 0 ? i - 1 : -1, x + 1 < columns ? i + 1 : -1, y > 0 ? i - columns : -1,
                            y + 1 < rows ? i + columns : -1}) {
            if (j < 0 || !supported[j] || connected[j])
                continue;
            if (std::abs(levels[i] - levels[j]) > std::max(14.0, std::max(levels[i], levels[j]) * .14))
                continue;
            connected[j] = 1;
            queue.push_back(j);
        }
    }
    for (int i = 0; i < count; ++i)
        stroke_means[i] = strokes[i] > 0 ? stroke_means[i] / strokes[i] : 255;
    auto fine = refine_paper_background(image, {columns, rows, std::move(background), std::move(connected)},
                                        stroke_means, cancel);
    if (bright - low < 24 && !fine.has_narrow_shadow)
        return;
    columns = fine.columns;
    rows = fine.rows;
    background = std::move(fine.background);
    connected = std::move(fine.connected);
    const double target = std::clamp(bright, 232.0, 245.0);
    const int ring_rows = radius * 2 + 1;
    std::vector<uint8_t> original(ring_rows * width);
    const auto remember_row = [&](int y) {
        for (int x = 0; x < width; ++x)
            original[(y % ring_rows) * width + x] = uint8_t(luma(image, x, y));
    };
    for (int y = 0; y <= std::min(radius, height - 1); ++y)
        remember_row(y);
    const auto gray_at = [&](int x, int y) {
        return int(
            original[(std::clamp(y, 0, height - 1) % ring_rows) * width + std::clamp(x, 0, width - 1)]);
    };
    const auto sample = [&](int i, int c) { return connected[i] ? background[i * 3 + c] : 0; };
    for (int y = 0; y < height; ++y) {
        if ((y & 31) == 0)
            check_cancel(cancel);
        if (y > 0 && y + radius < height)
            remember_row(y + radius);
        const double gy = std::clamp((y + .5) * rows / height - .5, 0.0, double(rows - 1));
        const int top = int(std::floor(gy)), bottom = std::min(rows - 1, top + 1);
        const double fy = gy - top;
        auto *row = image.ptr<cv::Vec3b>(y);
        for (int x = 0; x < width; ++x) {
            const double gx = std::clamp((x + .5) * columns / width - .5, 0.0, double(columns - 1));
            const int left = int(std::floor(gx)), right = std::min(columns - 1, left + 1);
            const double fx = gx - left;
            const int a = top * columns + left, bi = top * columns + right, ci = bottom * columns + left,
                      d = bottom * columns + right;
            const double wa = (1 - fx) * (1 - fy), wb = fx * (1 - fy), wc = (1 - fx) * fy, wd = fx * fy,
                         strength =
                             connected[a] * wa + connected[bi] * wb + connected[ci] * wc + connected[d] * wd;
            if (strength == 0)
                continue;
            const auto channel = [&](int c) {
                return std::max(
                    1.0, (sample(a, c) * wa + sample(bi, c) * wb + sample(ci, c) * wc + sample(d, c) * wd) /
                             strength);
            };
            const double br = channel(0), bg = channel(1), bb = channel(2);
            auto &p = row[x];
            const double r = p[2], g = p[1], b = p[0], rr = r / br, rg = g / bg, rb = b / bb,
                         mean = (rr + rg + rb) / 3;
            if (std::max({rr, rg, rb}) - std::min({rr, rg, rb}) > mean * .1 + .003)
                continue;
            const int value = (54 * int(r) + 183 * int(g) + 19 * int(b)) >> 8;
            const double paper = (54 * br + 183 * bg + 19 * bb) / 256;
            if (value < paper * .8 &&
                !((gray_at(x - radius, y) > value + 8 && gray_at(x + radius, y) > value + 8) ||
                  (gray_at(x, y - radius) > value + 8 && gray_at(x, y + radius) > value + 8)))
                continue;
            const double ink_protection = 1 - .35 * (1 - std::min(1.0, value / paper)),
                         dr = r * (std::clamp(target / br * ink_protection, .8, 1.9) - 1),
                         dg = g * (std::clamp(target / bg * ink_protection, .8, 1.9) - 1),
                         db = b * (std::clamp(target / bb * ink_protection, .8, 1.9) - 1),
                         limit = std::min({1.0, dr > 0 ? std::max(0.0, 254 - r) / dr : 1,
                                           dg > 0 ? std::max(0.0, 254 - g) / dg : 1,
                                           db > 0 ? std::max(0.0, 254 - b) / db : 1});
            p = {uint8_t(b + std::floor(db * limit * strength + .5)),
                 uint8_t(g + std::floor(dg * limit * strength + .5)),
                 uint8_t(r + std::floor(dr * limit * strength + .5))};
        }
    }
    check_cancel(cancel);
}
} // namespace docscan
