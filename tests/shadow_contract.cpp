#include <docscan/docscan.h>
#include <iostream>
#include <opencv2/imgcodecs.hpp>
#include <stdexcept>
#include <vector>
#define CHECK(x)                                                                                             \
    do {                                                                                                     \
        if (!(x))                                                                                            \
            throw std::runtime_error(#x);                                                                    \
    } while (0)
int main(int argc, char **argv) {
    try {
        CHECK(argc == 2);
        cv::Mat source(768, 576, CV_8UC3);
        for (int y = 0; y < source.rows; ++y)
            for (int x = 0; x < source.cols; ++x) {
                const auto v = static_cast<uint8_t>(244 - 110.0 * std::max(0.0, (x - 160) / 416.0) *
                                                              std::min(1.0, y / 400.0));
                source.at<cv::Vec3b>(y, x) = {v, v, v};
                if (y % 24 < 3 && x > 40 && x < 530)
                    source.at<cv::Vec3b>(y, x) = {30, 30, 30};
            }
        std::vector<uint8_t> encoded;
        CHECK(cv::imencode(".png", source, encoded));
        ds_engine_config config;
        ds_engine_config_init(&config);
        ds_page_options options;
        ds_page_options_init(&options);
        options.filter = DS_FILTER_SHADOW_REMOVAL;
        options.crop_mode = DS_CROP_FULL_FRAME;
        for (int with_model = 0; with_model < 2; ++with_model) {
            config.model_directory = with_model ? argv[1] : nullptr;
            ds_engine *engine = nullptr;
            CHECK(ds_engine_create(&config, &engine) == DS_OK);
            CHECK(bool(ds_engine_capabilities(engine) & DS_CAP_SHADOW_MODEL) == bool(with_model));
            ds_document *document = nullptr;
            CHECK(ds_document_create(engine, &document) == DS_OK);
            uint32_t index = 9;
            const auto status =
                ds_document_add_image(document, {encoded.data(), encoded.size()}, &options, &index);
            if (!with_model) {
                CHECK(status == DS_MODEL_UNAVAILABLE);
                CHECK(ds_document_page_count(document) == 0);
            } else {
                CHECK(status == DS_OK);
                CHECK(index == 0);
                const ds_page_info *info = nullptr;
                ds_bytes jpeg{};
                CHECK(ds_document_get_page(document, 0, &info, &jpeg) == DS_OK);
                CHECK(info->width == 576 && info->height == 768);
                cv::Mat bytes(1, int(jpeg.size), CV_8U, const_cast<uint8_t *>(jpeg.data));
                const auto result = cv::imdecode(bytes, cv::IMREAD_COLOR);
                CHECK(!result.empty());
                CHECK(result.at<cv::Vec3b>(500, 450)[0] > source.at<cv::Vec3b>(500, 450)[0] + 20);
                ds_document_cancel(document);
                CHECK(ds_document_add_image(document, {encoded.data(), encoded.size()}, &options, &index) ==
                      DS_CANCELLED);
                CHECK(ds_document_page_count(document) == 1);
            }
            ds_document_destroy(document);
            CHECK(ds_document_create(engine, &document) == DS_OK);
            options.filter = DS_FILTER_ENHANCED_COLOR;
            CHECK(ds_document_add_image(document, {encoded.data(), encoded.size()}, &options, &index) ==
                  DS_OK);
            const ds_page_info *adaptive_info = nullptr;
            ds_bytes adaptive_jpeg{};
            CHECK(ds_document_get_page(document, 0, &adaptive_info, &adaptive_jpeg) == DS_OK);
            CHECK(bool(adaptive_info->warnings & DS_WARN_SHADOW_UNAVAILABLE) == !bool(with_model));
            CHECK(adaptive_info->width == 576 && adaptive_info->height == 768);
            options.filter = DS_FILTER_SHADOW_REMOVAL;
            ds_document_destroy(document);
            ds_engine_destroy(engine);
        }
        std::cout << "Pretrained shadow C ABI / real ONNX / missing model / cancellation passed\n";
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
