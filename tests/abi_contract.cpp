#include <docscan/docscan.h>
#include <iostream>
#include <stdexcept>
#define CHECK(x)                                                                                             \
    do {                                                                                                     \
        if (!(x))                                                                                            \
            throw std::runtime_error(#x);                                                                    \
    } while (0)
int main() {
    try {
        CHECK(ds_abi_version() == DS_ABI_VERSION);
        CHECK(ds_engine_create(nullptr, nullptr) == DS_INVALID_ARGUMENT);
        ds_engine_config c{};
        ds_engine_config_init(&c);
        ds_engine *e = reinterpret_cast<ds_engine *>(1);
        c.abi_version = 999;
        CHECK(ds_engine_create(&c, &e) == DS_INVALID_ARGUMENT);
        CHECK(e == nullptr);
        ds_engine_config_init(&c);
        CHECK(ds_engine_create(&c, &e) == DS_OK);
        CHECK(e != nullptr);
        ds_document *d = nullptr;
        CHECK(ds_document_create(e, &d) == DS_OK);
        ds_page_options o{};
        ds_page_options_init(&o);
        CHECK(o.filter == DS_FILTER_ENHANCED_COLOR);
        uint32_t index = 77;
        CHECK(ds_document_add_image(d, {nullptr, 1}, &o, &index) == DS_INVALID_ARGUMENT);
        CHECK(ds_document_page_count(d) == 0);
        ds_buffer *pdf = nullptr;
        CHECK(ds_document_pdf(d, &pdf) == DS_INVALID_ARGUMENT);
        ds_document_cancel(d);
        uint8_t one = 0;
        CHECK(ds_document_add_image(d, {&one, 1}, &o, &index) == DS_CANCELLED);
        CHECK(ds_document_reset_cancel(d) == DS_OK);
        CHECK(ds_document_add_image(d, {&one, 1}, &o, &index) == DS_UNSUPPORTED_FORMAT);
        o.struct_size = 0;
        CHECK(ds_document_add_image(d, {&one, 1}, &o, &index) == DS_INVALID_ARGUMENT);
        ds_document_destroy(d);
        ds_engine_destroy(e);
        ds_buffer_destroy(nullptr);
        ds_document_destroy(nullptr);
        ds_engine_destroy(nullptr);
        std::cout << "ABI contract passed\n";
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
