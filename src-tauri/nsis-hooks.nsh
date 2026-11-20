; Termix 卸载清理：
; - 交互式卸载时询问是否删除全部数据；
; - 删除安装目录下的 data / downloads、AppData 与 WebView2 数据；
; - 自定义下载目录只在明确确认后删除，并跳过盘符根目录和常见用户目录。

!include "StrFunc.nsh"
${Using:StrFunc} StrStr

Var TermixDeleteAllData

!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $TermixDeleteAllData 0
  ; 安装器升级时以 _?= 调用旧卸载器，属于覆盖安装，不能清理业务数据
  ${StrStr} $0 "$CMDLINE" "_?="
  ${If} $0 != ""
    Goto termix_skip_all_data
  ${EndIf}
  ; 升级/覆盖安装由安装器以 /UPDATE 调用卸载器，必须保留数据
  ${If} $UpdateMode = 1
    Goto termix_skip_all_data
  ${EndIf}
  IfSilent termix_skip_all_data
  ${If} $PassiveMode = 1
    Goto termix_skip_all_data
  ${EndIf}

  MessageBox MB_YESNO|MB_ICONEXCLAMATION "卸载将删除 Termix 的全部数据：$\r$\n数据库、备份、WebView 缓存和默认下载目录。$\r$\n$\r$\nUninstall will delete all Termix data: database, backups, WebView cache, and default downloads.$\r$\n$\r$\n是否继续？ / Continue?" IDNO termix_skip_all_data

  StrCpy $TermixDeleteAllData 1
  ; 由本 hook 统一处理，避免模板内置复选框重复删除
  StrCpy $DeleteAppDataCheckboxState 0
  Goto termix_preuninstall_done

  termix_skip_all_data:
    ; 用户拒绝或静默卸载：不删除业务数据，也阻止内置复选框删除 AppData
    StrCpy $DeleteAppDataCheckboxState 0

  termix_preuninstall_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $TermixDeleteAllData = 1
    SetShellVarContext current

    ; 先读取自定义下载目录标记，再删除 data 目录
    StrCpy $0 ""
    ${If} ${FileExists} "$INSTDIR\data\download_dir.txt"
      FileOpen $1 "$INSTDIR\data\download_dir.txt" r
      FileReadUTF16LE $1 $0
      FileClose $1
    ${ElseIf} ${FileExists} "$APPDATA\${BUNDLEID}\download_dir.txt"
      FileOpen $1 "$APPDATA\${BUNDLEID}\download_dir.txt" r
      FileReadUTF16LE $1 $0
      FileClose $1
    ${EndIf}

    RMDir /r /REBOOTOK "$INSTDIR\data"
    RMDir /r /REBOOTOK "$INSTDIR\downloads"
    RmDir /r /REBOOTOK "$APPDATA\${BUNDLEID}"
    RmDir /r /REBOOTOK "$LOCALAPPDATA\${BUNDLEID}"
    ; 兼容历史版本的标识/目录
    RmDir /r /REBOOTOK "$APPDATA\com.termix.app"
    RmDir /r /REBOOTOK "$LOCALAPPDATA\com.termix.app"
    RmDir /r /REBOOTOK "$APPDATA\com.termix"
    RmDir /r /REBOOTOK "$LOCALAPPDATA\com.termix"
    RmDir /r /REBOOTOK "$APPDATA\Termix"
    RmDir /r /REBOOTOK "$LOCALAPPDATA\Termix"

    ${If} $0 != ""
    ${AndIf} $0 != "$INSTDIR"
      StrLen $2 $0
      ; 跳过盘符根目录和过短路径
      ${If} $2 > 4
        ; 跳过安装目录的父目录，避免误删同级其他程序
        StrCpy $3 $INSTDIR $2
        ${If} $3 == $0
          DetailPrint "Termix: skipped parent of install dir: $0"
          Goto termix_skip_custom_download
        ${EndIf}
        StrCpy $3 $0 2
        ${If} $3 == "\\"
          DetailPrint "Termix: skipped UNC download path: $0"
          Goto termix_skip_custom_download
        ${EndIf}
        ; 跳过常见的共享用户目录，避免误删整个 Downloads/Desktop/Documents
        ${If} $0 == "$PROFILE"
        ${OrIf} $0 == "$DESKTOP"
        ${OrIf} $0 == "$DOCUMENTS"
        ${OrIf} $0 == "$DOWNLOAD"
        ${OrIf} $0 == "$PROGRAMFILES"
        ${OrIf} $0 == "$PROGRAMFILES64"
        ${OrIf} $0 == "$WINDIR"
        ${OrIf} $0 == "$SYSDIR"
        ${OrIf} $0 == "$TEMP"
        ${OrIf} $0 == "$APPDATA"
        ${OrIf} $0 == "$LOCALAPPDATA"
          DetailPrint "Termix: skipped shared download path: $0"
          Goto termix_skip_custom_download
        ${EndIf}

        MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONEXCLAMATION "同时删除自定义下载目录？$\r$\n$0$\r$\n$\r$\nAlso delete this custom download folder?" IDNO termix_skip_custom_download
        RMDir /r /REBOOTOK "$0"
      ${EndIf}
    ${EndIf}

    termix_skip_custom_download:
      RMDir "$INSTDIR"
  ${EndIf}
!macroend
