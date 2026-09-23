cmake_minimum_required(VERSION 3.31)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)

project(bare_pdfium C)

include(cmake/pdfium.cmake)

# INSTALL TARGET pdfium co-locates the shared library next to the built `.bare`
# (under prebuilds/<target>/bare-pdfium/), which is where add_bare_module's baked
# rpath (@loader_path/bare-pdfium, $ORIGIN/bare-pdfium) looks for it.
add_bare_module(bare_pdfium INSTALL TARGET pdfium)

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
