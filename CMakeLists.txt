cmake_minimum_required(VERSION 3.31)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-fetch REQUIRED PATHS node_modules/cmake-fetch)
find_package(cmake-ports REQUIRED PATHS node_modules/cmake-ports)

set(ANDROID_STL c++_shared)

project(bare_pdfium C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Chromium builds PDFium and every dependency with these; PDFium's safety and rendering assume them.
if(CMAKE_C_COMPILER_FRONTEND_VARIANT MATCHES "MSVC")
  set(pdfium_flags
    /Gy
    /Gw
    /clang:-fno-strict-aliasing
    /clang:-fno-strict-overflow
    /clang:-fno-delete-null-pointer-checks
    /clang:-ftrivial-auto-var-init=zero
    /clang:-ffp-contract=off
  )

  add_compile_definitions(_MSVC_STL_HARDENING=1)
else()
  set(pdfium_flags
    -ffunction-sections
    -fdata-sections
    -fno-strict-aliasing
    -fno-strict-overflow
    -fno-delete-null-pointer-checks
    -ftrivial-auto-var-init=zero
    -ffp-contract=off
  )
endif()

add_compile_options(${pdfium_flags})

add_compile_definitions(
  _LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE
  _GLIBCXX_ASSERTIONS
)

include(cmake/pdfium.cmake)

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
