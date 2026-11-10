# Third-party software

The built extension bundles these libraries:

| Library | Licence | Source |
|---|---|---|
| PDF.js (`pdfjs-dist`) | Apache-2.0 | https://github.com/mozilla/pdf.js |
| React, React DOM | MIT | https://github.com/facebook/react |
| fflate | MIT | https://github.com/101arrowz/fflate |

Their licence texts ship with each package under `node_modules/<package>/LICENSE`.
Development-only dependencies (build tools, test libraries, the date-picker
libraries used by `tests/e2e/dates`) are not part of the extension.
