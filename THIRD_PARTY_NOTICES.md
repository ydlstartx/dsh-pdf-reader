# Third-party notices

`dsh-pdf-reader` bundles third-party software and data so PDF rendering and
explicitly authorized OCR can work without a separate asset server. Those
components remain available under their own licenses; the project's MIT
license does not replace them.

## Direct runtime dependencies

| Component | Version | License | Project |
| --- | --- | --- | --- |
| PDF.js (`pdfjs-dist`) | 6.2.108 | Apache-2.0 | <https://github.com/mozilla/pdf.js> |
| pdf-lib | 1.17.1 | MIT | <https://github.com/Hopding/pdf-lib> |
| PaddleOCR.js | 0.4.2 | Apache-2.0 | <https://github.com/PaddlePaddle/PaddleOCR> |

## Runtime components included through PaddleOCR.js

| Component | Version | License | Project |
| --- | --- | --- | --- |
| OpenCV.js (`@techstark/opencv-js`) | 4.10.0-release.1 | Apache-2.0 | <https://github.com/TechStark/opencv-js> |
| ONNX Runtime Web | 1.27.0 | MIT | <https://github.com/microsoft/onnxruntime> |
| Clipper | 6.4.2 | Boost Software License | <https://sourceforge.net/projects/jsclipper/> |

## PDF.js packaged data

The client bundle embeds selected files from the official `pdfjs-dist`
distribution, including Adobe CMaps, Foxit/Liberation fallback fonts, and the
OpenJPEG, JBIG2 and QCMS WebAssembly decoders. Their copyright notices and
license terms are distributed with PDF.js under `cmaps/`, `standard_fonts/`
and `wasm/` and are incorporated here by reference:

- <https://github.com/mozilla/pdf.js/tree/master/external/bcmaps>
- <https://github.com/mozilla/pdf.js/tree/master/external/standard_fonts>
- <https://github.com/mozilla/pdf.js/tree/master/external/openjpeg>
- <https://github.com/mozilla/pdf.js/tree/master/external/qcms>

The complete Apache License 2.0 and Boost Software License 1.0 texts are
included in the release under `LICENSES/`. Component-specific copyright and
asset notices remain listed above and in the linked upstream distributions.

This inventory describes the runtime dependency versions locked for the
`0.1.0-beta.3` release. Regenerate and review it whenever those dependencies change.
