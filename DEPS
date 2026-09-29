# Fetches PDFium and its dependencies with gclient, the way
# holepunchto/chromium-prebuilds fetches Chromium. See README.md.

gclient_gn_args_from = "pdfium"

vars = {
  "pdfium_git": "https://pdfium.googlesource.com",
  # The PDFium that Chrome's current Stable release ships, 154.0.8037.57.
  "pdfium_revision": "2358b16c1947eff67f0732754af6b3c4e1715ff9",
}

deps = {
  "pdfium": {
    "url": Var("pdfium_git") + "/pdfium.git@" + Var("pdfium_revision"),
  },
}

recursedeps = [
  "pdfium",
]
