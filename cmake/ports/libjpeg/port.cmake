include_guard(GLOBAL)

if(WIN32)
  set(lib lib/jpeg-static.lib)
else()
  set(lib lib/libjpeg.a)
endif()

list(JOIN pdfium_flags " " flags)

declare_port(
  "github:libjpeg-turbo/libjpeg-turbo#c85e6b905bf237038faa936dab160ebfc5da0344"
  jpeg
  BYPRODUCTS ${lib}
  ARGS
    "-DCMAKE_C_FLAGS=${flags}"
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
