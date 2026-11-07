; dsh-automation-suite desktop installer (Phase 2 skeleton).
;
; Build with desktop/build-installer.ps1, which passes:
;   /DAppVersion=<x.y.z>
;   /DSourceApp=<...\dist\desktop\<ver>\app>
;   /DSourceShell=<...\app\shell>
;   /DOutputDir=<...\dist\desktop\<ver>>
;
; It installs per-user under %LOCALAPPDATA%\dsh-automation-suite, copies the
; materialized app layer (no pnpm/network), installs the stable shell + shortcut,
; writes current.txt, and leaves DSH_HOME untouched. DSH is still a prerequisite
; (the bootstrap installer is the next Phase 2 step).

#ifndef AppVersion
  #define AppVersion "0.2.0"
#endif
#ifndef SourceApp
  #define SourceApp "..\dist\desktop\0.2.0\app"
#endif
#ifndef SourceShell
  #define SourceShell "..\dist\desktop\0.2.0\app\shell"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist\desktop\0.2.0"
#endif

#define AppName "DSH Automation Suite"
#define AppPublisher "dsh-automation-suite"
#define AppId "DshAutomationSuite"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\dsh-automation-suite
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=dsh-automation-suite-setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\shell\DshSuite.Shell.exe
DisableWelcomePage=no
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
; Materialized profile: node_modules is already present in the source app layer.
Source: "{#SourceApp}\profile\*"; DestDir: "{app}\app\{#AppVersion}\profile"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceApp}\app-manifest.json"; DestDir: "{app}\app\{#AppVersion}"; Flags: ignoreversion
Source: "{#SourceApp}\manifest.json"; DestDir: "{app}\app\{#AppVersion}"; Flags: ignoreversion
Source: "{#SourceApp}\doctor.ps1"; DestDir: "{app}\app\{#AppVersion}"; Flags: ignoreversion
Source: "{#SourceApp}\test-doctor-json.ps1"; DestDir: "{app}\app\{#AppVersion}"; Flags: ignoreversion
; The shell is stable; the app layer is versioned.
Source: "{#SourceShell}\*"; DestDir: "{app}\shell"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\shell\DshSuite.Shell.exe"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\shell\DshSuite.Shell.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\shell\DshSuite.Shell.exe"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: files; Name: "{app}\current.txt"
Type: dirifempty; Name: "{app}\app\{#AppVersion}"
Type: dirifempty; Name: "{app}\app"
Type: dirifempty; Name: "{app}"

[Code]
function InitializeSetup(): Boolean;
var
  Dsh: string;
begin
  Result := True;
  Dsh := ExpandConstant('{localappdata}\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd');
  if not FileExists(Dsh) then
  begin
    MsgBox('DeepSeek Harness was not found in the default location.' + #13#10 +
           'Install DeepSeek Harness first, then run this installer again.' + #13#10 +
           'The app layer is installed without pnpm and does not need the npm registry.',
           mbInformation, MB_OK);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    ForceDirectories(ExpandConstant('{app}'));
    SaveStringToFile(ExpandConstant('{app}\current.txt'), '{#AppVersion}', False);
  end;
end;
