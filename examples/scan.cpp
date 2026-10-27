#include <docscan/docscan.h>
#include <fstream>
#include <iostream>
#include <iterator>
#include <memory>
#include <stdexcept>
#include <vector>
namespace {
void check(ds_status status) {
    if (status != DS_OK)
        throw std::runtime_error(ds_status_message(status));
}
} // namespace
int main(int argc, char **argv) {
    if (argc < 4) {
        std::cerr << "Usage: docscan_cli MODEL_DIRECTORY OUTPUT.pdf INPUT_IMAGE [INPUT_IMAGE ...]\n";
        return 2;
    }
    try {
        if (ds_abi_version() != DS_ABI_VERSION)
            throw std::runtime_error("Incompatible docscan ABI");
        ds_engine_config config;
        ds_engine_config_init(&config);
        config.model_directory = argv[1];
        ds_engine *engine_handle = nullptr;
        check(ds_engine_create(&config, &engine_handle));
        std::unique_ptr<ds_engine, decltype(&ds_engine_destroy)> engine(engine_handle, ds_engine_destroy);
        ds_document *document_handle = nullptr;
        check(ds_document_create(engine.get(), &document_handle));
        std::unique_ptr<ds_document, decltype(&ds_document_destroy)> document(document_handle,
                                                                              ds_document_destroy);
        ds_page_options options;
        ds_page_options_init(&options);
        for (int i = 3; i < argc; ++i) {
            std::ifstream file(argv[i], std::ios::binary | std::ios::ate);
            if (!file)
                throw std::runtime_error("Cannot open input");
            const auto length = file.tellg();
            if (length <= 0 || static_cast<uint64_t>(length) > config.max_input_bytes)
                throw std::runtime_error("Input exceeds configured limit");
            std::vector<uint8_t> encoded(static_cast<size_t>(length));
            file.seekg(0);
            if (!file.read(reinterpret_cast<char *>(encoded.data()),
                           static_cast<std::streamsize>(encoded.size())))
                throw std::runtime_error("Cannot read input");
            uint32_t index;
            check(ds_document_add_image(
                document.get(), {encoded.data(), static_cast<uint64_t>(encoded.size())}, &options, &index));
            const ds_page_info *info;
            ds_bytes jpeg;
            check(ds_document_get_page(document.get(), index, &info, &jpeg));
            std::cout << "Page " << index + 1 << ": " << info->width << "x" << info->height
                      << ", warnings=" << info->warnings << '\n';
        }
        ds_buffer *buffer_handle = nullptr;
        check(ds_document_pdf(document.get(), &buffer_handle));
        std::unique_ptr<ds_buffer, decltype(&ds_buffer_destroy)> pdf(buffer_handle, ds_buffer_destroy);
        ds_bytes bytes;
        check(ds_buffer_bytes(pdf.get(), &bytes));
        std::ofstream output(argv[2], std::ios::binary);
        if (!output.write(reinterpret_cast<const char *>(bytes.data),
                          static_cast<std::streamsize>(bytes.size)))
            throw std::runtime_error("Cannot write PDF");
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
