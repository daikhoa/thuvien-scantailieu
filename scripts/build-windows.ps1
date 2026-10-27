param(
    [string]$CMake = "",
    [string]$Python = "",
    [switch]$Package
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $CMake) {
    $found = Get-Command cmake -ErrorAction SilentlyContinue
    if ($found) { $CMake = $found.Source }
    else { $CMake = 'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe' }
}
if (-not (Test-Path -LiteralPath $CMake)) { throw 'Install CMake 3.24+ and Visual Studio 2022 C++ tools, or pass -CMake.' }
function Run-CMake([string[]]$Arguments) {
    & $CMake @Arguments
    if ($LASTEXITCODE -ne 0) { throw "CMake failed with exit code $LASTEXITCODE" }
}
$configure = @('-S', $root, '-B', "$root/build", '-G', 'Visual Studio 17 2022', '-A', 'x64',
    "-DOpenCV_DIR=$root/.deps/opencv-install", "-DONNXRUNTIME_ROOT=$root/.deps/onnxruntime-win-x64-1.27.0")
if ($Python) { $configure += "-DPython3_EXECUTABLE=$Python" }
Run-CMake $configure
Run-CMake @('--build', "$root/build", '--config', 'Release', '--parallel', '4')
$ctest = Join-Path (Split-Path -Parent $CMake) 'ctest.exe'
& $ctest --test-dir "$root/build" -C Release --output-on-failure
if ($LASTEXITCODE -ne 0) { throw 'Native verification failed' }
if ($Package) {
    Run-CMake @('--install', "$root/build", '--config', 'Release', '--prefix', "$root/dist/docscan-win-x64")
    $packageDirectory = Join-Path $root 'dist/docscan-win-x64'
    $manifestPath = Join-Path $packageDirectory 'manifest.json'
    $manifest = Get-ChildItem -LiteralPath $packageDirectory -File -Recurse | Where-Object { $_.FullName -ne $manifestPath } | Sort-Object FullName | ForEach-Object {
        [pscustomobject]@{path=$_.FullName.Substring($packageDirectory.Length+1).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    $manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath "$packageDirectory/manifest.json" -Encoding UTF8
    Compress-Archive -Path "$packageDirectory/*" -DestinationPath "$root/dist/docscan-win-x64.zip" -Force
}
