# WPS 加载项

这是 WPS 桌面端内嵌加载项源代码，不是供用户在浏览器中操作的 OA 网页。

## 本机安装与调试

要求 Windows 桌面 WPS、Node.js 20 或更新版本和 npm。首次使用，在本目录执行：

```powershell
npm install
npm run debug
```

`debug` 会启动本地加载项开发服务，将当前项目以开发模式注册到当前 Windows 用户的 WPS 加载项配置，并启动 WPS。保持该命令窗口运行以提供加载项页面和热更新；结束调试时按 `Ctrl+C`。再次运行 `npm run debug` 即可重新加载。

表格和演示组件使用单独的 WPSJS 注册类型，但共用本目录的加载项界面和同步代码。首次执行根目录的 `npm install` 后，可分别从 `client/addin/` 运行：

```powershell
npm run debug:et
npm run debug:wpp
```

这两个命令分别以 `et` 和 `wpp` 类型注册同一加载项，并启动对应 WPS 组件。三个调试入口使用不同的加载项名称，因而可同时保留注册；调试进程需保持运行。结束时在对应命令窗口按 `Ctrl+C`。

因此这是同一插件代码的三个组件注册入口，不是三份独立插件；Writer、ET、WPP 的 JSAPI 事件按组件分别适配。

ET 和 WPP 的构建命令为 `npm run build:et` 和 `npm run build:wpp`；Writer 使用 `npm run build`。第三方本机安装时由下文的安装脚本注册三种组件。

另开一个 PowerShell 窗口，在仓库根目录配置并启动文件服务：

```powershell
Copy-Item .env.example .env
# 编辑 .env：将 WPS_CLOUD_TOKEN 与 WPS_CLOUD_SIGNING_KEY 替换为不同的强随机值
npm run server
```

在 WPS“个人云盘”选项卡打开“云盘与设置”，填写 `http://127.0.0.1:8787`、`.env` 中的 `WPS_CLOUD_TOKEN` 和目标目录 ID，保存设置后测试连接。然后从本地打开一个文档并保存，检查面板同步状态和服务端文件列表。

设置面板提供两个独立开关：“保存后自动同步”控制 WPS 保存事件是否上传；“空闲后自动保存并同步云端差异”开启后，监听 WPS 文档内容变化事件，停止编辑达到设定时间（默认 5 秒，可设 1–60 秒）后调用 WPS 保存到原本地路径；随后对已关联云端的文件按 SHA-256 比较内容，只有内容不同时才上传为新版本。另保留每 60 秒的差异检查，用于发现本地磁盘上的外部变化。关闭后者并保存设置即可停止自动保存和后台比较。文档须先通过一次保存同步建立本地路径与云端文件 ID 的关联。

调试器使用 WPSJS 的本地开发加载机制，不需要打开 OA 页面。当前 WPSJS 在调试时会写入 `%APPDATA%\kingsoft\wps\jsaddons\publish.xml` 以注册此加载项；该文件不属于仓库。停止调试按 `Ctrl+C`。如需永久移除，在该文件中只删除 `name="wps-personal-cloud-addin"`、`name="wps-personal-cloud-et"` 和 `name="wps-personal-cloud-wpp"` 对应的 `jspluginonline` 项，保留其它加载项配置。

WPS 加载项本身以嵌入式 HTML/JavaScript 页面运行。文档保存和云同步逻辑在 WPS 进程中的加载项内执行；正常编辑不需要切换到浏览器网页。

## 第三方本机安装和卸载

这里使用 WPS 本机 `jsaddons/publish.xml` 注册方式，将构建后的静态文件安装到当前 Windows 用户目录；不调用 WPS 官方发布服务，也不需要 OA 网页。安装后 WPS 直接从本机加载加载项资源。此方式适用于本机个人使用；给其他电脑安装时，需要把构建资源和安装脚本一起复制过去。

先关闭所有 WPS 窗口，并打开 PowerShell 7。假设仓库位于 `D:\Project\wps-cloud`，请从仓库根目录构建 Writer、ET、WPP 三种组件：

```powershell
Set-Location D:\Project\wps-cloud
Push-Location .\client\addin
npm install
npm run build
npm run build:et
npm run build:wpp
Pop-Location
```

构建完成后，在仓库根目录运行安装脚本：

