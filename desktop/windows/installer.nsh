; Clean Explorer context-menu verbs (HKCU) and the Win11 sparse package.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\FreeBuddy"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\FreeBuddy"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\FreeBuddy"
  DeleteRegKey HKCU "Software\Classes\*\shell\FreeBuddy"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\FreeBuddyDev"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\FreeBuddyDev"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\FreeBuddyDev"
  DeleteRegKey HKCU "Software\Classes\*\shell\FreeBuddyDev"
  IfFileExists "$INSTDIR\uninstall-explorer-command.ps1" 0 skip_explorer_pkg
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\uninstall-explorer-command.ps1"'
  skip_explorer_pkg:
!macroend
