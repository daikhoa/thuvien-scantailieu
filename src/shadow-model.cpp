#include "internal.hpp"
#include <algorithm>
#include <cmath>
#include <filesystem>
namespace docscan {
namespace {
std::unique_ptr<Ort::Session> load_shadow(Engine &engine) {
    require(!engine.shadow_path.empty(), DS_MODEL_UNAVAILABLE);
    Ort::SessionOptions options;
    options.SetIntraOpNumThreads(1);
    options.SetInterOpNumThreads(1);
    options.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
    options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
    options.DisableCpuMemArena();
    options.DisableMemPattern();
    options.AddConfigEntry("session.intra_op.allow_spinning", "0");
    try {
        auto model = std::make_unique<Ort::Session>(
            engine.environment, std::filesystem::u8path(engine.shadow_path).c_str(), options);
        require(model->GetInputCount() == 1 && model->GetOutputCount() == 1, DS_MODEL_UNAVAILABLE);
        Ort::AllocatorWithDefaultOptions allocator;
        require(std::string(model->GetInputNameAllocated(0, allocator).get()) == "input" &&
                    std::string(model->GetOutputNameAllocated(0, allocator).get()) == "output",
                DS_MODEL_UNAVAILABLE);
        auto type = model->GetInputTypeInfo(0);
        auto tensor = type.GetTensorTypeAndShapeInfo();
        require(tensor.GetElementType() == ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT &&
                    tensor.GetShape() == std::vector<int64_t>({-1, 3, -1, -1}),
                DS_MODEL_UNAVAILABLE);
        return model;
    } catch (const Ort::Exception &) {
        throw Failure(DS_MODEL_UNAVAILABLE);
    }
}
} // namespace
ShadowField predict_shadow(Engine &engine, const ShadowField &sample, const std::atomic<bool> &cancel) {
    check_cancel(cancel);
    require(!engine.shadow_path.empty(), DS_MODEL_UNAVAILABLE);
    const int width = sample.width, height = sample.height;
    const auto &input = sample.data;
    const std::array<int64_t, 4> shape{1, 3, height, width};
    auto memory = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    auto tensor = Ort::Value::CreateTensor<float>(memory, const_cast<float *>(input.data()), input.size(),
                                                  shape.data(), shape.size());
    const char *in_name = "input", *out_name = "output";
    std::unique_lock<std::mutex> lock(engine.inference_mutex);
    check_cancel(cancel);
    if (!engine.shadow)
        engine.shadow = load_shadow(engine);
    auto result = engine.shadow->Run(Ort::RunOptions{}, &in_name, &tensor, 1, &out_name, 1);
    check_cancel(cancel);
    require(result[0].IsTensor(), DS_PROCESSING_FAILED);
    auto out = result[0].GetTensorTypeAndShapeInfo();
    require(out.GetElementType() == ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT &&
                out.GetShape() == std::vector<int64_t>(shape.begin(), shape.end()),
            DS_PROCESSING_FAILED);
    const float *field = result[0].GetTensorData<float>();
    // Reject all corrupt output before touching caller-owned pixels.
    for (size_t i = 0; i < input.size(); ++i)
        require(std::isfinite(field[i]) && field[i] > 0 && field[i] <= 1.5f, DS_PROCESSING_FAILED);
    ShadowField output{width, height, std::vector<float>(field, field + input.size())};
    return output;
}
void correct_shadow(Engine &engine, cv::Mat &image, const std::atomic<bool> &cancel) {
    require(image.total() * 3 + 64ull * 1024 * 1024 <= engine.config.working_memory_bytes, DS_LIMIT_EXCEEDED);
    const auto sample = shadow_sample(image, cancel);
    const auto prediction = predict_shadow(engine, sample, cancel);
    apply_shadow_illumination(image, prediction, cancel);
}
} // namespace docscan
