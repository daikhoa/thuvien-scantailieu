#include "opencv-raster.hpp"
#include <iostream>
#include <memory>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <stdexcept>
void expect(bool condition, const char *message) {
    if (!condition)
        throw std::runtime_error(message);
}
int main() {
    try {
        std::atomic<bool> cancel{false};
        const docscan::Quad square{{{0, 0}, {64, 0}, {64, 64}, {0, 64}}};
        cv::Mat source(64, 64, CV_8UC3);
        cv::randu(source, cv::Scalar(1, 1, 1), cv::Scalar(254, 254, 254));
        const auto saved = source.clone();
        auto output = docscan::warp_opencv(source, square, 3000, cancel);
        expect(output.size() == source.size(), "Identity dimensions");
        expect(cv::norm(output, source, cv::NORM_INF) == 0, "Identity changes pixels");
        expect(cv::norm(source, saved, cv::NORM_INF) == 0, "Mutated input");
        const docscan::Quad skew{{{8, 8}, {56, 12}, {60, 58}, {4, 54}}};
        output = docscan::warp_opencv(source, skew, 3000, cancel);
        expect(output.size() == docscan::output_size(skew, source.size(), 3000), "Different sizing policy");
        bool rejected = false;
        try {
            auto invalid = square;
            std::swap(invalid[1], invalid[2]);
            docscan::warp_opencv(source, invalid, 3000, cancel);
        } catch (const docscan::Failure &e) {
            rejected = e.status == DS_INVALID_ARGUMENT;
        }
        expect(rejected, "Invalid crop accepted");
        for (const auto preset : {DS_OPENCV_GENTLE, DS_OPENCV_BALANCED, DS_OPENCV_TEXT}) {
            for (int value : {0, 128, 255}) {
                cv::Mat uniform(64, 64, CV_8UC3, cv::Scalar(value, value, value));
                docscan::enhance_opencv(uniform, preset, cancel);
                expect(cv::norm(uniform, cv::Mat(uniform.size(), CV_8UC3, cv::Scalar(value, value, value)),
                                cv::NORM_INF) == 0,
                       "Uniform field amplified");
            }
            auto image = source.clone();
            docscan::enhance_opencv(image, preset, cancel);
            for (size_t i = 0; i < image.total() * 3; ++i)
                expect(image.data[i] > 0 && image.data[i] < 255, "New clipped channel");
            for (size_t i = 0; i < image.total(); ++i) {
                const auto before = source.ptr<cv::Vec3b>()[i], after = image.ptr<cv::Vec3b>()[i];
                expect(int(before[0]) - before[1] == int(after[0]) - after[1] &&
                           int(before[1]) - before[2] == int(after[1]) - after[2],
                       "Filter changed RGB channel differences");
            }
            for (const auto size : {cv::Size(1, 3000), cv::Size(3000, 1)}) {
                cv::Mat thin(size, CV_8UC3);
                cv::randu(thin, cv::Scalar(70, 70, 70), cv::Scalar(240, 240, 240));
                docscan::enhance_opencv(thin, preset, cancel);
                expect(thin.size() == size, "Thin image dimensions changed");
            }
        }
        cv::Mat text(192, 192, CV_8UC3, cv::Scalar(220, 220, 220));
        for (int y = 20; y < 180; y += 20)
            cv::line(text, {10, y}, {180, y}, cv::Scalar(125, 125, 125), 2);
        const auto text_saved = text.clone();
        docscan::enhance_opencv(text, DS_OPENCV_BALANCED, cancel);
        expect(cv::norm(text, text_saved, cv::NORM_INF) > 0, "Contrast preset did nothing");
        // A page under a smooth shadow should be more even without throwing away ink.
        cv::Mat shaded(256, 384, CV_8UC3);
        for (int y = 0; y < shaded.rows; ++y)
            for (int x = 0; x < shaded.cols; ++x) {
                const int paper = 110 + x * 120 / (shaded.cols - 1);
                const bool ink = y > 20 && y < 235 && y % 24 < 3 && x > 20 && x < 360;
                const int v = ink ? paper / 3 : paper;
                shaded.at<cv::Vec3b>(y, x) = cv::Vec3b(v, v, v);
            }
        const int original_spread = shaded.at<cv::Vec3b>(8, 370)[0] - shaded.at<cv::Vec3b>(8, 12)[0];
        docscan::enhance_opencv(shaded, DS_OPENCV_BALANCED, cancel);
        const int final_spread = shaded.at<cv::Vec3b>(8, 370)[0] - shaded.at<cv::Vec3b>(8, 12)[0];
        expect(final_spread < original_spread * .75, "Shadowed paper is still uneven");
        expect(shaded.at<cv::Vec3b>(8, 12)[0] >= 150, "Shadowed paper was not lifted");
        expect(shaded.at<cv::Vec3b>(48, 100)[0] + 45 < shaded.at<cv::Vec3b>(44, 100)[0],
               "Illumination correction erased ink");
        cv::Mat noisy(256, 384, CV_8UC3);
        cv::RNG random(7931);
        for (int y = 0; y < noisy.rows; ++y)
            for (int x = 0; x < noisy.cols; ++x) {
                const auto value = static_cast<uint8_t>(220 + random.uniform(-9, 10));
                noisy.at<cv::Vec3b>(y, x) = cv::Vec3b(value, value, value);
            }
        cv::Scalar noise_mean, noise_before, noise_after;
        cv::meanStdDev(noisy, noise_mean, noise_before);
        docscan::enhance_opencv(noisy, DS_OPENCV_TEXT, cancel);
        cv::meanStdDev(noisy, noise_mean, noise_after);
        expect(noise_after[0] <= noise_before[0] * 1.1, "Noise was amplified on blank paper");
        cancel.store(true);
        rejected = false;
        try {
            docscan::warp_opencv(source, square, 3000, cancel);
        } catch (const docscan::Failure &e) {
            rejected = e.status == DS_CANCELLED;
        }
        expect(rejected, "Warp ignored cancellation");
        rejected = false;
        try {
            docscan::enhance_opencv(source, DS_OPENCV_BALANCED, cancel);
        } catch (const docscan::Failure &e) {
            rejected = e.status == DS_CANCELLED;
        }
        expect(rejected, "Filter ignored cancellation");
        ds_engine_config config;
        ds_engine_config_init(&config);
        ds_engine *engine_raw = nullptr;
        expect(ds_engine_create(&config, &engine_raw) == DS_OK, "Create API engine");
        std::unique_ptr<ds_engine, decltype(&ds_engine_destroy)> engine(engine_raw, ds_engine_destroy);
        ds_document *document_raw = nullptr;
        expect(ds_document_create(engine.get(), &document_raw) == DS_OK, "Create API document");
        std::unique_ptr<ds_document, decltype(&ds_document_destroy)> document(document_raw,
                                                                              ds_document_destroy);
        std::vector<uint8_t> encoded;
        expect(cv::imencode(".png", saved, encoded), "Create API fixture");
        const ds_bytes bytes{encoded.data(), static_cast<uint64_t>(encoded.size())};
        ds_page_options options;
        ds_page_options_init(&options);
        options.crop_mode = DS_CROP_FULL_FRAME;
        uint32_t index = 0;
        expect(ds_document_add_image_opencv(document.get(), bytes, &options,
                                            static_cast<ds_opencv_preset>(99),
                                            &index) == DS_INVALID_ARGUMENT &&
                   index == UINT32_MAX,
               "Invalid preset accepted");
        options.filter = DS_FILTER_GRAYSCALE;
        expect(ds_document_add_image_opencv(document.get(), bytes, &options, DS_OPENCV_BALANCED, &index) ==
                       DS_INVALID_ARGUMENT &&
                   ds_document_page_count(document.get()) == 0,
               "Unsupported mode changed document");
        options.filter = DS_FILTER_ENHANCED_COLOR;
        ds_document_cancel(document.get());
        expect(ds_document_add_image_opencv(document.get(), bytes, &options, DS_OPENCV_BALANCED, &index) ==
                   DS_CANCELLED,
               "API ignored cancellation");
        expect(ds_document_reset_cancel(document.get()) == DS_OK, "Reset cancellation");
        for (const auto preset : {DS_OPENCV_GENTLE, DS_OPENCV_BALANCED, DS_OPENCV_TEXT}) {
            expect(ds_document_add_image_opencv(document.get(), bytes, &options, preset, &index) == DS_OK,
                   "OpenCV API failed");
            const ds_page_info *info = nullptr;
            ds_bytes jpeg{};
            expect(ds_document_get_page(document.get(), index, &info, &jpeg) == DS_OK && info &&
                       info->width == 64 && info->height == 64 && jpeg.size > 0,
                   "OpenCV API result invalid");
        }
        expect(ds_document_page_count(document.get()) == 3, "API did not append atomically");
        ds_buffer *pdf = nullptr;
        expect(ds_document_pdf(document.get(), &pdf) == DS_OK && pdf, "OpenCV PDF failed");
        ds_buffer_destroy(pdf);
        std::cout << "OpenCV geometry/contrast/resource contracts passed\n";
        return 0;
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
