# Third-party notices

This package bundles or depends on the following third-party software.

## @e965/xlsx

- Package: `@e965/xlsx`
- Version: 0.20.x
- License: Apache-2.0
- Copyright: SheetJS contributors and the @e965 fork contributors
- Use: read and write the TIA Portal project-texts XLSX in
  `src/project-text/xlsx.ts`. The maintained SheetJS fork is used because TIA's
  export uses a non-default OOXML flavour that ExcelJS cannot read.

The full Apache-2.0 text is available in the installed package's `LICENSE` file
and at <https://github.com/e965/xlsx>.

## fflate

- Package: `fflate`
- Version: 0.8.x
- License: MIT
- Copyright: Arjun Barrett
- Use: read the TIA project archive (`.zap17`, a ZIP) in
  `src/handoff/zip.ts` so the handoff marker and the root `.ap17` can be checked
  before TIA is touched.

The full MIT text is available in the installed package's `LICENSE` file and at
<https://github.com/101arrowz/fflate>.
