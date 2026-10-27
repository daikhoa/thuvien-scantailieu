#include "paper-field.hpp"
#include <algorithm>
#include <array>
#include <cmath>
namespace docscan {
namespace {
int gray(const cv::Mat &image, int x, int y) {
    const auto p = image.at<cv::Vec3b>(y, x);
    return (54 * p[2] + 183 * p[1] + 19 * p[0]) >> 8;
}
double light(const std::vector<double> &bg, int i) {
    return (54 * bg[i * 3] + 183 * bg[i * 3 + 1] + 19 * bg[i * 3 + 2]) / 256;
}
} // namespace
PaperField refine_paper_background(const cv::Mat &image, const PaperField &coarse,
                                   const std::vector<double> &core, const std::atomic<bool> &cancel) {
    const int width = image.cols, height = image.rows;
    std::array<double, 128> row_sum{}, column_sum{};
    std::array<int, 128> row_count{}, column_count{};
    const int probe_stride = std::max(1, (std::max(width, height) + 127) / 128);
    const int probe_rows = (height + probe_stride - 1) / probe_stride,
              probe_columns = (width + probe_stride - 1) / probe_stride;
    for (int y = 0; y < height; y += probe_stride) {
        check_cancel(cancel);
        for (int x = 0; x < width; x += probe_stride) {
            const int cell = (y * coarse.rows / height) * coarse.columns + x * coarse.columns / width;
            const double paper = light(coarse.background, cell);
            const auto p = image.at<cv::Vec3b>(y, x);
            const double value = (54 * p[2] + 183 * p[1] + 19 * p[0]) / 256.0;
            if (paper < 70 || value < paper * .55)
                continue;
            const int center = gray(image, x, y),
                      probe_radius = std::clamp(int(std::floor(std::max(width, height) / 400.0 + .5)), 2, 8);
            if (value < paper * .78 &&
                ((gray(image, std::max(0, x - probe_radius), y) > center + 8 &&
                  gray(image, std::min(width - 1, x + probe_radius), y) > center + 8) ||
                 (gray(image, x, std::max(0, y - probe_radius)) > center + 8 &&
                  gray(image, x, std::min(height - 1, y + probe_radius)) > center + 8)))
                continue;
            const int yy = y / probe_stride, xx = x / probe_stride;
            const double ratio = value / paper;
            row_sum[yy] += ratio;
            ++row_count[yy];
            column_sum[xx] += ratio;
            ++column_count[xx];
        }
    }
    const auto curvature = [](const auto &sum, const auto &n, int size) {
        double maximum = 0;
        for (int i = 4; i < size - 4; ++i) {
            if (n[i - 1] < 2 || n[i] < 2 || n[i + 1] < 2)
                continue;
            maximum = std::max(maximum,
                               std::abs(sum[i - 1] / n[i - 1] - 2 * sum[i] / n[i] + sum[i + 1] / n[i + 1]));
        }
        return maximum;
    };
    const bool vertical = curvature(column_sum, column_count, probe_columns) >
                          std::max(.03, curvature(row_sum, row_count, probe_rows) * 1.2);
    const int columns = std::min(vertical ? 256 : 64, (width + (vertical ? 2 : 8) - 1) / (vertical ? 2 : 8)),
              rows = std::min(vertical ? 64 : 256, (height + (vertical ? 8 : 2) - 1) / (vertical ? 8 : 2)),
              count = columns * rows;
    std::vector<uint32_t> hist(count * 64), samples(count), amount(count), strokes(count);
    std::vector<double> level(count), background(count * 3), ink(count);
    const int stride = std::max(1, (std::max(width, height) + 719) / 720),
              radius = std::clamp(int(std::floor(std::max(width, height) / 400.0 + .5)), 2, 8);
    for (int y = 0; y < height; y += stride) {
        check_cancel(cancel);
        for (int x = 0; x < width; x += stride) {
            const int i = (y * rows / height) * columns + x * columns / width;
            ++hist[i * 64 + (gray(image, x, y) >> 2)];
            ++samples[i];
        }
    }
    for (int i = 0; i < count; ++i) {
        uint32_t seen = 0;
        for (int b = 0; b < 64; ++b) {
            seen += hist[i * 64 + b];
            if (seen >= uint32_t(std::max(1, int(std::ceil(samples[i] * .85))))) {
                level[i] = std::min(255, b * 4 + 2);
                break;
            }
        }
    }
    for (int y = 0; y < height; y += stride) {
        check_cancel(cancel);
        const auto *row = image.ptr<cv::Vec3b>(y);
        for (int x = 0; x < width; x += stride) {
            const int i = (y * rows / height) * columns + x * columns / width, v = gray(image, x, y);
            if (std::abs(v - level[i]) <= 6) {
                ++amount[i];
                for (int c = 0; c < 3; ++c)
                    background[i * 3 + c] += row[x][2 - c];
            }
            if (v < level[i] * .78 && ((gray(image, std::max(0, x - radius), y) > v + 8 &&
                                        gray(image, std::min(width - 1, x + radius), y) > v + 8) ||
                                       (gray(image, x, std::max(0, y - radius)) > v + 8 &&
                                        gray(image, x, std::min(height - 1, y + radius)) > v + 8))) {
                ink[i] += v;
                ++strokes[i];
            }
        }
    }
    for (int i = 0; i < count; ++i)
        ink[i] = strokes[i] > 0 ? ink[i] / strokes[i] : 255;
    std::vector<double> references;
    for (size_t i = 0; i < coarse.connected.size(); ++i)
        if (coarse.connected[i] && core[i] < 255)
            references.push_back(core[i] / std::max(1.0, light(coarse.background, int(i))));
    std::sort(references.begin(), references.end());
    const double reference = references.empty() ? 0 : references[references.size() / 2];
    std::vector<double> fallback(count * 3);
    std::vector<uint8_t> support(count), candidate(count), trusted(count), valid(count);
    for (int y = 0; y < rows; ++y) {
        check_cancel(cancel);
        for (int x = 0; x < columns; ++x) {
            const int i = y * columns + x,
                      cx = std::min(coarse.columns - 1, int(std::floor((x + .5) * coarse.columns / columns))),
                      cy = std::min(coarse.rows - 1, int(std::floor((y + .5) * coarse.rows / rows))),
                      co = cy * coarse.columns + cx;
            int neighbors = 0;
            if (coarse.connected[co]) {
                support[i] = 1;
                neighbors = 1;
                for (int c = 0; c < 3; ++c)
                    fallback[i * 3 + c] = coarse.background[co * 3 + c];
            } else {
                const int top = std::max(0, cy - 2) * coarse.columns + cx,
                          bottom = std::min(coarse.rows - 1, cy + 2) * coarse.columns + cx,
                          left = cy * coarse.columns + std::max(0, cx - 2),
                          right = cy * coarse.columns + std::min(coarse.columns - 1, cx + 2);
                const bool v = coarse.connected[top] && coarse.connected[bottom],
                           h = coarse.connected[left] && coarse.connected[right];
                if (v || h) {
                    support[i] = 2;
                    for (int j : {v ? top : left, v ? bottom : right}) {
                        ++neighbors;
                        for (int c = 0; c < 3; ++c)
                            fallback[i * 3 + c] += coarse.background[j * 3 + c];
                    }
                    for (int c = 0; c < 3; ++c)
                        fallback[i * 3 + c] /= neighbors;
                }
            }
            const double n = amount[i];
            for (int c = 0; c < 3; ++c)
                background[i * 3 + c] = n ? background[i * 3 + c] / n : fallback[i * 3 + c];
            if (!support[i] || n < 3)
                continue;
            const double r = background[i * 3], g = background[i * 3 + 1], b = background[i * 3 + 2],
                         paper = light(background, i), coarse_paper = light(fallback, i);
            if (paper < 70 || std::max({r, g, b}) - std::min({r, g, b}) > std::max({r, g, b}) * .22)
                continue;
            candidate[i] = 1;
            if (support[i] == 1 && paper >= coarse_paper * .85)
                valid[i] = 1;
            if (strokes[i] >= 2 && reference >= .03 &&
                std::abs(ink[i] / paper - reference) <= std::max(.025, reference * .25))
                trusted[i] = 1;
        }
    }
    std::vector<uint8_t> visited(count);
    std::vector<int> queue;
    for (int i = 0; i < count; ++i)
        if (trusted[i]) {
            visited[i] = 1;
            queue.push_back(i);
        }
    for (size_t next = 0; next < queue.size(); ++next) {
        if ((next & 255) == 0)
            check_cancel(cancel);
        const int i = queue[next], x = i % columns, y = i / columns;
        valid[i] = 1;
        const double here = level[i];
        for (int j : {x > 0 ? i - 1 : -1, x + 1 < columns ? i + 1 : -1, y > 0 ? i - columns : -1,
                      y + 1 < rows ? i + columns : -1}) {
            if (j < 0 || !candidate[j] || visited[j])
                continue;
            if (std::abs(level[j] - here) > std::max(8.0, here * .12))
                continue;
            if (!valid[j] && strokes[j] >= 2 && !trusted[j])
                continue;
            visited[j] = 1;
            queue.push_back(j);
        }
    }
    std::vector<uint8_t> strong(count), shadow_seen(count);
    for (int i = 0; i < count; ++i)
        if (visited[i] && (level[i] < .85 * light(fallback, i)))
            strong[i] = 1;
    bool has_narrow_shadow = false;
    for (int seed = 0; seed < count && !has_narrow_shadow; ++seed) {
        if (!strong[seed] || shadow_seen[seed])
            continue;
        std::vector<int> component{seed};
        shadow_seen[seed] = 1;
        int min_x = columns, max_x = 0, min_y = rows, max_y = 0, ink_evidence = 0;
        for (size_t next = 0; next < component.size(); ++next) {
            if ((next & 255) == 0)
                check_cancel(cancel);
            const int i = component[next], x = i % columns, y = i / columns;
            min_x = std::min(min_x, x);
            max_x = std::max(max_x, x);
            min_y = std::min(min_y, y);
            max_y = std::max(max_y, y);
            if (trusted[i])
                ++ink_evidence;
            for (int j : {x > 0 ? i - 1 : -1, x + 1 < columns ? i + 1 : -1, y > 0 ? i - columns : -1,
                          y + 1 < rows ? i + columns : -1}) {
                if (j < 0 || !strong[j] || shadow_seen[j])
                    continue;
                if (std::abs(level[i] - level[j]) > std::max(8.0, level[i] * .12))
                    continue;
                shadow_seen[j] = 1;
                component.push_back(j);
            }
        }
        has_narrow_shadow = ink_evidence >= 2 && component.size() >= 8 && component.size() < count * .18 &&
                            (max_x - min_x >= columns / 4.0 || max_y - min_y >= rows / 4.0);
    }
    std::vector<uint8_t> connected(count);
    for (int i = 0; i < count; ++i) {
        connected[i] = support[i] == 1 || valid[i] ? 1 : 0;
        if (!valid[i])
            for (int c = 0; c < 3; ++c)
                background[i * 3 + c] = fallback[i * 3 + c];
    }
    check_cancel(cancel);
    return {columns, rows, std::move(background), std::move(connected), has_narrow_shadow};
}
} // namespace docscan
