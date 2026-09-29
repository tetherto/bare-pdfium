include_guard(GLOBAL)

fetch_package(
  "git:pdfium.googlesource.com/pdfium#fc46361ce75055cd549cb938fae5d6a3fe3a1a05"
  SOURCE_DIR pdfium_dir
)

fetch_package("github:madler/zlib#da607da739fa6047df13e66a2af6b8bec7c2a498")

set(ABSL_PROPAGATE_CXX_STD ON)
set(ABSL_MSVC_STATIC_RUNTIME ON)

# Chromium patches abseil into hardened mode, which bounds-checks its containers.
fetch_package(
  "github:abseil/abseil-cpp#1c84143fb79e6041f3e0596df51c3ae7d7e46a8a"
  PATCHES
    patches/01-abseil-hardened.patch
)

fetch_package(
  "github:fastfloat/fast_float#34164f547b7df3f5d794ff67e9f885c36819ebfc"
  SOURCE_SUBDIR none
  SOURCE_DIR fast_float_dir
)

fetch_package(
  "github:jk-jeon/dragonbox#beeeef91cf6fef89a4d4ba5e95d47ca64ccb3a44"
  SOURCE_SUBDIR none
  SOURCE_DIR dragonbox_dir
)

find_port(libjpeg)

include(${CMAKE_CURRENT_LIST_DIR}/pdfium/freetype.cmake)
include(${CMAKE_CURRENT_LIST_DIR}/pdfium/icu.cmake)
include(${CMAKE_CURRENT_LIST_DIR}/pdfium/harfbuzz.cmake)
include(${CMAKE_CURRENT_LIST_DIR}/pdfium/sources.cmake)

set(pdfium_include "${CMAKE_CURRENT_BINARY_DIR}/pdfium/include")

file(
  DOWNLOAD "https://raw.githubusercontent.com/chromium/chromium/156.0.8066.0/build/build_config.h"
  "${pdfium_include}/build/build_config.h"
  EXPECTED_HASH SHA256=c6e3501edea0833a2ef1b50f5cd27e151d58198af0523fa4d91ebd62a1be2039
  TLS_VERIFY ON
)

file(
  DOWNLOAD "https://raw.githubusercontent.com/chromium/chromium/156.0.8066.0/build/buildflag.h"
  "${pdfium_include}/build/buildflag.h"
  EXPECTED_HASH SHA256=40538acaa9b39d0f68e895503752bde340f8ea1cdb67a87bfaee865dba54c5cd
  TLS_VERIFY ON
)

foreach(header IN ITEMS cleanup/cleanup.h container/flat_hash_set.h container/inlined_vector.h)
  file(
    CONFIGURE
    OUTPUT "${pdfium_include}/third_party/abseil-cpp/absl/${header}"
    CONTENT "#include <absl/${header}>\n"
    @ONLY
  )
endforeach()

file(
  CONFIGURE
  OUTPUT "${pdfium_include}/third_party/fast_float/src/include/fast_float/fast_float.h"
  CONTENT "#include \"${fast_float_dir}/include/fast_float/fast_float.h\"\n"
  @ONLY
)

file(
  CONFIGURE
  OUTPUT "${pdfium_include}/third_party/dragonbox/src/include/dragonbox/dragonbox.h"
  CONTENT "#include \"${dragonbox_dir}/include/dragonbox/dragonbox.h\"\n"
  @ONLY
)

set(pdfium_sources
  ${pdfium_fxcrt}
  ${pdfium_fdrm}
  ${pdfium_fxcodec}
  ${pdfium_fxge}
  ${pdfium_cmaps}
  ${pdfium_font}
  ${pdfium_page}
  ${pdfium_parser}
  ${pdfium_render}
  ${pdfium_edit}
  ${pdfium_fpdfdoc}
  ${pdfium_fpdftext}
  ${pdfium_fpdfsdk}
  ${pdfium_formfiller}
  ${pdfium_pwl}
  ${pdfium_fxjs}
  ${pdfium_fx_agg}
  ${pdfium_fx_lcms2}
  ${pdfium_fx_libopenjpeg}
)

if(WIN32)
  list(APPEND pdfium_sources ${pdfium_win32})
else()
  list(APPEND pdfium_sources ${pdfium_posix})
endif()

if(APPLE)
  list(APPEND pdfium_sources ${pdfium_apple})
elseif(ANDROID)
  list(APPEND pdfium_sources ${pdfium_android})
elseif(LINUX)
  list(APPEND pdfium_sources ${pdfium_linux})
endif()

list(TRANSFORM pdfium_sources PREPEND "${pdfium_dir}/")

add_library(pdfium STATIC)

target_sources(
  pdfium
  PRIVATE
    ${pdfium_sources}
)

target_include_directories(
  pdfium
  PUBLIC
    ${pdfium_dir}/public
  PRIVATE
    ${pdfium_dir}
    ${pdfium_include}
)

target_compile_definitions(
  pdfium
  PUBLIC
    PDF_USE_AGG
  PRIVATE
    OPJ_STATIC
    USE_SYSTEM_ICUUC
    USE_SYSTEM_LIBJPEG
    USE_SYSTEM_ZLIB
)

if(CMAKE_CXX_COMPILER_FRONTEND_VARIANT MATCHES "MSVC")
  target_compile_options(
    pdfium
    PRIVATE
      /utf-8
  )
endif()

target_link_libraries(
  pdfium
  PRIVATE
    freetype
    harfbuzz
    icuuc
    jpeg
    zlibstatic
    absl::cleanup
    absl::flat_hash_set
    absl::inlined_vector
)

if(APPLE)
  target_link_libraries(
    pdfium
    PRIVATE
      "-framework CoreFoundation"
      "-framework CoreGraphics"
  )
elseif(WIN32)
  set(pdfium_lean_sources ${pdfium_sources})
  list(FILTER pdfium_lean_sources EXCLUDE REGEX "/core/fxge/")

  # Chromium builds everything but fxge's GDI code lean, which keeps winspool.h from renaming SetForm.
  set_source_files_properties(
    ${pdfium_lean_sources}
    PROPERTIES
    COMPILE_DEFINITIONS WIN32_LEAN_AND_MEAN
  )

  target_compile_definitions(
    pdfium
    PRIVATE
      NOMINMAX
      UNICODE
      _UNICODE
      _CRT_SECURE_NO_DEPRECATE
      WINVER=0x0A00
      _WIN32_WINNT=0x0A00
  )

  target_link_libraries(
    pdfium
    PRIVATE
      advapi32
      gdi32
      user32
  )
endif()
