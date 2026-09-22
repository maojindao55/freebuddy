!include "getProcessInfo.nsh"

Var /GLOBAL pid
!ifndef BUILD_UNINSTALLER
Var /GLOBAL fbLegacyInstallDir
Var /GLOBAL fbLegacyUninstallString
Var /GLOBAL fbLegacyUninstallerFileName
!endif

!macro FreeBuddyCleanExplorerIntegration DIR
  DeleteRegKey HKCU "Software\Classes\Directory\shell\FreeBuddy"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\FreeBuddy"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\FreeBuddy"
  DeleteRegKey HKCU "Software\Classes\*\shell\FreeBuddy"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\FreeBuddyDev"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\FreeBuddyDev"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\FreeBuddyDev"
  DeleteRegKey HKCU "Software\Classes\*\shell\FreeBuddyDev"
  IfFileExists "${DIR}\uninstall-explorer-command.ps1" 0 +2
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${DIR}\uninstall-explorer-command.ps1"'
!macroend

!macro FreeBuddyRemoveInstallDir DIR
  ClearErrors
  ${if} ${FileExists} "${DIR}\*.*"
    SetOutPath $PLUGINSDIR
    RMDir /r "$PLUGINSDIR\freebuddy-empty-dir"
    CreateDirectory "$PLUGINSDIR\freebuddy-empty-dir"
    ClearErrors
    nsExec::ExecToLog '"$SYSDIR\robocopy.exe" "$PLUGINSDIR\freebuddy-empty-dir" "${DIR}" /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP'
    Pop $0
    ${if} $0 <= 7
      RMDir "${DIR}"
    ${else}
      DetailPrint "Failed to remove ${DIR}: robocopy exit code $0"
      SetErrors
    ${endif}
  ${endif}
!macroend

!macro FreeBuddyResolveLegacyInstallDir
  StrCpy $fbLegacyInstallDir ""
  StrCpy $fbLegacyUninstallString ""
  StrCpy $fbLegacyUninstallerFileName ""

  !insertmacro readReg $fbLegacyUninstallString SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ${if} $fbLegacyUninstallString == ""
      !insertmacro readReg $fbLegacyUninstallString SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    ${endif}
  !endif

  ${if} $fbLegacyUninstallString != ""
    !insertmacro GetInQuotes $fbLegacyUninstallerFileName "$fbLegacyUninstallString"
    !insertmacro readReg $fbLegacyInstallDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $fbLegacyInstallDir == ""
    ${andIf} $fbLegacyUninstallerFileName != ""
      Push $fbLegacyUninstallerFileName
      Call GetFileParent
      Pop $fbLegacyInstallDir
    ${endif}
  ${endif}
  ClearErrors
!macroend

!macro FreeBuddyClearLegacyUninstallEntries
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"
  DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY_2}" "QuietUninstallString"
    DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
    DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY_2}" "QuietUninstallString"
  !endif
  ClearErrors
!macroend

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING

  !ifndef BUILD_UNINSTALLER
    ${if} ${isUpdated}
      !insertmacro FreeBuddyResolveLegacyInstallDir
      ${if} $fbLegacyInstallDir != ""
      ${andIf} ${FileExists} "$fbLegacyInstallDir\resources\pi-runtime\runtime\node_modules\*.*"
        DetailPrint "Removing legacy FreeBuddy installation with long paths..."
        !insertmacro FreeBuddyCleanExplorerIntegration "$fbLegacyInstallDir"
        !insertmacro FreeBuddyRemoveInstallDir "$fbLegacyInstallDir"
        ${ifNot} ${Errors}
          !insertmacro FreeBuddyClearLegacyUninstallEntries
        ${endif}
      ${endif}
    ${endif}
  !endif
!macroend

!macro customRemoveFiles
  !insertmacro FreeBuddyRemoveInstallDir "$INSTDIR"
  ${if} ${Errors}
    Abort "Failed to remove '$INSTDIR'"
  ${endif}
!macroend

; Clean Explorer context-menu verbs (HKCU) and the Win11 sparse package.
!macro customUnInstall
  !insertmacro FreeBuddyCleanExplorerIntegration "$INSTDIR"
!macroend
