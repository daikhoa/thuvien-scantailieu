#include "paper-restoration.hpp"
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <opencv2/imgcodecs.hpp>
int main(int argc, char **argv) {
    try {
        if (argc != 2)
            throw std::runtime_error("Need fixture directory");
        const std::filesystem::path root(argv[1]);
        std::ifstream cases(root / "cases.txt");
        if (!cases)
            throw std::runtime_error("Missing paper fixtures");
        std::atomic<bool> cancel{false};
        std::string kind;
        int count = 0;
        while (std::getline(cases, kind)) {
            if (kind.empty())
                continue;
            auto image = cv::imread((root / (kind + "-input.ppm")).string()),
                 expected = cv::imread((root / (kind + "-policy.ppm")).string());
            if (image.empty() || image.size() != expected.size())
                throw std::runtime_error("Invalid paper fixture " + kind);
            docscan::restore_paper(image, cancel);
            double sum = 0;
            int maximum = 0;
            for (int y = 0; y < image.rows; ++y)
                for (int x = 0; x < image.cols; ++x)
                    for (int c = 0; c < 3; ++c) {
                        const int delta =
                            std::abs(int(image.at<cv::Vec3b>(y, x)[c]) - expected.at<cv::Vec3b>(y, x)[c]);
                        maximum = std::max(maximum, delta);
                        sum += delta;
                    }
            if (maximum > 1 || sum / (image.total() * 3) > .05)
                throw std::runtime_error("Paper pixel parity " + kind);
            ++count;
        }
        if (count != 17)
            throw std::runtime_error("Paper fixture count changed");
        cv::Mat image(192, 192, CV_8UC3, cv::Scalar(220, 220, 220));
        cancel = true;
        try {
            docscan::restore_paper(image, cancel);
            throw std::runtime_error("Cancellation ignored");
        } catch (const docscan::Failure &failure) {
            if (failure.status != DS_CANCELLED)
                throw;
        }
        std::cout << count << " paper/color/native parity fixtures and cancellation passed\n";
        return 0;
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
