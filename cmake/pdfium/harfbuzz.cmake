include_guard(GLOBAL)

fetch_package(
  "github:harfbuzz/harfbuzz#886fc1e645388080b72f6d9b06347533a0018045"
  SOURCE_SUBDIR none
  SOURCE_DIR harfbuzz_dir
)

add_library(harfbuzz STATIC)

# The amalgamation covers PDFium's source list; the defines below compile out what it leaves unused.
target_sources(
  harfbuzz
  PRIVATE
    ${harfbuzz_dir}/src/harfbuzz-subset.cc
    ${harfbuzz_dir}/src/hb-icu.cc
)

target_include_directories(
  harfbuzz
  PUBLIC
    ${harfbuzz_dir}/src
  PRIVATE
    ${pdfium_dir}/third_party/harfbuzz
)

# Mirrors PDFium's third_party/harfbuzz/BUILD.gn.
target_compile_definitions(
  harfbuzz
  PRIVATE
    HAVE_OT
    HAVE_ICU
    HAVE_ICU_BUILTIN
    HB_NO_MMAP
    HB_NO_RESOURCE_FORK
    HB_NO_PAINT=
    HB_NO_SUBSET_LAYOUT
    HB_NO_SUBSET_CFF
    HB_NO_FALLBACK_SHAPE
    HB_NO_UCD
    HB_NO_WIN1256
    U_DISABLE_VERSION_SUFFIX=0
    HB_NO_BUFFER_VERIFY
    HB_NO_DRAW
    "HB_CONFIG_OVERRIDE_LAST_H=\"pdfium-config-override.h\""
    HB_NO_BORING_EXPANSION
    HB_NO_AVAR2
    HB_NO_PRAGMA_GCC_DIAGNOSTIC_ERROR
    HB_NO_PRAGMA_GCC_DIAGNOSTIC_WARNING
)

if(NOT WIN32 AND NOT CMAKE_SYSTEM_NAME STREQUAL "Darwin")
  target_compile_definitions(
    harfbuzz
    PRIVATE
      HAVE_PTHREAD
  )
endif()

target_link_libraries(
  harfbuzz
  PRIVATE
    icuuc
)
