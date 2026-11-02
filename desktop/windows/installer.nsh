!include "getProcessInfo.nsh"

Var /GLOBAL pid
!ifndef BUILD_UNINSTALLER
Var /GLOBAL fbLegacyInstallDir
Var /GLOBAL fbLegacyUninstallString
Var /GLOBAL fbLegacyUninstallerFileName
!endif

!macro customInit
  ; electron-builder starts in $INSTDIR. Release that directory before it
  ; launches an older uninstaller, whose final RMDir would otherwise fail
  ; even after all application processes and files are gone.
  InitPluginsDir
  SetOutPath $PLUGINSDIR
!macroend

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
    ${if} $0 == "error"
    ${orIf} $0 == "timeout"
    ${orIf} $0 > 7
      DetailPrint "Failed to remove ${DIR}: robocopy exit code $0"
      SetErrors
    ${else}
      ${if} ${isUpdated}
        ; The replacement files will reuse this directory. Older installers
        ; (or a terminal) may still hold its current-directory handle, so an
        ; empty root must not turn a successful file cleanup into a failure.
        ; Robocopy can return < 8 even when an extra file could not be purged.
        ; Verify that no files or subdirectories remain before proceeding.
        Push $1
        Push $2
        StrCpy $0 0
        FindFirst $1 $2 "${DIR}\*"
        ${if} ${Errors}
          StrCpy $0 1
        ${else}
          ${DoWhile} $2 != ""
            ${if} $2 != "."
            ${andIf} $2 != ".."
              StrCpy $0 1
              ${ExitDo}
            ${endif}
            FindNext $1 $2
          ${Loop}
          FindClose $1
        ${endif}
        ${if} $0 == 0
          ClearErrors
          DetailPrint "Keeping empty installation directory for update: ${DIR}"
        ${else}
          DetailPrint "Failed to empty installation directory: ${DIR}\$2"
          SetErrors
        ${endif}
        Pop $2
        Pop $1
      ${else}
        RMDir "${DIR}"
      ${endif}
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

; Log every process still running under $INSTDIR so "app cannot be closed"
; reports name the actual offender (leftover agent helpers are often named
; node.exe/winpty-agent.exe, not FreeBuddy.exe).
!macro FreeBuddyLogInstDirProcesses
  ${if} $IsPowerShellAvailable == 0
    nsExec::ExecToLog `"$PowerShellPath" -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | % { 'still running: PID=' + $$_.ProcessId + ' ' + $$_.Path }"`
  ${else}
    nsExec::ExecToLog `"$CmdPath" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%" /FO LIST`
  ${endif}
!macroend

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE

  ${if} ${isUpdated}
    ; Builds <= 0.10.8 orphan agent/runtime helpers under $INSTDIR on quit
    ; (pi-acp may even run FreeBuddy.exe itself as Node). Sweep them with a
    ; longer grace window than the stock check so it rarely has to prompt.
    ${GetProcessInfo} 0 $pid $1 $2 $3 $4
    ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
      Sleep 500
      StrCpy $R2 0
      ${Do}
        IntOp $R2 $R2 + 1
        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 != 0
          ${ExitDo}
        ${endif}
        DetailPrint "Terminating leftover FreeBuddy processes (attempt $R2)..."
        !insertmacro FreeBuddyLogInstDirProcesses
        ${if} $R2 > 1
          !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1
        ${else}
          !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0
        ${endif}
        Sleep 1500
      ${LoopUntil} $R2 >= 6
    ${endif}
  ${endif}

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
