#include "internal.hpp"
#include "corner-refinement.hpp"
#include <algorithm>
#include <cmath>
#include <filesystem>
#include <limits>
#include <opencv2/imgproc.hpp>
namespace docscan {
namespace {
constexpr double means[3] = {.485, .456, .406}, deviations[3] = {.229, .224, .225};
double sigmoid(double x) {
    return 1.0 / (1.0 + std::exp(-x));
}
std::unique_ptr<Ort::Session> session(Engine &e, const std::filesystem::path &path) {
    Ort::SessionOptions options;
    options.SetIntraOpNumThreads(1);
    options.SetInterOpNumThreads(1);
    options.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
    options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
    options.AddConfigEntry("session.intra_op.allow_spinning", "0");
    return std::make_unique<Ort::Session>(e.environment, path.c_str(), options);
}
void validate_model(Ort::Session &model, const char *input, const std::vector<int64_t> &shape,
                    const std::vector<std::string> &outputs) {
    require(model.GetInputCount() == 1 && model.GetOutputCount() == outputs.size(), DS_MODEL_UNAVAILABLE);
    Ort::AllocatorWithDefaultOptions allocator;
    require(std::string(model.GetInputNameAllocated(0, allocator).get()) == input, DS_MODEL_UNAVAILABLE);
    auto type = model.GetInputTypeInfo(0);
    auto tensor = type.GetTensorTypeAndShapeInfo();
    require(tensor.GetElementType() == ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT && tensor.GetShape() == shape,
            DS_MODEL_UNAVAILABLE);
    for (size_t i = 0; i < outputs.size(); ++i) {
        require(std::string(model.GetOutputNameAllocated(i, allocator).get()) == outputs[i],
                DS_MODEL_UNAVAILABLE);
        auto output_type = model.GetOutputTypeInfo(i);
        require(output_type.GetTensorTypeAndShapeInfo().GetElementType() ==
                    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT,
                DS_MODEL_UNAVAILABLE);
    }
}
std::vector<float> tensor_data(const cv::Mat &source, bool nhwc) {
    cv::Mat sample;
    cv::resize(source, sample, {224, 224}, 0, 0, nhwc ? cv::INTER_AREA : cv::INTER_LINEAR);
    const size_t plane = 224 * 224;
    std::vector<float> data(plane * 3);
    for (int y = 0; y < 224; ++y) {
        const auto *row = sample.ptr<cv::Vec3b>(y);
        for (int x = 0; x < 224; ++x)
            for (size_t c = 0; c < 3; ++c) {
                const size_t i = static_cast<size_t>(y) * 224 + x;
                data[nhwc ? i * 3 + c : c * plane + i] =
                    static_cast<float>((row[x][static_cast<int>(2 - c)] / 255.0 - means[c]) / deviations[c]);
            }
    }
    return data;
}
} // namespace
void initialize_runtime() {
    static std::once_flag once;
    std::call_once(once, [] {
        const OrtApi *api = OrtGetApiBase()->GetApi(ORT_API_VERSION);
        require(api != nullptr, DS_MODEL_UNAVAILABLE);
        Ort::InitApi(api);
    });
}
Engine::Engine(const ds_engine_config &settings) : config(settings) {
    config.model_directory = nullptr;
    if (settings.model_directory && settings.model_directory[0]) {
        try {
            const auto root = std::filesystem::u8path(settings.model_directory);
            const auto shadow_file = root / "gcnet-2eb69a0a.onnx";
            if (std::filesystem::is_regular_file(shadow_file)) shadow_path = shadow_file.u8string();
            corner = session(*this, root / "doccornernet_lean.ort");
            defect = session(*this, root / "document-defects.onnx");
            validate_model(*corner, "input", {1, 224, 224, 3}, {"coords", "score_logit"});
            validate_model(*defect, "image", {-1, 3, 224, 224}, {"logits"});
        } catch (const std::bad_alloc &) {
            throw;
        } catch (...) {
            throw Failure(DS_MODEL_UNAVAILABLE);
        }
    }
}
static Detection detect_once(Engine &engine, const cv::Mat &source, const std::atomic<bool> &cancel) {
    require(engine.corner != nullptr, DS_MODEL_UNAVAILABLE);
    check_cancel(cancel);
    auto data = tensor_data(source, true);
    const std::array<int64_t, 4> shape{1, 224, 224, 3};
    auto memory = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    auto tensor =
        Ort::Value::CreateTensor<float>(memory, data.data(), data.size(), shape.data(), shape.size());
    const char *input = "input";
    const char *outputs[] = {"coords", "score_logit"};
    std::lock_guard<std::mutex> lock(engine.inference_mutex);
    check_cancel(cancel);
    auto result = engine.corner->Run(Ort::RunOptions{}, &input, &tensor, 1, outputs, 2);
    check_cancel(cancel);
    require(result[0].IsTensor() && result[1].IsTensor(), DS_PROCESSING_FAILED);
    require(result[0].GetTensorTypeAndShapeInfo().GetElementCount() == 8 &&
                result[1].GetTensorTypeAndShapeInfo().GetElementCount() == 1,
            DS_PROCESSING_FAILED);
    const auto *coordinates = result[0].GetTensorData<float>();
    const float logit = result[1].GetTensorData<float>()[0];
    require(std::isfinite(logit), DS_PROCESSING_FAILED);
    Detection detected;
    detected.confidence = sigmoid(logit);
    for (size_t i = 0; i < 4; ++i) {
        require(std::isfinite(coordinates[2 * i]) && std::isfinite(coordinates[2 * i + 1]),
                DS_PROCESSING_FAILED);
        detected.corners[i] = {coordinates[2 * i] * source.cols, coordinates[2 * i + 1] * source.rows};
    }
    detected.found = detected.confidence >= .5;
    return detected;
}
Detection detect(Engine &engine, const cv::Mat &source, const std::atomic<bool> &cancel) {
    cv::Mat working;
    const double scale = std::min(1.0, 960.0 / std::max(source.cols, source.rows));
    if (scale < 1) cv::resize(source, working, {}, scale, scale, cv::INTER_AREA);
    else working = source;
    Detection fallback;
    for (int attempt = 0; attempt < 2; ++attempt) {
        const int offset_x = attempt ? int(working.cols * .15) : 0,
                  offset_y = attempt ? int(working.rows * .15) : 0;
        const cv::Rect region{offset_x, offset_y, working.cols - offset_x * 2, working.rows - offset_y * 2};
        const auto local = working(region);
        auto result = detect_once(engine, local, cancel);
        if (!attempt) fallback = result;
        const auto refined = refine_document_corners(local, result.corners, cancel);
        const auto action = corner_action(result.confidence, refined.support);
        if (action == CornerAction::reject) continue;
        if (refined.support >= minimum_corner_support) result.corners = refined.corners;
        if (attempt && std::any_of(result.corners.begin(), result.corners.end(), [&](const auto &p) {
            return p.x < local.cols * .02 || p.y < local.rows * .02 ||
                   p.x > local.cols * .98 || p.y > local.rows * .98;
        })) break;
        if (action == CornerAction::verify) {
            double left = local.cols, top = local.rows, right = 0, bottom = 0;
            for (const auto &p : result.corners) {
                left = std::min(left, p.x); top = std::min(top, p.y);
                right = std::max(right, p.x); bottom = std::max(bottom, p.y);
            }
            const double width = right - left, height = bottom - top;
            const int x = std::clamp(int(std::floor(left - width * .2)), 0, local.cols - 1),
                      y = std::clamp(int(std::floor(top - height * .2)), 0, local.rows - 1),
                      end_x = std::clamp(int(std::ceil(right + width * .2)), x + 1, local.cols),
                      end_y = std::clamp(int(std::ceil(bottom + height * .2)), y + 1, local.rows);
            auto confirmation = detect_once(engine, local(cv::Rect{x, y, end_x - x, end_y - y}), cancel);
            for (auto &p : confirmation.corners) p += cv::Point2d{double(x), double(y)};
            if (!confirm_document_corners(result.corners, confirmation.corners, confirmation.confidence)) continue;
            result.confidence = confirmation.confidence;
        }
        result.found = true;
        for (auto &p : result.corners) {
            p.x = (p.x + offset_x) * source.cols / working.cols;
            p.y = (p.y + offset_y) * source.rows / working.rows;
        }
        return result;
    }
    fallback.found = false;
    return fallback;
}

Plan analyze(Engine &engine, const cv::Mat &sample, const std::atomic<bool> &cancel) {
    check_cancel(cancel);
    const auto quality = measure(sample);
    std::array<double, 7> scores{};
    if (!engine.defect) {
        auto plan = make_plan(scores, quality);
        plan.warnings |= DS_WARN_CLASSIFIER_UNAVAILABLE;
        return plan;
    }
    try {
        auto data = tensor_data(sample, false);
        const std::array<int64_t, 4> shape{1, 3, 224, 224};
        auto memory = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
        auto tensor =
            Ort::Value::CreateTensor<float>(memory, data.data(), data.size(), shape.data(), shape.size());
        const char *input = "image";
        const char *output = "logits";
        std::lock_guard<std::mutex> lock(engine.inference_mutex);
        check_cancel(cancel);
        auto result = engine.defect->Run(Ort::RunOptions{}, &input, &tensor, 1, &output, 1);
        check_cancel(cancel);
        require(result[0].IsTensor() && result[0].GetTensorTypeAndShapeInfo().GetElementCount() == 7,
                DS_PROCESSING_FAILED);
        const auto *logits = result[0].GetTensorData<float>();
        for (size_t i = 0; i < 7; ++i) {
            require(std::isfinite(logits[i]), DS_PROCESSING_FAILED);
            scores[i] = sigmoid(logits[i]);
        }
        return make_plan(scores, quality);
    } catch (const Failure &e) {
        if (e.status == DS_CANCELLED)
            throw;
    } catch (const Ort::Exception &) {
    }
    scores.fill(0);
    auto plan = make_plan(scores, quality);
    plan.warnings |= DS_WARN_CLASSIFIER_UNAVAILABLE;
    return plan;
}
} // namespace docscan
