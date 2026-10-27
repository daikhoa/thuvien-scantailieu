#include "adaptive-enhancement.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
using namespace docscan;
std::vector<uint8_t> read(const std::filesystem::path &p) {
    std::ifstream f(p, std::ios::binary);
    if (!f)
        throw std::runtime_error("fixture");
    return {std::istreambuf_iterator<char>(f), {}};
}
int main(int argc, char **argv) {
    try {
        if (argc != 2)
            throw std::runtime_error("args");
        std::atomic<bool> cancel{false};
        for (const std::string kind : {"shadow", "gray", "green", "grid"}) {
            auto source = read(std::filesystem::path(argv[1]) / (kind + "-source.rgba")),
                 expected = read(std::filesystem::path(argv[1]) / (kind + "-expected.rgba"));
            cv::Mat image(512, 384, CV_8UC3);
            for (int y = 0; y < 512; ++y)
                for (int x = 0; x < 384; ++x) {
                    const auto at = (y * 384 + x) * 4;
                    image.at<cv::Vec3b>(y, x) = {source[at + 2], source[at + 1], source[at]};
                }
            const auto sample = shadow_sample(image, cancel);
            auto field = sample;
            const int plane = sample.width * sample.height;
            for (int c = 0; c < 3; ++c)
                for (int y = 0; y < sample.height; ++y)
                    for (int x = 0; x < sample.width; ++x) {
                        bool dark = kind == "gray" ? (double(y) / sample.height > 170.0 / 512 &&
                                                      double(y) / sample.height < 350.0 / 512)
                                                   : x >= sample.width / 2;
                        field.data[c * plane + y * sample.width + x] = float((dark ? 110.0 : 235.0) / 255);
                    }
            const auto plan = enhancement_plan(sample, kind == "gray" || kind == "shadow" ? &field : nullptr,
                                               kind == "grid" ? .5 : 0);
            if (kind == "shadow" && !plan.needs_model)
                throw std::runtime_error("shadow not detected");
            apply_enhancement(image, plan, cancel);
            int max_error = 0;
            for (int y = 0; y < 512; ++y)
                for (int x = 0; x < 384; ++x)
                    for (int c = 0; c < 3; ++c)
                        max_error = std::max(max_error, std::abs(int(image.at<cv::Vec3b>(y, x)[c]) -
                                                                 expected[(y * 384 + x) * 4 + 2 - c]));
            if (max_error > 1)
                throw std::runtime_error("pixel parity " + kind + ":" + std::to_string(max_error));
            std::cout << kind << " max channel delta " << max_error << '\n';
        }
        cancel = true;
        cv::Mat im(32, 32, CV_8UC3);
        try {
            shadow_sample(im, cancel);
            throw std::runtime_error("cancel ignored");
        } catch (const Failure &e) {
            if (e.status != DS_CANCELLED)
                throw;
        }
        return 0;
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
