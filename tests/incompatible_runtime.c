#include <onnxruntime_c_api.h>
static const OrtApi *ORT_API_CALL unsupported_api(uint32_t version) {
    (void)version;
    return 0;
}
static const char *ORT_API_CALL version_string(void) {
    return "incompatible-test-runtime";
}
const OrtApiBase *ORT_API_CALL OrtGetApiBase(void) NO_EXCEPTION {
    static const OrtApiBase base = {unsupported_api, version_string};
    return &base;
}
