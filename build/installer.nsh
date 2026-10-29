; 自定义 NSIS 片段：在 OneDrive 重定向桌面下也能正确创建快捷方式
!macro customInstall
  SetShellVarContext current
  CreateShortCut "$DESKTOP\小爱音箱控制台.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  SetShellVarContext current
  Delete "$DESKTOP\小爱音箱控制台.lnk"
  Delete "$SMPROGRAMS\小爱音箱控制台.lnk"
!macroend
