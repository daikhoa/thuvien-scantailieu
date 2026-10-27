#include "internal.hpp"
#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <opencv2/imgcodecs.hpp>
#include <sstream>
int main(int argc, char **argv) {
    if (argc != 2)
        return 1;
    const std::filesystem::path root = argv[1];
    std::ifstream cases(root / "cases.txt");
    std::string line;
    int tested = 0;
    try {
        while (std::getline(cases, line)) {
            std::istringstream row(line);
            std::string name, source_name, expected_name, kind;
            row >> name >> source_name >> expected_name >> kind;
            auto source = cv::imread((root / source_name).string());
            const auto expected = cv::imread((root / expected_name).string());
            if (source.empty() || expected.empty())
                throw std::runtime_error("Missing pixel fixture");
            std::atomic<bool> cancelled{false};
            cv::Mat actual;
            if (kind == "warp") {
                uint32_t maximum;
                docscan::Quad quad;
                row >> maximum;
                for (auto &p : quad)
                    row >> p.x >> p.y;
                actual = docscan::warp(source, quad, maximum, cancelled);
            } else {
                int mode;
                docscan::Plan plan;
                row >> mode >> plan.protect_color >> plan.shadow >> plan.lift >> plan.contrast >>
                    plan.sharpen >> plan.smooth;
                auto &q = plan.quality;
                row >> q.mean >> q.dark >> q.bright >> q.background_dark >> q.background_bright >> q.edge >>
                    q.periodic;
                q.illumination = q.background_bright - q.background_dark;
                q.highlight = 0;
                actual = source.clone();
                docscan::enhance(actual, mode, plan, cancelled);
            }
            if (!row || actual.size() != expected.size())
                throw std::runtime_error(name + ": dimensions/fixture mismatch");
            int maximum = 0;
            double error = 0;
            for (int y = 0; y < actual.rows; ++y)
                for (int x = 0; x < actual.cols * 3; ++x) {
                    const int d = std::abs(int(actual.ptr<uint8_t>(y)[x]) - expected.ptr<uint8_t>(y)[x]);
                    maximum = std::max(maximum, d);
                    error += d;
                }
            const double mean = error / (actual.total() * 3);
            std::cout << name << ": max=" << maximum << ", mean=" << mean << '\n';
            if (maximum > 1 || mean > .05)
                throw std::runtime_error(name + ": differs from web golden pixels");
            ++tested;
        }
        // A faint colored field must not activate the neutral-ink contrast policy.
        cv::Mat colored(48, 64, CV_8UC3);
        for (int y = 0; y < colored.rows; ++y)
            for (int x = 0; x < colored.cols; ++x) {
                const uint8_t value = x % 16 < 2 ? 200 : 220;
                colored.at<cv::Vec3b>(y, x) = cv::Vec3b(value - 40, value - 40, value);
            }
        docscan::Plan color_plan;
        color_plan.quality.dark = 200;
        color_plan.quality.bright = 220;
        color_plan.quality.edge = 2;
        color_plan.quality.periodic = 0;
        color_plan.quality.color = true;
        auto guarded = colored.clone();
        std::atomic<bool> cancelled{false};
        docscan::enhance(guarded, DS_FILTER_ENHANCED_COLOR, color_plan, cancelled);
        if (cv::norm(colored, guarded, cv::NORM_INF) != 0)
            throw std::runtime_error("Faint color protection changed pixels");
        if (tested != 24)
            throw std::runtime_error("Unexpected fixture count");
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
