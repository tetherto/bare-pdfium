include_guard(GLOBAL)

fetch_archive(
  harfbuzz
  "https://github.com/harfbuzz/harfbuzz/archive/886fc1e645388080b72f6d9b06347533a0018045.tar.gz"
  93758d68c3c5b8ede85a89b5204819c082410d28464d8bd3b99befdaf9a98093
  SOURCE_DIR harfbuzz_dir
)

add_library(harfbuzz STATIC)

target_sources(
  harfbuzz
  PRIVATE
    ${harfbuzz_dir}/src/harfbuzz-subset.cc
)

target_include_directories(
  harfbuzz
  PUBLIC
    ${harfbuzz_dir}/src
)
