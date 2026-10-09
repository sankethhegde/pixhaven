; Explorer right-click on a folder: "Sort by person with PixHaven" (per-user, removed on uninstall).
!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\PixHaven.SortByPerson" "" "Sort by person with PixHaven"
  WriteRegStr HKCU "Software\Classes\Directory\shell\PixHaven.SortByPerson" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\PixHaven.SortByPerson\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --sort "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\PixHaven.SortByPerson"
!macroend
