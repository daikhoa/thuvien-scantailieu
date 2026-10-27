#include <docscan/docscan.h>
int main(void) {
    ds_engine_config config;
    ds_engine *engine = (ds_engine *)1;
    ds_engine_config_init(&config);
    if (ds_engine_create(&config, &engine) != DS_MODEL_UNAVAILABLE)
        return 1;
    if (engine != 0)
        return 2;
    /* Failed initialization must remain safe and retryable. */
    if (ds_engine_create(&config, &engine) != DS_MODEL_UNAVAILABLE)
        return 3;
    return engine == 0 ? 0 : 4;
}
