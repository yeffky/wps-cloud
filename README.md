# WPS Personal Cloud

面向个人 WPS 桌面客户端的自托管文档同步插件原型。加载项监听 WPS 保存后事件，将本地文档上传至自有服务；服务按版本保存文件，并在并发版本不匹配时拒绝覆盖。

## 当前范围

- WPS 加载项原型：本地设置服务地址、访问令牌和云端目录；本地原件保存后上传，可选定时比较已关联本地文件与云端内容并同步差异；云端文件按 ID 和版本缓存到本机后用 WPS 打开。
- Node.js 文件服务：文件列表、下载票据、上传票据、版本校验和磁盘存储。
- 中文实现方案：[docs/自托管云同步技术方案.md](docs/自托管云同步技术方案.md)

目前提供桌面 WPS Windows 文字、表格和演示组件的独立加载项注册入口，共用同一加载项界面与同步逻辑。各组件中的保存和内容变更事件仍需在目标 WPS 版本中分别验证。

## 启动服务

需要 Node.js 20 或更新版本。

```powershell
Copy-Item .env.example .env
# 编辑 .env，设置两个不同的长随机密钥
npm run server
```

服务默认只绑定 `127.0.0.1:8787`。远程访问请通过 HTTPS 反向代理，并配置强随机密钥；不要直接将无 TLS 的服务暴露到公网。

## WPS 加载项

加载项源码在 `client/addin/`。Windows 本机第三方安装/卸载和调试说明见[加载项 README](client/addin/README.md)：生产安装会将 Writer、ET、WPP 的构建文件复制到 WPS 本地加载项目录，并由脚本维护 `publish.xml` 注册；不调用官方发布服务。若要开发调试，可运行 WPSJS `debug` 命令并保持开发服务窗口运行。当前仓库远程地址为 `https://github.com/yeffky/wps-cloud`。

## API 简表

- `GET /api/health`：健康检查。
- `GET /api/files?parentId=root`：列出目录文件，需要 Bearer Token。
- `POST /api/sync-ticket`：为一次文档保存签发短时上传票据，需要 Bearer Token。
- `GET /api/files/:id/download-ticket`：签发短时下载地址，需要 Bearer Token。
- `POST /api/upload?ticket=...`：接收 WPS `OAAssist.UploadFile` 的 multipart 文件。
- `GET /api/download?ticket=...`：下载短时票据指定的文件版本。

服务端实现刻意保持 Node.js 内置模块零依赖，便于个人部署和审查。

云端下载票据同时返回文件 ID、名称、版本号和大小。加载项将云端版本缓存在 `%APPDATA%\\WPSPersonalCloud\\cache\\<fileId>\\v<version>`，不会覆盖本地原件；详细映射、缓存和冲突规则见[技术方案](docs/自托管云同步技术方案.md)。