PowerShell 7 的命令名是 `pwsh`；Windows 自带的 `powershell` 仍是 5.1。安装时使用：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\client\addin\scripts\Install-WpsPersonalCloud.ps1
```

脚本会将三种组件分别复制到 `%APPDATA%\kingsoft\wps\jsaddons\` 下的版本目录，并在 `publish.xml` 中注册 Writer、ET、WPP 入口。修改现有 `publish.xml` 前会创建带时间戳的备份，并保留其它加载项配置。脚本只安装本机 WPS 加载项；文件同步服务仍需单独启动并在插件设置中配置服务器地址和令牌。安装后重新启动 WPS，在文字、表格、演示组件的“个人云盘”选项卡打开“云盘与设置”。

卸载前先关闭所有 WPS 窗口，在仓库根目录运行：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\client\addin\scripts\Uninstall-WpsPersonalCloud.ps1
```

卸载脚本仅移除此加载项对应的 `publish.xml` 注册项和版本目录；会备份修改前的注册文件，不删除仓库源代码、云端服务、服务端数据或 `.env`。完成后重新启动 WPS。调试期间使用 `npm run debug` 注册的同名入口也会一并移除；需要重新调试时再次运行对应的 `debug` 命令。

上述目录与注册方式依据 WPSJS Windows 调试/离线加载项使用的 `%APPDATA%\kingsoft\wps\jsaddons\publish.xml` 位置。不同 WPS 发行版可能对本地离线加载项策略有所限制；若重启后入口未显示，请先核对 WPS 版本和本机 `publish.xml` 是否仍保留这些注册项。

`targets/et/` 和 `targets/wpp/` 是轻量组件入口：各自声明 WPSJS 的 `addonType`，并从父目录复制共享界面资源。此安装步骤只使用本地构建产物，不运行 WPSJS 的官方 `publish` 命令。

## 同步行为

- Writer 使用 `FileAfterSave`、`DocumentChange` 和 `ContentChange` 事件；ET 使用 `FileAfterSave` 与 `SheetChange`；WPP 使用 `FileAfterSave` 与 `WindowSelectionChange`。WPP 没有公开的内容变化事件，`WindowSelectionChange` 仅表示选区变化，空闲后会再检查 `Presentation.Saved`，只有确有未保存修改才调用 `Save()`。这属于尽力而为的适配，不能保证精确反映每次按键或对象内容修改。
- ET 检测到单元格修改后，面板同步状态会显示等待空闲保存；“上传队列”只统计正在上传或失败待重试的任务，不统计空闲计时中的文档。
- 本地保存完成后上传受支持的 Office 文档；上传失败最多自动重试三次。
- 可选开启编辑空闲后自动保存（默认等待 5 秒，可配置 1–60 秒）：Writer 监听 `DocumentChange`/`ContentChange`，ET 监听 `SheetChange`，WPP 以选区变化事件作近似触发并检查 `Presentation.Saved`。检测到修改并空闲后调用当前文档 `Save()`，再将文件加入同步队列；首次使用也会由此建立云端映射。WPP 事件只反映选区变化，不保证捕获所有编辑活动。每 60 秒另行比较已关联文档的本地文件内容与云端 SHA-256，仅当内容不同时才上传新版本。远端版本发生并发更新时会报告冲突。
- 上传重试耗尽后，任务保存在本机待同步队列；重启 WPS 或点击面板中的“重试待同步文件”可继续。
- 从本地路径打开的文档继续保留在原位置，保存后按本机 ID 与本地路径摘要绑定到云端文件 ID。
- 云端列表中的文档按云端文件 ID 和版本缓存到 `%APPDATA%\\WPSPersonalCloud\\cache\\<fileId>\\v<version>\\<filename>`，并用 WPS 打开/激活。已存在的同版本缓存会复用；新版本使用新目录。
- 下载器生成的 `.jsdownload` 临时文件只作为复制源，不会直接传给 WPS 文档打开接口。下载缓存不会覆盖用户原始本地文件。
- 从云端缓存打开后保存，会继续同步到同一个云端文件 ID，并由期望版本校验避免静默覆盖云端更新。
- 当前不支持将云端内容恢复/覆盖到原始本地路径，也没有缓存自动清理功能。
- 初版令牌存储在加载项的本地 Web 存储中。多人/公网使用前应改为系统凭据存储辅助进程，并在服务器启用 HTTPS。
