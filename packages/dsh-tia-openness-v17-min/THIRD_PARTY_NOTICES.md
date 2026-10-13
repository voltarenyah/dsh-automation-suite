# Third-party notices

This plugin's C# controller is built against **Siemens AG** NuGet packages. Nothing
else in this repository is third-party code: the TypeScript plugin and the C#
controller sources are MIT (see [LICENSE](LICENSE)).

## Siemens packages

| Package | Version used here | Role | Where its files end up |
|---|---|---|---|
| `Siemens.Collaboration.Net.TiaPortal.Packages.Openness` | `17.0.1685432625` | **Build time only** — MSBuild `props`/`targets` that locate the Siemens.Engineering assemblies (TIA Portal registry entries → `TiaPortalLocation` → default path) and add them as `<Reference>` with `CopyLocal=false` | No files in the output. `Siemens.Engineering.dll` / `.Hmi.dll` are referenced from the local TIA Portal installation and are **never copied** |
| `Siemens.Collaboration.Net.TiaPortal.Openness.Resolver` | `1.1.1725480302` | **Run time** — registers Siemens' assembly resolver and selects the `Siemens.Engineering` assembly matching the version the controller was built against | `controller/bin/Siemens.Collaboration.Net.TiaPortal.Openness.Resolver.dll` (38 KB) |
| `Siemens.Collaboration.Net` | `3.0.1725521661` | Run time dependency of the resolver | `controller/bin/Siemens.Collaboration.Net.dll` (23 KB) |
| `Siemens.Collaboration.Net.CoreExtensions` | `3.0.1725521661` | Run time dependency of the resolver | `controller/bin/Siemens.Collaboration.Net.CoreExtensions.dll` (609 KB) |
| `Siemens.Collaboration.Net.Logging` | `3.0.1725521661` | Run time dependency of the resolver | `controller/bin/Siemens.Collaboration.Net.Logging.dll` (47 KB) |
| `Siemens.Collaboration.Net.OperatingSystem.Windows` | `3.0.1725521661` | Run time dependency of the resolver | `controller/bin/Siemens.Collaboration.Net.OperatingSystem.Windows.dll` (147 KB) |
| `Siemens.Collaboration.Net.Windows.Authentication` | `3.0.1725521661` | Run time dependency of the resolver | `controller/bin/Siemens.Collaboration.Net.Windows.Authentication.dll` (26 KB) |

Microsoft .NET Framework support assemblies (`System.CodeDom`, `System.IO.FileSystem.AccessControl`,
`System.Security.AccessControl`, `System.Security.Principal.Windows`) are pulled in
transitively by the resolver as well; they are ordinary NuGet libraries under their
respective Microsoft licenses.

### Version rules

* The **reference package version tracks the TIA Portal version**: `17.0.x` for V17,
  `18.0.x` for V18, …, `21.0.x` for V21. A plugin built for another TIA Portal
  version bumps this one line.
* The **resolver has two incompatible lines**: `1.1.x` supports TIA Portal below
  V21, `2.0.x` is V21+ only (Siemens' own warning: V21 introduced breaking Openness
  API changes). A V17 controller therefore pins `1.1.1725480302`.
* `Siemens.Collaboration.Net.OperatingSystem.Windows` is pinned explicitly because
  the resolver's declared dependency version is no longer published; without the pin
  NuGet resolves an approximate match and warns `NU1603`.

## License of the Siemens packages

Each package carries `LICENSE_NuGet.org.md`: *"Royalty-free Software provided by
Siemens on sharing platforms for developers/users of Siemens products"*
(`requireLicenseAcceptance=true`). Its section 2 additionally applies the **MIT
License (Copyright 2022 Siemens AG)** to source code the Software contains or
generates.

What that means in practice, and where the boundary is:

* **Using the packages** (restoring them from NuGet, referencing them, shipping an
  application that links them) is what they are published for; section 1.1 limits use
  to "the development and test of software which can be used with Siemens products",
  which is exactly what this plugin is.
* **`Siemens.Engineering.dll` is never redistributed by this repository**: the
  reference package sets `CopyLocal=false`, so the file stays in the user's own TIA
  Portal installation. This plugin has no Siemens Openness API binary of its own.
* **The resolver chain's DLLs are redistributed** as part of
  `controller/bin/` (about 889 KB across the six Siemens assemblies, 1.1 MB total
  with the Microsoft support assemblies). They are shipped **unmodified**, together
  with this notice and a link to the license, and are not sold. Section 1.1 says the
  Software may not be decompiled, extracted, modified or distributed unless section
  2's open-source license grants it, and section 2 grants MIT *for source code*; the
  permissive reading is that shipping these publicly published, unmodified SDK
  libraries as part of an application that uses them is the intended consumption,
  while the strict reading is that object-code redistribution needs Siemens'
  confirmation.
* Siemens reserves the right to change the Software at any time; the packages are
  provided without warranty, and compliance with export-control regulations is the
  user's responsibility (the license has a dedicated section).

### Prefer a strictly "no Siemens binary" distribution?

`controller/bin/` needs the resolver DLLs at run time, so the two options are:

1. **Do not ship a prebuilt controller.** Remove the Siemens binaries from the
   distributed copy and let each installation build it:
   ```powershell
   git rm --cached controller/bin/Siemens.Collaboration.Net*.dll
   # in the distributed README:
   npm run build:controller     # needs .NET SDK, a NuGet feed, and TIA Portal V17 installed
   ```
2. **Ask Siemens** (SIOS support entry for the resolver:
   <https://support.industry.siemens.com/cs/ww/en/view/109815895>) whether object-code
   redistribution of these packages is permitted for a free, non-commercial
   distribution. That is the only authoritative answer.

The reference package (`Packages.Openness`) is safe under either posture: it
contributes no binaries at all.

## Official sources

* Reference package: <https://www.nuget.org/packages/Siemens.Collaboration.Net.TiaPortal.Packages.Openness>
* Resolver: <https://www.nuget.org/packages/Siemens.Collaboration.Net.TiaPortal.Openness.Resolver>
* Resolver documentation (SIOS): <https://support.industry.siemens.com/cs/ww/en/view/109815895>
* TIA Portal Openness manual: <https://support.industry.siemens.com/cs/ww/en/view/109798533>

Siemens, SIMATIC, STEP 7 and TIA Portal are trademarks of Siemens AG. This project
is not affiliated with or endorsed by Siemens AG.
