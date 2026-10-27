param([string]$CMake = "")
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$deps = Join-Path $root '.deps'
New-Item -ItemType Directory -Path $deps -Force | Out-Null
if (-not $CMake) {
    $found = Get-Command cmake -ErrorAction SilentlyContinue
    if ($found) { $CMake = $found.Source }
    else { $CMake = 'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe' }
}
if (-not (Test-Path -LiteralPath $CMake)) { throw 'CMake 3.24+ / Visual Studio 2022 C++ tools required.' }
function Fetch-Verified([string]$Url,[string]$Destination,[string]$Hash) {
    if (-not (Test-Path -LiteralPath $Destination)) {
        Invoke-WebRequest -Uri $Url -OutFile "$Destination.partial" -TimeoutSec 120
        if ((Get-FileHash -LiteralPath "$Destination.partial" -Algorithm SHA256).Hash -ne $Hash) { throw 'Dependency SHA-256 mismatch' }
        Move-Item -LiteralPath "$Destination.partial" -Destination $Destination
    }
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $Hash) { throw "Dependency SHA-256 mismatch: $Destination" }
}
$downloads = Join-Path $deps 'downloads'
New-Item -ItemType Directory -Path $downloads -Force | Out-Null
$ortArchive = Join-Path $downloads 'onnxruntime-win-x64-1.27.0.zip'
$cvArchive = Join-Path $downloads 'opencv-4.14.0.tar.gz'
Fetch-Verified 'https://github.com/microsoft/onnxruntime/releases/download/v1.27.0/onnxruntime-win-x64-1.27.0.zip' $ortArchive 'C5C81710938E68079FF1A192B04897FAABE4B43830D48F39F27ECD4E16138BFC'
Fetch-Verified 'https://codeload.github.com/opencv/opencv/tar.gz/0654a42e19215ef25b1d367d822f3c630447e7c7' $cvArchive '7A75663094EBD50BF212928423A24394E29D751DB878044AD015BA28546A59DB'
$ort = Join-Path $deps 'onnxruntime-win-x64-1.27.0'
if (-not (Test-Path -LiteralPath "$ort/include/onnxruntime_cxx_api.h")) {
    Expand-Archive -LiteralPath $ortArchive -DestinationPath $deps
}
$opencv = Join-Path $deps 'opencv-0654a42e19215ef25b1d367d822f3c630447e7c7'
if (-not (Test-Path -LiteralPath "$opencv/CMakeLists.txt")) {
    & tar -xzf $cvArchive -C $deps
    if ($LASTEXITCODE -ne 0) { throw 'OpenCV extraction failed' }
}
$flags = @('-S',$opencv,'-B',"$deps/opencv-build",'-G','Visual Studio 17 2022','-A','x64',
    "-DCMAKE_INSTALL_PREFIX=$deps/opencv-install",'-DBUILD_LIST=core,imgproc,imgcodecs','-DBUILD_SHARED_LIBS=ON',
    '-DBUILD_TESTS=OFF','-DBUILD_PERF_TESTS=OFF','-DBUILD_EXAMPLES=OFF','-DBUILD_opencv_apps=OFF',
    '-DBUILD_JAVA=OFF','-DBUILD_opencv_python3=OFF','-DWITH_FFMPEG=OFF','-DWITH_GSTREAMER=OFF','-DWITH_MSMF=OFF',
    '-DWITH_OPENCL=OFF','-DWITH_IPP=OFF','-DWITH_ITT=OFF','-DWITH_OPENEXR=OFF','-DWITH_OPENJPEG=OFF',
    '-DWITH_TIFF=OFF','-DWITH_AVIF=OFF','-DWITH_WEBP=ON','-DBUILD_WEBP=ON','-DBUILD_JPEG=ON','-DBUILD_PNG=ON','-DBUILD_ZLIB=ON',
    '-DOPENCV_GENERATE_SETUPVARS=OFF','-DCPU_BASELINE=SSE2','-DCPU_DISPATCH=SSE4_1,AVX2',
    '-DOPENCV_DISABLE_THREAD_SUPPORT=ON','-DWITH_WIN32UI=OFF','-DWITH_OPENGL=OFF')
& $CMake @flags
if ($LASTEXITCODE -ne 0) { throw 'OpenCV configure failed' }
& $CMake --build "$deps/opencv-build" --config Release --target INSTALL --parallel 4
if ($LASTEXITCODE -ne 0) { throw 'OpenCV build failed' }
Write-Host 'Dependencies ready. Run scripts/build-windows.ps1 next.'
