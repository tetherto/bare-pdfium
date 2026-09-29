cmake_minimum_required(VERSION 3.31)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)

if(NOT TARGET c++ OR NOT TARGET pdfium)
  find_package(cmake-gn REQUIRED PATHS node_modules/cmake-gn)
endif()

project(bare_pdfium C)

if(NOT TARGET c++ AND NOT WIN32)
  add_gn_target(c++ buildtools/third_party/libc++:libc++)
endif()

if(NOT TARGET pdfium)
  add_gn_target(pdfium :pdfium)

  if(TARGET c++)
    target_link_libraries(
      pdfium
      INTERFACE
        c++
    )
  endif()

  # PDFium's public headers are included by name rather than by their path in the tree.
  target_include_directories(
    pdfium
    INTERFACE
      "${GN_DIR}/public"
  )
endif()

add_bare_module(bare_pdfium)

if(APPLE)
  # cmake-bare localizes symbols only on ELF, and exported code survives dead stripping.
  target_link_options(
    ${bare_pdfium}
    PUBLIC
      -Wl,-dead_strip
      -Wl,-exported_symbol,_bare_get_module_name_v*
      -Wl,-exported_symbol,_bare_register_module_v*
  )
elseif(ANDROID)
  # Google Play requires 16 KB page alignment for 64-bit native code, whatever the NDK defaults to.
  target_link_options(${bare_pdfium} PUBLIC -Wl,--gc-sections -Wl,-z,max-page-size=16384)
elseif(NOT WIN32)
  target_link_options(${bare_pdfium} PUBLIC -Wl,--gc-sections)
endif()

target_sources(
  ${bare_pdfium}
  PRIVATE
    binding.c
)

target_link_libraries(
  ${bare_pdfium}
  PUBLIC
    pdfium
)
