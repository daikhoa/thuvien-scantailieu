#include <docscan/docscan.h>
int main(void) {
    ds_engine_config config;
    ds_engine *engine = 0;
    ds_engine_config_init(&config);
    if (ds_engine_create(&config, &engine) != DS_OK)
        return 1;
    if (ds_engine_capabilities(engine) != (DS_CAP_JPEG | DS_CAP_PNG | DS_CAP_WEBP))
        return 2;
    ds_engine_destroy(engine);
    return ds_abi_version() == DS_ABI_VERSION ? 0 : 3;
}
