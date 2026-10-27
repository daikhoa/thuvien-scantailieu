#include "lab.hpp"
#include "paper-restoration.hpp"
#include "pixels.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <opencv2/imgproc.hpp>
namespace docscan {
namespace {
uint8_t byte(double x) {
    return static_cast<uint8_t>(std::clamp(std::lround(x), 0l, 255l));
}
cv::Mat luminance(const cv::Mat &image) {
    cv::Mat gray(image.size(), CV_8U);
    for (int y = 0; y < image.rows; ++y) {
        const auto *row = image.ptr<cv::Vec3b>(y);
        auto *out = gray.ptr<uint8_t>(y);
        for (int x = 0; x < image.cols; ++x)
            out[x] = static_cast<uint8_t>((54 * row[x][2] + 183 * row[x][1] + 19 * row[x][0]) >> 8);
    }
    return gray;
}
struct Illumination {
    int columns, rows;
    std::vector<double> levels;
};
Illumination illumination(const cv::Mat &gray) {
    Illumination grid{std::min(16, std::max(1, std::max(4, static_cast<int>(std::lround(gray.cols / 64.0))))),
                      std::min(16, std::max(1, std::max(4, static_cast<int>(std::lround(gray.rows / 64.0))))),
                      {}};
    grid.columns = std::min(grid.columns, gray.cols);
    grid.rows = std::min(grid.rows, gray.rows);
    grid.levels.resize(static_cast<size_t>(grid.columns) * grid.rows);
    for (int gy = 0; gy < grid.rows; ++gy)
        for (int gx = 0; gx < grid.columns; ++gx) {
            std::array<uint32_t, 256> histogram{};
            uint32_t count = 0;
            for (int y = (gy * gray.rows + grid.rows - 1) / grid.rows;
                 y < ((gy + 1) * gray.rows + grid.rows - 1) / grid.rows; ++y) {
                const auto *row = gray.ptr<uint8_t>(y);
                for (int x = (gx * gray.cols + grid.columns - 1) / grid.columns;
                     x < ((gx + 1) * gray.cols + grid.columns - 1) / grid.columns; ++x) {
                    ++histogram[row[x]];
                    ++count;
                }
            }
            uint32_t sum = 0;
            int value = 0;
            for (; value < 255; ++value) {
                sum += histogram[value];
                if (sum >= std::ceil(count * .85))
                    break;
            }
            grid.levels[gy * grid.columns + gx] = value;
        }
    return grid;
}
double background(const Illumination &g, int x, int y, cv::Size size) {
    const double fx = std::clamp((x + .5) * g.columns / size.width - .5, 0.0, double(g.columns - 1));
    const double fy = std::clamp((y + .5) * g.rows / size.height - .5, 0.0, double(g.rows - 1));
    const int left = static_cast<int>(fx), top = static_cast<int>(fy),
              right = std::min(left + 1, g.columns - 1), bottom = std::min(top + 1, g.rows - 1);
    const double dx = fx - left, dy = fy - top;
    return (g.levels[top * g.columns + left] * (1 - dx) + g.levels[top * g.columns + right] * dx) * (1 - dy) +
           (g.levels[bottom * g.columns + left] * (1 - dx) + g.levels[bottom * g.columns + right] * dx) * dy;
}
void clahe(cv::Mat &image, cv::Mat &gray, double strength, const std::atomic<bool> &cancel) {
    const int columns = std::min(8, image.cols), rows = std::min(8, image.rows);
    std::vector<std::array<uint32_t, 256>> histograms(static_cast<size_t>(columns) * rows);
    std::vector<uint32_t> counts(histograms.size());
    cv::Mat light(image.size(), CV_8U);
    int minimum = 255, maximum = 0;
    for (int y = 0; y < image.rows; ++y) {
        if ((y & 31) == 0)
            check_cancel(cancel);
        for (int x = 0; x < image.cols; ++x) {
            const auto value = byte(lab().lightness(image.at<cv::Vec3b>(y, x)));
            light.at<uint8_t>(y, x) = value;
            minimum = std::min(minimum, int(value));
            maximum = std::max(maximum, int(value));
            const int tile = y * rows / image.rows * columns + x * columns / image.cols;
            ++histograms[tile][value];
            ++counts[tile];
        }
    }
    if (maximum - minimum < 2)
        return;
    std::vector<std::array<uint8_t, 256>> maps(counts.size());
    for (size_t tile = 0; tile < counts.size(); ++tile) {
        const auto count = counts[tile],
                   limit = std::max(1u, static_cast<uint32_t>(std::ceil(2.0 * count / 256)));
        uint32_t excess = 0;
        for (auto &value : histograms[tile]) {
            excess += value > limit ? value - limit : 0;
            value = std::min(limit, value);
        }
        uint32_t cumulative = 0;
        for (size_t value = 0; value < 256; ++value) {
            cumulative += histograms[tile][value] + excess / 256 + (value < excess % 256 ? 1 : 0);
            maps[tile][value] = byte(double(cumulative) / count * 255);
        }
    }
    for (int y = 0; y < image.rows; ++y) {
        if ((y & 31) == 0)
            check_cancel(cancel);
        for (int x = 0; x < image.cols; ++x) {
            const double gx = std::clamp((x + .5) * columns / image.cols - .5, 0.0, double(columns - 1)),
                         gy = std::clamp((y + .5) * rows / image.rows - .5, 0.0, double(rows - 1));
            const int left = static_cast<int>(gx), top = static_cast<int>(gy),
                      right = std::min(columns - 1, left + 1), bottom = std::min(rows - 1, top + 1);
            const double dx = gx - left, dy = gy - top;
            const int value = light.at<uint8_t>(y, x);
            const double mapped =
                (maps[top * columns + left][value] * (1 - dx) + maps[top * columns + right][value] * dx) *
                    (1 - dy) +
                (maps[bottom * columns + left][value] * (1 - dx) +
                 maps[bottom * columns + right][value] * dx) *
                    dy;
            auto &pixel = image.at<cv::Vec3b>(y, x);
            lab().adjust(pixel,
                         std::clamp(mapped - value, -18.0, 18.0) * strength * std::min(1.0, value / 48.0));
            gray.at<uint8_t>(y, x) =
                static_cast<uint8_t>((54 * pixel[2] + 183 * pixel[1] + 19 * pixel[0]) >> 8);
        }
    }
}
// Same conservative RGB/detail kernel as the web, using only three luminance rows.
void enhanced_color(cv::Mat &image, const Quality &q, const std::atomic<bool> &cancel) {
    const double range = q.bright - q.dark;
    const bool stretch = range >= 32;
    const bool faint_ink =
        !stretch && range >= 8 && !q.color && q.edge >= .3 && q.edge <= range * .18 && q.periodic < .18;
    const double black = std::clamp(q.dark - 8, 0.0, 40.0), white = std::clamp(q.bright + 8, 215.0, 255.0);
    const double low = black * .35, high = white + (255 - white) * .65;
    std::array<uint8_t, 256> lookup{};
    for (size_t i = 1; i < 255; ++i) {
        if (!stretch) {
            lookup[i] = faint_ink
                            ? static_cast<uint8_t>(std::max(
                                  1l, std::lround(i - std::min(12.0, std::max(0.0, q.bright - i) * .35))))
                            : static_cast<uint8_t>(i);
            continue;
        }
        const double value = static_cast<double>(i);
        double mapped;
        if (value < black)
            mapped = value * low / black;
        else if (value <= white)
            mapped = low + (value - black) * (high - low) / (white - black);
        else
            mapped = high + (value - white) * (255 - high) / (255 - white);
        lookup[i] = static_cast<uint8_t>(std::clamp(std::lround(mapped), 1l, 254l));
    }
    lookup[255] = 255;
    const bool sharpen = image.cols >= 3 && image.rows >= 3 && q.edge < 42 && q.periodic < .25;
    if (!sharpen) {
        if (!stretch && !faint_ink)
            return;
        for (int y = 0; y < image.rows; ++y) {
            if ((y & 31) == 0)
                check_cancel(cancel);
            auto *row = image.ptr<cv::Vec3b>(y);
            for (int x = 0; x < image.cols; ++x)
                for (int c = 0; c < 3; ++c)
                    row[x][c] = lookup[row[x][c]];
        }
        return;
    }
    const auto map_row = [&](int y, std::vector<uint8_t> &light) {
        int uniform_level = -1;
        auto *row = image.ptr<cv::Vec3b>(y);
        for (int x = 0; x < image.cols; ++x) {
            for (int c = 0; c < 3; ++c)
                row[x][c] = lookup[row[x][c]];
            light[x] = static_cast<uint8_t>((54 * row[x][2] + 183 * row[x][1] + 19 * row[x][0]) >> 8);
            if (x == 0)
                uniform_level = light[x];
            else if (light[x] != uniform_level)
                uniform_level = -1;
        }
        return uniform_level;
    };
    std::vector<uint8_t> previous(image.cols), current(image.cols), next(image.cols);
    int previous_level = map_row(0, previous), current_level = map_row(1, current),
        next_level = map_row(2, next);
    for (int y = 1; y < image.rows - 1; ++y) {
        if ((y & 31) == 0)
            check_cancel(cancel);
        const bool uniform_rows =
            current_level >= 0 && previous_level == current_level && next_level == current_level;
        if (!uniform_rows) {
            auto *row = image.ptr<cv::Vec3b>(y);
            for (int x = 1; x < image.cols - 1; ++x) {
                const int center = current[x], left = current[x - 1], right = current[x + 1],
                          top = previous[x], bottom = next[x];
                const double dark_detail = (left + right + top + bottom) / 4.0 - center;
                if (dark_detail <= 6 || dark_detail >= 48)
                    continue;
                if (std::min(std::max(std::abs(left - center), std::abs(right - center)),
                             std::max(std::abs(top - center), std::abs(bottom - center))) > 8)
                    continue;
                const int minimum = std::min({row[x][0], row[x][1], row[x][2]}),
                          maximum = std::max({row[x][0], row[x][1], row[x][2]});
                const double strength =
                    .65 * std::min(1.0, (48 - dark_detail) / 16) * (maximum - minimum > 48 ? .35 : 1);
                // Ink-only detail avoids bright halos and preserves channel differences.
                const auto adjustment = std::lround(
                    std::max(0.0, std::min({12.0, double(minimum - 1), (dark_detail - 6) * strength})));
                for (int c = 0; c < 3; ++c)
                    row[x][c] = static_cast<uint8_t>(row[x][c] - adjustment);
            }
        }
        previous.swap(current);
        current.swap(next);
        previous_level = current_level;
        current_level = next_level;
        if (y + 2 < image.rows)
            next_level = map_row(y + 2, next);
    }
}
} // namespace
void enhance(cv::Mat &image, int mode, const Plan &plan, const std::atomic<bool> &cancel) {
    if (mode == DS_FILTER_ORIGINAL)
        return;
    check_cancel(cancel);
    if (mode == DS_FILTER_SHADOW_REMOVAL) {
        enhanced_color(image, plan.quality, cancel);
        return;
    }
    if (mode == DS_FILTER_ENHANCED_COLOR) {
        restore_paper(image, cancel);
        enhanced_color(image, plan.quality, cancel);
        return;
    }
    if (mode == DS_FILTER_AUTO && plan.shadow == 0 && plan.lift == 0 && plan.contrast == 0 &&
        plan.sharpen == 0 && plan.smooth == 0)
        return;
    auto gray = luminance(image);
    if (plan.smooth > 0) {
        const auto source = gray.clone();
        for (int y = 1; y < image.rows - 1; ++y) {
            check_cancel(cancel);
            auto *row = image.ptr<cv::Vec3b>(y);
            auto *light = gray.ptr<uint8_t>(y);
            for (int x = 1; x < image.cols - 1; ++x) {
                const double center = source.at<uint8_t>(y, x);
                const double mean = (source.at<uint8_t>(y, x - 1) + source.at<uint8_t>(y, x + 1) +
                                     source.at<uint8_t>(y - 1, x) + source.at<uint8_t>(y + 1, x)) /
                                    4.0;
                if (std::abs(mean - center) > 8)
                    continue;
                const double delta = (mean - center) * plan.smooth;
                for (int c = 0; c < 3; ++c)
                    row[x][c] = byte(row[x][c] + delta);
                light[x] = byte(center + delta);
            }
        }
    }
    const auto adjust = [&](auto adjustment) {
        for (int y = 0; y < image.rows; ++y) {
            if ((y & 31) == 0)
                check_cancel(cancel);
            auto *row = image.ptr<cv::Vec3b>(y);
            const auto *light = gray.ptr<uint8_t>(y);
            for (int x = 0; x < image.cols; ++x) {
                const int maximum = std::max({row[x][0], row[x][1], row[x][2]}),
                          minimum = std::min({row[x][0], row[x][1], row[x][2]});
                const double d = std::clamp(adjustment(x, y, double(light[x]), maximum), double(-minimum),
                                            double(std::max(0, 248 - maximum)));
                if (plan.protect_color)
                    lab().adjust(row[x], d * .65);
                else
                    for (int c = 0; c < 3; ++c)
                        row[x][c] = byte(row[x][c] + d);
            }
        }
        gray = luminance(image);
    };
    if (plan.shadow > 0 && plan.quality.illumination >= 18 && plan.quality.highlight < .55) {
        const auto grid = illumination(gray);
        for (int y = 0; y < image.rows; ++y) {
            if ((y & 31) == 0)
                check_cancel(cancel);
            auto *row = image.ptr<cv::Vec3b>(y);
            auto *light = gray.ptr<uint8_t>(y);
            for (int x = 0; x < image.cols; ++x) {
                const int maximum = std::max({row[x][0], row[x][1], row[x][2]});
                const double requested =
                    1 + (std::clamp(plan.quality.background_bright /
                                        std::max(32.0, background(grid, x, y, image.size())),
                                    1.0, plan.protect_color ? 1.25 : 2.25) -
                         1) *
                            plan.shadow;
                const double gain = maximum ? std::min(requested, 248.0 / maximum) : 1;
                if (gain <= 1)
                    continue;
                if (plan.protect_color)
                    lab().adjust(row[x], light[x] * (gain - 1) * .65);
                else
                    for (int c = 0; c < 3; ++c)
                        row[x][c] = byte(row[x][c] * gain);
                light[x] = static_cast<uint8_t>((54 * row[x][2] + 183 * row[x][1] + 19 * row[x][0]) >> 8);
            }
        }
    }
    if (plan.lift > 0 && !plan.protect_color) {
        const double paper = std::max(1.0, plan.quality.background_bright),
                     lift = std::min(72.0, 238 - paper) * plan.lift;
        if (lift > 0)
            adjust([&](int, int, double value, int) {
                const double relative = std::clamp(value / paper, 0.0, 1.0);
                return lift * relative * relative;
            });
    }
    if (plan.lift > 0)
        adjust([&](int, int, double value, int) {
            return 255 * std::pow(value / 255, 1 - plan.lift * .3) - value;
        });
    if (plan.contrast > 0)
        clahe(image, gray, plan.contrast, cancel);
    if (mode == DS_FILTER_AUTO && plan.sharpen == 0)
        return;
    const int radius =
        std::max(2, std::min(48, static_cast<int>(std::lround(std::min(image.cols, image.rows) / 32.0))));
    // Sliding columns give exact integer sums with O(width) extra storage, including Sauvola variance.
    std::vector<uint32_t> columns(image.cols);
    std::vector<uint64_t> squares(mode == DS_FILTER_BLACK_WHITE ? image.cols : 0);
    int first_row = 0, last_row = -1;
    for (int y = 0; y < image.rows; ++y) {
        if ((y & 31) == 0)
            check_cancel(cancel);
        const int first = std::max(0, y - radius), last = std::min(image.rows - 1, y + radius);
        const auto accumulate = [&](int row, int sign) {
            const auto *values = gray.ptr<uint8_t>(row);
            for (int x = 0; x < image.cols; ++x) {
                columns[x] = static_cast<uint32_t>(int64_t(columns[x]) + sign * values[x]);
                if (!squares.empty())
                    squares[x] = static_cast<uint64_t>(int64_t(squares[x]) + sign * values[x] * values[x]);
            }
        };
        while (last_row < last)
            accumulate(++last_row, 1);
        while (first_row < first)
            accumulate(first_row++, -1);
        uint64_t sum = 0, squared_sum = 0;
        for (int x = 0; x <= std::min(image.cols - 1, radius); ++x) {
            sum += columns[x];
            if (!squares.empty())
                squared_sum += squares[x];
        }
        auto *row = image.ptr<cv::Vec3b>(y);
        const auto *light = gray.ptr<uint8_t>(y);

        for (int x = 0; x < image.cols; ++x) {
            const double value = light[x];
            double target = value;
            const int count = (std::min(image.cols - 1, x + radius) - std::max(0, x - radius) + 1) *
                              (std::min(image.rows - 1, y + radius) - std::max(0, y - radius) + 1);
            const double local_mean = double(sum) / count;
            if (mode == DS_FILTER_BLACK_WHITE) {
                const double variance = std::max(0.0, double(squared_sum) / count - local_mean * local_mean);
                const double threshold = local_mean * (1 + .18 * (std::sqrt(variance) / 128 - 1));
                target = value <= threshold ? 0 : 255;
            } else {
                const double edge = value - (gray.at<uint8_t>(y, std::max(0, x - 1)) +
                                             gray.at<uint8_t>(y, std::min(image.cols - 1, x + 1)) +
                                             gray.at<uint8_t>(std::max(0, y - 1), x) +
                                             gray.at<uint8_t>(std::min(image.rows - 1, y + 1), x)) /
                                                4.0;
                const double local_difference = value - local_mean,
                             dark = local_difference < -5 ? (local_difference + 5) * .34 : 0;
                target = std::clamp(
                    value + std::clamp((dark - std::max(0.0, -edge - 3) * 1.05) * plan.sharpen, -46.0, 0.0),
                    0.0, 255.0);
            }
            if (mode == DS_FILTER_AUTO) {
                const int minimum = std::min({row[x][0], row[x][1], row[x][2]}),
                          maximum = std::max({row[x][0], row[x][1], row[x][2]});
                const double delta =
                    std::clamp(target - value, double(-minimum), double(std::max(0, 248 - maximum)));
                for (int c = 0; c < 3; ++c)
                    row[x][c] = byte(row[x][c] + delta);
            } else
                row[x] = {byte(target), byte(target), byte(target)};
            const int leaving = x - radius, entering = x + radius + 1;
            if (leaving >= 0) {
                sum -= columns[leaving];
                if (!squares.empty())
                    squared_sum -= squares[leaving];
            }
            if (entering < image.cols) {
                sum += columns[entering];
                if (!squares.empty())
                    squared_sum += squares[entering];
            }
        }
    }
}
} // namespace docscan
