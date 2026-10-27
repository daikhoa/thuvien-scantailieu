#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <opencv2/core.hpp>
namespace docscan {
// Same D65 lookup tables and highlight rolloff as the web reference.
class Lab {
    static constexpr int resolution = 8192;
    std::array<float, 256> linear{};
    std::array<float, resolution + 1> cie{};
    std::array<uint8_t, resolution + 1> encoded{};
    static size_t index(double value) {
        return static_cast<size_t>(std::clamp(std::lround(value * resolution), 0l, long(resolution)));
    }
    double f(double value) const {
        return cie[index(value)];
    }
    static double inverse(double value) {
        return value > 6.0 / 29 ? value * value * value : 3 * std::pow(6.0 / 29, 2) * (value - 4.0 / 29);
    }
    double rgb(double value) const {
        return encoded[index(value)];
    }

  public:
    Lab() {
        for (int i = 0; i <= resolution; ++i) {
            const double v = double(i) / resolution;
            encoded[i] = static_cast<uint8_t>(
                std::lround(255 * (v <= .0031308 ? 12.92 * v : 1.055 * std::pow(v, 1 / 2.4) - .055)));
            cie[i] = static_cast<float>(v > 216.0 / 24389 ? std::cbrt(v) : ((24389.0 / 27) * v + 16) / 116);
        }
        for (int i = 0; i < 256; ++i) {
            const double v = i / 255.0;
            linear[i] = static_cast<float>(v <= .04045 ? v / 12.92 : std::pow((v + .055) / 1.055, 2.4));
        }
    }
    double lightness(const cv::Vec3b &p) const {
        return (116 * f(.2126729 * linear[p[2]] + .7151522 * linear[p[1]] + .072175 * linear[p[0]]) - 16) *
               2.55;
    }
    void adjust(cv::Vec3b &p, double amount) const {
        if (std::abs(amount) < .3)
            return;
        const double r = linear[p[2]], g = linear[p[1]], b = linear[p[0]];
        const double fx = f((.4124564 * r + .3575761 * g + .1804375 * b) / .95047),
                     fy = f(.2126729 * r + .7151522 * g + .072175 * b),
                     fz = f((.0193339 * r + .119192 * g + .9503041 * b) / 1.08883);
        const double delta = amount / (2.55 * 116), x = .95047 * inverse(fx + delta), y = inverse(fy + delta),
                     z = 1.08883 * inverse(fz + delta);
        const double cr = rgb(3.2404542 * x - 1.5371385 * y - .4985314 * z),
                     cg = rgb(-.969266 * x + 1.8760108 * y + .041556 * z),
                     cb = rgb(.0556434 * x - .2040259 * y + 1.0572252 * z);
        const int maximum = std::max({p[0], p[1], p[2]});
        const double gain =
            amount > 0
                ? std::min(1.0, std::max(0, 248 - maximum) / std::max(1.0, std::max({cr, cg, cb}) - maximum))
                : 1;
        // Uint8ClampedArray uses ties-to-even, matching cv::saturate_cast.
        p = {cv::saturate_cast<uint8_t>(p[0] + (cb - p[0]) * gain),
             cv::saturate_cast<uint8_t>(p[1] + (cg - p[1]) * gain),
             cv::saturate_cast<uint8_t>(p[2] + (cr - p[2]) * gain)};
    }
};
inline const Lab &lab() {
    static const Lab value;
    return value;
}
} // namespace docscan
