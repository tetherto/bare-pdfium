include_guard(GLOBAL)

if(WIN32)
  set(lib lib/jpeg-static.lib)
else()
  set(lib lib/libjpeg.a)
endif()

list(JOIN pdfium_flags " " flags)

# x86 SIMD needs NASM, and without this the port silently falls back to plain C.
if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|AMD64|i[3-6]86|x86)$")
  set(simd ON)
else()
  set(simd OFF)
endif()

declare_port(
  "github:libjpeg-turbo/libjpeg-turbo#c85e6b905bf237038faa936dab160ebfc5da0344"
  jpeg
  BYPRODUCTS ${lib}
  ARGS
    "-DCMAKE_C_FLAGS_INIT=${flags}"
    -DREQUIRE_SIMD=${simd}
    -DENABLE_SHARED=OFF
    -DWITH_TURBOJPEG=OFF
    -DWITH_ARITH_DEC=OFF
    -DWITH_ARITH_ENC=OFF
)

add_library(jpeg STATIC IMPORTED GLOBAL)

add_dependencies(jpeg ${jpeg})

set_target_properties(
  jpeg
  PROPERTIES
  IMPORTED_LOCATION "${jpeg_PREFIX}/${lib}"
)

file(MAKE_DIRECTORY "${jpeg_PREFIX}/include")

target_include_directories(
  jpeg
  INTERFACE "${jpeg_PREFIX}/include"
)
