include_guard(GLOBAL)

fetch_archive(
  icu
  "https://github.com/unicode-org/icu/releases/download/release-78.2/icu4c-78.2-sources.tgz"
  3e99687b5c435d4b209630e2d2ebb79906c984685e78635078b672e03c89df35
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

target_compile_definitions(
  icuuc
  PRIVATE
    U_COMMON_IMPLEMENTATION
  PUBLIC
    U_STATIC_IMPLEMENTATION
    U_USING_ICU_NAMESPACE=0
)
