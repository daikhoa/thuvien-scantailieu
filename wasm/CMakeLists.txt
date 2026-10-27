cmake_minimum_required(VERSION 3.24)
project(docscan_wasm LANGUAGES C CXX)
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "Configure with Emscripten")
endif()
set(CMAKE_CXX_STANDARD 17)
find_package(OpenCV REQUIRED COMPONENTS core imgproc)
add_executable(docscan bridge.cpp ../src/corner-refinement.cpp ../src/geometry.cpp ../src/quality.cpp ../src/appearance-plan.cpp ../src/filters.cpp ../src/paper-restoration.cpp ../src/paper-field.cpp ../src/adaptive-enhancement.cpp)
target_include_directories(docscan PRIVATE ../src ../include ${OpenCV_INCLUDE_DIRS})
target_link_libraries(docscan PRIVATE ${OpenCV_LIBS})
target_compile_options(docscan PRIVATE -O3 -fexceptions)
target_link_options(docscan PRIVATE -O3 -fexceptions --no-entry
    "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sENVIRONMENT=web,worker,node"
    "-sALLOW_MEMORY_GROWTH=1" "-sINITIAL_MEMORY=16777216" "-sMAXIMUM_MEMORY=805306368"
    "-sSTACK_SIZE=1048576" "-sFILESYSTEM=0" "-sDISABLE_EXCEPTION_CATCHING=0"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_ds_wasm_process','_ds_wasm_process_owned','_ds_wasm_output','_ds_wasm_width','_ds_wasm_height','_ds_wasm_release','_ds_wasm_enhance_owned','_ds_wasm_begin','_ds_wasm_patch_count','_ds_wasm_patch','_ds_wasm_write_patch','_ds_wasm_prepare','_ds_wasm_needs_model','_ds_wasm_sample','_ds_wasm_sample_width','_ds_wasm_sample_height','_ds_wasm_finish','_ds_wasm_refine_corners','_ds_wasm_confirm_corners']"
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPF64']")
set_target_properties(docscan PROPERTIES SUFFIX ".mjs")
