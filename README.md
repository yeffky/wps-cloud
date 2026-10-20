# WPS Personal Cloud

面向个人 WPS 桌面客户端的自托管文档同步插件原型。加载项监听 WPS 保存后事件，将本地文档上传至自有服务；服务按版本保存文件，并在并发版本不匹配时拒绝覆盖。

## 当前范围

- WPS 加载项原型：本地设置服务地址、访问令牌和云端目录；本地原件保存后上传，可选定时比较已关联本地文件与云端内容并同步差异；云端文件按 ID 和版本缓存到本机后用 WPS 打开。
- Node.js 文件服务：文件列表、下载票据、上传票据、版本校验和磁盘存储。
- 中文实现方案：[docs/自托管云同步技术方案.md](docs/自托管云同步技术方案.md)

目前提供桌面 WPS Windows 文字、表格和演示组件的独立加载项注册入口，共用同一加载项界面与同步逻辑。各组件中的保存和内容变更事件仍需在目标 WPS 版本中分别验证。

## 在自己的云服务器部署

以下以 CentOS 7、Docker Compose 和公网 IP `203.0.113.10` 为例。CentOS 7 已停止维护；服务器需已安装 Docker 和 Compose，并有固定公网 IP。`203.0.113.10` 是文档示例地址，部署时替换成自己的 IP。

### 1. 配置云安全组

在阿里云 ECS 控制台的“网络与安全组”入方向规则中配置：SSH（TCP 22，建议限制来源 IP）、HTTP（TCP 80，用于证书验证）和 HTTPS（TCP 443）。不要开放 API 端口 `8787`。其他云厂商也在对应控制台的安全组/防火墙入方向配置这些规则。

### 2. 获取项目并配置密钥

以下命令假设以 root 登录；使用普通账户时，确保其能写入 `/opt/wps-cloud`，并对需要提权的命令使用 sudo：

```bash
git clone https://github.com/yeffky/wps-cloud.git /opt/wps-cloud
cd /opt/wps-cloud
openssl rand -hex 32
openssl rand -hex 32
cp .env.example .env
chmod 600 .env
vi .env
```

将两次生成的随机值分别填入 `.env` 的 `WPS_CLOUD_TOKEN` 和 `WPS_CLOUD_SIGNING_KEY`。不要公开或提交 `.env`。已有部署目录时不要重复 clone，先备份 `.env` 和 `data/`。

### 3. 启动服务

仓库根目录的 [`compose.yaml`](compose.yaml) 是 Compose 配置。创建数据目录并启动：

```bash
install -d -o 1000 -g 1000 -m 700 data
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8787/api/health
```

API 仅绑定服务器本机的 `127.0.0.1:8787`，由反向代理转发。

### 4. 配置 IP 地址 HTTPS

证书必须对服务器公网 IP 有效。Let's Encrypt 支持 IP 证书，但证书只有 **6 天有效期**，必须自动续期；Certbot 需为 5.4 或更新版本。CentOS 7 自带仓库可能没有足够新的 Certbot。使用现有反向代理或证书管理工具时，确认它支持 IP 证书、自动续期和续期后重载证书。[Let's Encrypt IP 证书说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/)

以宿主机 Nginx + Certbot webroot 为例，将 `203.0.113.10` 替换为自己的公网 IP。先开放安全组 TCP 80，并让 Nginx 为 ACME 验证路径提供服务：

```nginx
server {
    listen 80;
    server_name 203.0.113.10;
    location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 301 https://$host$request_uri; }
}
```

申请 IP 证书：

```bash
mkdir -p /var/www/letsencrypt/.well-known/acme-challenge
nginx -t && systemctl reload nginx
certbot certonly --preferred-profile shortlived --webroot --webroot-path /var/www/letsencrypt --ip-address 203.0.113.10
```

Nginx 的 HTTPS 站点配置示例：

```nginx
server {
    listen 443 ssl;
    server_name 203.0.113.10;
    ssl_certificate     /etc/letsencrypt/live/203.0.113.10/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/203.0.113.10/privkey.pem;
    client_max_body_size 200m;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

配置后执行 `nginx -t && systemctl reload nginx`。确保 Certbot 自动续期任务已启用，并设置续期后重载 Nginx：

```bash
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
certbot renew --dry-run
```

### 5. 在本机 WPS 中连接

本机浏览器或 WPS 使用 `https://203.0.113.10`（替换为真实公网 IP）；无需配置 DNS。先确认 `https://你的公网IP/api/health` 可访问且证书有效。在 WPS“云盘与设置”填写：

- 服务器地址：`https://你的公网IP`，不加 `/api`
- 访问令牌：`.env` 中的 `WPS_CLOUD_TOKEN`，不加 `Bearer ` 前缀
- 云端目录 ID：首次使用填 `root`

### 6. 备份和更新

定期备份 `/opt/wps-cloud/data/`、`.env` 和证书续期配置。更新代码时保留 `.env` 和 `data/`：

```bash
cd /opt/wps-cloud
git pull
docker compose up -d --force-recreate
```

本机快速试用可在仓库根目录复制 `.env.example` 为 `.env`、填写两项随机密钥，再运行 `npm run server`。服务默认监听 `127.0.0.1:8787`。
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
