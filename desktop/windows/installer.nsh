; Clean Explorer context-menu verbs registered at runtime (HKCU).
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\FreeBuddy"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\FreeBuddy"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\FreeBuddy"
  DeleteRegKey HKCU "Software\Classes\*\shell\FreeBuddy"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\FreeBuddyDev"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\FreeBuddyDev"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\FreeBuddyDev"
  DeleteRegKey HKCU "Software\Classes\*\shell\FreeBuddyDev"
!macroend
