include_guard(GLOBAL)

fetch_package(
  "https://github.com/unicode-org/icu/releases/download/release-78.2/icu4c-78.2-sources.tgz"
  SOURCE_SUBDIR none
  SOURCE_DIR icu_dir
)

file(GLOB icuuc_sources "${icu_dir}/source/common/*.cpp")

add_library(icuuc STATIC)

# PDFium needs only the property and bidi tables built into icuuc, so ICU's data archive is stubbed.
target_sources(
  icuuc
  PRIVATE
    ${icuuc_sources}
    ${icu_dir}/source/stubdata/stubdata.cpp
)

target_include_directories(
  icuuc
  PUBLIC
    ${icu_dir}/source/common
)

# Mirrors Chromium's third_party/icu/BUILD.gn, which PDFium builds against.
target_compile_definitions(
  icuuc
  PRIVATE
    U_COMMON_IMPLEMENTATION
    HAVE_DLOPEN=0
    UCONFIG_ONLY_HTML_CONVERSION=1
    UCONFIG_USE_ML_PHRASE_BREAKING=1
    UCONFIG_USE_WINDOWS_LCID_MAPPING_API=0
    U_CHARSET_IS_UTF8=1
  PUBLIC
    U_STATIC_IMPLEMENTATION
    U_USING_ICU_NAMESPACE=0
    U_ENABLE_DYLOAD=0
)

if(CMAKE_CXX_COMPILER_FRONTEND_VARIANT MATCHES "MSVC")
  target_compile_options(
    icuuc
    PRIVATE
      /utf-8
  )
endif()
