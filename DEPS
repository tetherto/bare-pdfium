# Fetches PDFium and its dependencies with gclient, the way
# holepunchto/chromium-prebuilds fetches Chromium. See README.md.

gclient_gn_args_from = "pdfium"

vars = {
  "pdfium_git": "https://pdfium.googlesource.com",
  "pdfium_revision": "fc46361ce75055cd549cb938fae5d6a3fe3a1a05",
}

deps = {
  "pdfium": {
    "url": Var("pdfium_git") + "/pdfium.git@" + Var("pdfium_revision"),
  },
}

recursedeps = [
  "pdfium",
]
