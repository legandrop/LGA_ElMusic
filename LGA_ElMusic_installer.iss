; LGA_ElMusic_installer.iss -- fuente escrita a mano, no generada (mismo esquema que LGA_MightyTools).
; scripts/installer-win.mjs le pasa la version X.YY (sale de package.json) y la carpeta win-unpacked ya firmada
; con Castlabs EVS, y no lo reescribe. Inno copia los archivos tal cual: la firma (LGA_El_Music.exe.sig) sigue valida.

#ifndef MyAppVersion
  #error Falta /DMyAppVersion
#endif
#ifndef SourceDir
  #error Falta /DSourceDir (carpeta win-unpacked firmada con EVS)
#endif
#define MyAppName "El Music"
#define MyAppExeName "LGA_El_Music.exe"

[Setup]
AppId={{CBA13BE4-7BCE-4FCC-8DE8-075B7AA22E12}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher=LGA
AppPublisherURL=https://github.com/legandrop/LGA_ElMusic
AppUpdatesURL=https://github.com/legandrop/LGA_ElMusic/releases
VersionInfoVersion={#MyAppVersion}
; Carpeta de las apps LGA: escribible por el usuario, sin permisos de administrador. La app guarda ahi su carpeta
; data (sesion de Apple, Widevine, caches) y baja ahi los instaladores de las actualizaciones.
DefaultDirName=C:\Portable\LGA\ElMusic
; Reinstalar o actualizar va a la carpeta donde ya esta (el actualizador ademas la pasa con /DIR).
UsePreviousAppDir=yes
DisableDirPage=auto
DirExistsWarning=no
DisableProgramGroupPage=yes
OutputBaseFilename=LGA_ElMusic_Setup_v{#MyAppVersion}
SetupIconFile=resources\app.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
Compression=lzma2
LZMANumBlockThreads=4
SolidCompression=yes
WizardStyle=modern
; La app se cierra por ruta en PrepareToInstall (abajo); el Restart Manager de Inno no hace falta.
CloseApplications=no
RestartApplications=no
ShowLanguageDialog=auto

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; El marcador de prototipo no viaja: una copia instalada es una instalacion real (se registra y se actualiza sola).
Source: "{#SourceDir}\*"; Excludes: ".lga-staging"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Script de cierre por ruta (copia identica de LGA_Base_QT_C_Py). Viaja dos veces: dontcopy para que PrepareToInstall
; lo extraiga a {tmp} (en una actualizacion todavia no hay copia instalada) y en {app}\tools para el desinstalador.
Source: "tools\close_by_path.ps1"; Flags: dontcopy
Source: "tools\close_by_path.ps1"; DestDir: "{app}\tools"; Flags: ignoreversion

[InstallDelete]
; Inno no quita lo que una version nueva deja de traer: resources y locales vienen enteros en cada paquete y no tienen
; datos del usuario (esos viven en {app}\data), asi que se vacian antes de copiar la version nueva.
Type: filesandordirs; Name: "{app}\resources"
Type: filesandordirs; Name: "{app}\locales"

; Inno solo desinstala lo que copio el. Lo que la app escribe por su cuenta se borra aca:
;  - {app}\data: sesion de Apple, Widevine, caches (sellos, New releases), volcados y los instaladores bajados por el
;    actualizador (data\updates).
;  - Las preferencias en %APPDATA%\LGA\ElMusic (ventana, columnas, clave de Last.fm, log de diagnostico) y la entrada
;    del registro compartido de apps LGA. La carpeta LGA solo se borra si queda vacia (la usan otras apps LGA).
[UninstallDelete]
Type: filesandordirs; Name: "{app}\data"
Type: filesandordirs; Name: "{userappdata}\LGA\ElMusic"
Type: files; Name: "{userappdata}\LGA\ElMusic.json"
Type: dirifempty; Name: "{userappdata}\LGA"
Type: dirifempty; Name: "{app}"

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

; La casilla de la ultima pagina vuelve a abrir la app (tambien despues de una actualizacion).
[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[Code]
// La app es de instancia unica y su exe instalado no se puede pisar abierto. Se cierra POR RUTA, nunca por nombre
// (close_by_path.ps1, LGA_Base_QT_C_Py/docs/Doc_Instaladores_Inno.md 5.1):
//   - Al INSTALAR, -AllInstances cierra todas las copias de El Music (la instalada, un build): la que se instala queda
//     como la unica. Una actualizacion llega con la app ya cerrada por su script.
//   - Al DESINSTALAR, -Prefix {app} cierra solo las copias que corren desde la carpeta que se va a borrar.
// Sin PowerShell, o con un {app} que no pasa las guardas del script, no se cierra nada e Inno avisa "archivo en uso":
// es la direccion segura. Las comillas van como #34 y powershell.exe con la ruta de {sys}.
procedure CloseAppByPath(const ScriptPath, CloseParams: String);
var
  ResultCode: Integer;
  Params: String;
begin
  Params := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + #34 + ScriptPath + #34 + ' ' + CloseParams;
  if Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Log('close_by_path ' + CloseParams + ': codigo ' + IntToStr(ResultCode))
  else
    Log('close_by_path no se pudo ejecutar: no se cierra nada');
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  ExtractTemporaryFile('close_by_path.ps1');
  CloseAppByPath(ExpandConstant('{tmp}\close_by_path.ps1'), '-ExeName {#MyAppExeName} -AllInstances');
  // Stop-Process es asincronico: se le da tiempo al proceso a soltar sus archivos antes de copiar encima.
  Sleep(1500);
end;

function InitializeUninstall(): Boolean;
var
  ScriptPath: String;
begin
  Result := True;
  ScriptPath := ExpandConstant('{app}\tools\close_by_path.ps1');
  if FileExists(ScriptPath) then
  begin
    CloseAppByPath(ScriptPath, '-ExeName {#MyAppExeName} -Prefix ' + #34 + ExpandConstant('{app}') + #34);
    Sleep(1500);
  end;
end;
