cmake_minimum_required(VERSION 3.31)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)

if(NOT TARGET c++ OR NOT TARGET pdfium)
  find_package(cmake-gn REQUIRED PATHS node_modules/cmake-gn)
endif()

project(bare_pdfium C)

bare_target(target)

if(NOT TARGET c++ AND NOT WIN32 AND NOT target MATCHES "^wasi-")
  add_gn_target(c++ buildtools/third_party/libc++:libc++)

  if(NOT APPLE)
    add_gn_target(c++abi buildtools/third_party/libc++abi:libc++abi)

    target_link_libraries(
      c++
      INTERFACE
        c++abi
    )
  endif()
endif()

if(NOT TARGET pdfium)
  if(target MATCHES "^wasi-")
    enable_language(CXX)

    find_program(node NAMES node REQUIRED)

    # GN has no WASI toolchain, so it only describes the build, which CMake
    # then compiles with the WASI toolchain.
    execute_process(
      COMMAND "${node}" "${CMAKE_CURRENT_LIST_DIR}/gn/to-cmake.js" "${GN_OUT_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/pdfium.cmake"
      COMMAND_ERROR_IS_FATAL ANY
    )

    # WASI has no time zone globals or mmap for ICU. The sources are named by
    # their path in the PDFium checkout, not on the machine that built them.
    add_compile_definitions(
      U_HAVE_TZSET=0
      U_HAVE_TIMEZONE=0
      U_HAVE_TZNAME=0
      U_HAVE_MMAP=0
    )

    add_compile_options("-ffile-prefix-map=${GN_DIR}=pdfium")

    include("${CMAKE_CURRENT_BINARY_DIR}/pdfium.cmake")

    # PDFium maps files with mmap, which wasi-libc only emulates.
    set_source_files_properties(
      "${GN_DIR}/core/fxcrt/mapped_data_bytes.cpp"
      PROPERTIES
      COMPILE_DEFINITIONS _WASI_EMULATED_MMAN
    )

    # Linear memory stops at 1 GiB, PDFium's recursive parsers get a 4 MiB
    # stack rather than wasm-ld's 64 KiB, and the module keeps no symbol names.
    target_link_options(
      pdfium
      INTERFACE
        -Wl,--max-memory=1073741824
        -Wl,-z,stack-size=4194304
        -Wl,--strip-all
        -lwasi-emulated-mman
        -lwasi-emulated-getpid
    )
  else()
    add_gn_target(pdfium :pdfium)

    if(TARGET c++)
      target_link_libraries(
        pdfium
        INTERFACE
          c++
      )
    endif()
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
