include_guard(GLOBAL)

fetch_package(
  "github:freetype/freetype#4800589f76dc62fbe523a74a59e0d4850a5dd7df"
  SOURCE_SUBDIR none
  SOURCE_DIR freetype_dir
)

add_library(freetype STATIC)

target_sources(
  freetype
  PRIVATE
    ${freetype_dir}/src/base/ftbase.c
    ${freetype_dir}/src/base/ftbitmap.c
    ${freetype_dir}/src/base/ftdebug.c
    ${freetype_dir}/src/base/ftfstype.c
    ${freetype_dir}/src/base/ftglyph.c
    ${freetype_dir}/src/base/ftinit.c
    ${freetype_dir}/src/base/ftmm.c
    ${freetype_dir}/src/base/ftsystem.c
    ${freetype_dir}/src/cff/cff.c
    ${freetype_dir}/src/cid/type1cid.c
    ${freetype_dir}/src/psaux/psaux.c
    ${freetype_dir}/src/pshinter/pshinter.c
    ${freetype_dir}/src/psnames/psmodule.c
    ${freetype_dir}/src/raster/raster.c
    ${freetype_dir}/src/sfnt/sfnt.c
    ${freetype_dir}/src/smooth/smooth.c
    ${freetype_dir}/src/truetype/truetype.c
    ${freetype_dir}/src/type1/type1.c
)

target_include_directories(
  freetype
  PUBLIC
    ${pdfium_dir}/third_party/freetype/include
    ${freetype_dir}/include
)

target_compile_definitions(
  freetype
  PRIVATE
    FT2_BUILD_LIBRARY
  PUBLIC
    "FT_CONFIG_MODULES_H=\"freetype-custom-config/ftmodule.h\""
    "FT_CONFIG_OPTIONS_H=\"freetype-custom-config/ftoption.h\""
)
