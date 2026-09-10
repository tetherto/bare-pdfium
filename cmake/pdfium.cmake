# Fetches a prebuilt PDFium (bblanchon/pdfium-binaries) for the target platform
# and exposes an imported `pdfium` target (headers + shared library). No PDFium
# source build, no depot_tools — the release binaries are downloaded per host at
# configure time. `add_bare_module(... INSTALL TARGET pdfium)` then ships the
# shared library beside the `.bare`, where its rpath resolves it.

include_guard(GLOBAL)

set(PDFIUM_RELEASE "latest" CACHE STRING "pdfium-binaries release tag, or 'latest'")

# Resolve the bblanchon asset name from the CMake target description. bare-make
# asks cmake-bare for the resolved target, which reads CMAKE_OSX_ARCHITECTURES /
# CMAKE_ANDROID_ARCH_ABI etc. — so a cross build (darwin-x64 on an arm64 runner,
# android, ios) names its true target, not the host's CMAKE_SYSTEM_PROCESSOR.
if(NOT DEFINED PDFIUM_ASSET)
  bare_platform(_sys)
  bare_arch(_arch)
  # cmake-bare and bblanchon agree on arm64/arm/x64/x86, so no arch remap needed

  if(_sys STREQUAL "darwin")
    set(PDFIUM_ASSET "pdfium-mac-${_arch}")
  elseif(_sys STREQUAL "linux")
    set(PDFIUM_ASSET "pdfium-linux-${_arch}")
  elseif(_sys STREQUAL "android")
    set(PDFIUM_ASSET "pdfium-android-${_arch}")
  elseif(_sys STREQUAL "win32")
    set(PDFIUM_ASSET "pdfium-win-${_arch}")
  elseif(_sys STREQUAL "ios")
    # device vs simulator: the simulator sysroot name carries "simulator"
    if(CMAKE_OSX_SYSROOT MATCHES "[Ss]imulator")
      set(PDFIUM_ASSET "pdfium-ios-simulator-${_arch}")
    else()
      set(PDFIUM_ASSET "pdfium-ios-device-${_arch}")
    endif()
  else()
    message(FATAL_ERROR "bare-pdfium: no PDFium asset mapping for '${_sys}/${_proc}'")
  endif()
endif()

if(PDFIUM_RELEASE STREQUAL "latest")
  set(_pdfium_url "https://github.com/bblanchon/pdfium-binaries/releases/latest/download/${PDFIUM_ASSET}.tgz")
else()
  set(_pdfium_url "https://github.com/bblanchon/pdfium-binaries/releases/download/${PDFIUM_RELEASE}/${PDFIUM_ASSET}.tgz")
endif()

set(_pdfium_dir "${CMAKE_BINARY_DIR}/pdfium")

if(NOT EXISTS "${_pdfium_dir}/include/fpdfview.h")
  message(STATUS "bare-pdfium: fetching ${_pdfium_url}")
  file(
    DOWNLOAD "${_pdfium_url}" "${CMAKE_BINARY_DIR}/pdfium.tgz"
    STATUS _pdfium_status
    SHOW_PROGRESS
  )
  list(GET _pdfium_status 0 _pdfium_code)
  if(NOT _pdfium_code EQUAL 0)
    message(FATAL_ERROR "bare-pdfium: download failed (${_pdfium_status}) from ${_pdfium_url}")
  endif()
  file(MAKE_DIRECTORY "${_pdfium_dir}")
  file(ARCHIVE_EXTRACT INPUT "${CMAKE_BINARY_DIR}/pdfium.tgz" DESTINATION "${_pdfium_dir}")
endif()

set(PDFIUM_LIB_DIR "${_pdfium_dir}/lib" CACHE INTERNAL "PDFium shared-library directory")
set(PDFIUM_LIBRARY "" CACHE INTERNAL "PDFium shared-library file")

# The runtime library (loaded at run time). On Windows this is the DLL, shipped
# under bin/; elsewhere the dylib/so under lib/.
file(GLOB _pdfium_lib
  "${_pdfium_dir}/lib/libpdfium.dylib"
  "${_pdfium_dir}/lib/libpdfium.so"
  "${_pdfium_dir}/bin/pdfium.dll"
  "${_pdfium_dir}/lib/pdfium.dll"
)
list(GET _pdfium_lib 0 _pdfium_lib)
if(NOT _pdfium_lib)
  message(FATAL_ERROR "bare-pdfium: no libpdfium found under ${_pdfium_dir}")
endif()
set(PDFIUM_LIBRARY "${_pdfium_lib}" CACHE INTERNAL "PDFium shared-library file")

# The released macOS dylib ships with an install-name of `./libpdfium.dylib`,
# which the loader resolves against the CWD (and so ignores any rpath). Rewrite
# it to `@rpath/...` so the module's INSTALL_RPATH finds it.
if(APPLE)
  execute_process(
    COMMAND install_name_tool -id @rpath/libpdfium.dylib "${_pdfium_lib}"
  )
endif()

add_library(pdfium SHARED IMPORTED GLOBAL)
set_target_properties(
  pdfium
  PROPERTIES
    IMPORTED_LOCATION "${_pdfium_lib}"
    INTERFACE_INCLUDE_DIRECTORIES "${_pdfium_dir}/include"
)

# Windows links against the import library (.lib), not the DLL.
if(WIN32)
  file(GLOB _pdfium_implib "${_pdfium_dir}/lib/pdfium.dll.lib" "${_pdfium_dir}/lib/pdfium.lib")
  list(GET _pdfium_implib 0 _pdfium_implib)
  if(NOT _pdfium_implib)
    message(FATAL_ERROR "bare-pdfium: no PDFium import library found under ${_pdfium_dir}/lib")
  endif()
  set_target_properties(pdfium PROPERTIES IMPORTED_IMPLIB "${_pdfium_implib}")
endif()
