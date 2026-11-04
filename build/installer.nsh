; 自定义 NSIS 片段：在 OneDrive 重定向桌面下也能正确创建快捷方式
!macro customInstall
  SetShellVarContext current
  CreateShortCut "$DESKTOP\Xiao Ai Speaker.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  ; 清理改名前的旧快捷方式，避免桌面/开始菜单出现两个入口
  Delete "$DESKTOP\小爱音箱控制台.lnk"
  Delete "$SMPROGRAMS\小爱音箱控制台.lnk"
!macroend

!macro customUnInstall
  SetShellVarContext current
  Delete "$DESKTOP\Xiao Ai Speaker.lnk"
  Delete "$SMPROGRAMS\Xiao Ai Speaker.lnk"
  Delete "$DESKTOP\小爱音箱控制台.lnk"
  Delete "$SMPROGRAMS\小爱音箱控制台.lnk"
!macroend
