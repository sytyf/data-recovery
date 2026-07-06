# 数据恢复控制台 CentOS 7 内网部署说明

## 1. 部署结论

CentOS 7 环境建议使用 Node.js 14 的最后稳定版本：

```text
Node.js 14.21.3
npm 6.14.18
```

本项目已经按 Node.js 14.x 重构：

- 后端只使用 Node 内置模块，生产运行不需要任何 npm 运行时依赖。
- 前端构建链降级到兼容 Node 14 的 Vite 4。
- `package-lock.json` 已降为 `lockfileVersion: 1`，兼容 Node 14 自带的 npm 6。
- 不需要安装 Nginx，Node 后端会直接托管前端 `dist/` 静态文件和 API。

推荐部署方式：在可联网机器提前执行 `npm ci && npm run build` 生成 `dist/`，内网服务器只安装 Node.js 14.21.3 并运行后端。

## 2. 需要交付的文件

推荐交付包目录，例如 `/opt/data-recovery-console`：

```text
config/env.example
config/recovery.local.example.json
dist/
package.json
package-lock.json
server/
scripts/
DEPLOYMENT.md
DEPENDENCIES.md
node-v14.21.3-linux-x64.tar.xz
```

如果需要在内网服务器上重新构建前端，再额外交付：

```text
client/
index.html
vite.config.js
node_modules/        # 仅内网不能访问 npm registry 且需要内网构建时才需要
```

不要交付或提交以下运行时文件：

```text
.env
.git/
uploads/
generated/
config/recovery.local.json
```

## 3. 依赖版本

Node 版本要求：

```text
最低版本：Node.js 14.18.0
推荐版本：Node.js 14.21.3
npm 推荐：6.14.18
```

前端构建依赖已经放在 `devDependencies`，生产运行不依赖这些包：

```text
vue: 3.5.39
vite: 4.5.14
@vitejs/plugin-vue: 4.6.2
```

如果只部署已经构建好的 `dist/`，内网服务器无需执行 `npm ci`，也无需携带 `node_modules/`。

## 4. 外网准备构建包

建议在与内网服务器相同 CPU 架构的 Linux 机器上准备。Node 版本尽量也使用 14.21.3：

```bash
cd data-recover
node --version
npm --version
npm ci
npm run build
```

检查构建产物：

```bash
test -d dist
test -f dist/index.html
```

然后将第 2 节推荐文件打包传入内网。

## 5. 内网安装 Node.js

以 x64 服务器为例，将 `node-v14.21.3-linux-x64.tar.xz` 放到交付目录后执行：

```bash
cd /opt
tar -xf /opt/data-recovery-console/node-v14.21.3-linux-x64.tar.xz
ln -sfn /opt/node-v14.21.3-linux-x64 /opt/node-v14.21.3
```

验证：

```bash
export PATH=/opt/node-v14.21.3/bin:$PATH
node --version
npm --version
```

预期：

```text
v14.21.3
6.14.18
```

## 6. 本地目录配置

前端不开放“本地源根目录”和“中转目录”配置，部署时由服务器本地文件配置：

```bash
cd /opt/data-recovery-console
cp config/recovery.local.example.json config/recovery.local.json
```

编辑 `config/recovery.local.json`：

```json
{
  "sourceRoot": "/data/recovery/source",
  "stageRoot": "/data/recovery/stage"
}
```

含义：

- `sourceRoot`：本地恢复源根目录，连续时间段恢复和单日期恢复使用。
- `stageRoot`：连续时间段恢复使用的本地中转目录。

也可以用环境变量覆盖：

```bash
export RECOVERY_SOURCE_ROOT=/data/recovery/source
export RECOVERY_STAGE_ROOT=/data/recovery/stage
```

## 7. 环境变量配置

复制模板：

```bash
cp config/env.example .env
```

按内网环境修改 `.env`：

```bash
HOST=0.0.0.0
PORT=3001
RECOVERY_EXECUTE=1
RECOVERY_SOURCE_ROOT=/data/recovery/source
RECOVERY_STAGE_ROOT=/data/recovery/stage

INCP_IP=<HiveServer2地址>
INCP_USER=<Hive用户>
INCP_PASSWD=<Hive密码，可为空>
KRB_KEYTAB=/home/tyf/etc/ekg.keytab
KRB_PRINCIPAL=ekg@TDH

PARTITION_COLUMN=tx_dt
SOURCE_DATABASE=prodb_dm
```

`RECOVERY_EXECUTE=1` 才会真实执行恢复脚本。未设置时是 dry-run，适合页面联调。

## 8. 启动服务

进入部署目录：

```bash
cd /opt/data-recovery-console
```

启动服务。后端会自动读取部署目录下的 `.env`；也可以先手工加载环境变量，让外部环境覆盖 `.env`：

```bash
export PATH=/opt/node-v14.21.3/bin:$PATH
node server/server.js
```

访问：

```text
http://<内网服务器IP>:3001/
```

健康检查：

```bash
curl http://127.0.0.1:3001/api/health
```

正常返回：

```json
{"ok":true}
```

## 9. systemd 托管示例

创建 `/etc/systemd/system/data-recovery-console.service`：

```ini
[Unit]
Description=Data Recovery Console
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/data-recovery-console
EnvironmentFile=/opt/data-recovery-console/.env
Environment=PATH=/opt/node-v14.21.3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
ExecStart=/opt/node-v14.21.3/bin/node server/server.js
Restart=always
RestartSec=5
User=appuser
Group=appuser

[Install]
WantedBy=multi-user.target
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable data-recovery-console
sudo systemctl start data-recovery-console
sudo systemctl status data-recovery-console
```

查看日志：

```bash
journalctl -u data-recovery-console -f
```

## 10. 系统命令依赖

服务器上需要能执行：

```text
bash
date
awk
perl
sort
mktemp
realpath
find
cp
rm
mkdir
unzip
curl       # 仅健康检查需要
```

建议系统包：

```text
bash >= 4
coreutils >= 8
findutils >= 4
gawk >= 4
perl >= 5
unzip >= 6
curl >= 7
```

脚本使用了 Bash 数组、关联数组、`date -d`、`realpath` 等 GNU/Linux 特性，CentOS 7 原生环境满足要求。

## 11. 大数据客户端依赖

内网服务器必须已经安装并配置好对应集群客户端：

```text
beeline            # HiveServer2/Inceptor 查询
hdfs 或 hadoop     # HDFS 文件操作
kinit              # Kerberos 认证
java               # beeline/hadoop 客户端通常依赖
```

版本建议：

```text
Java: 8 或 11，以 TDH/Hive/Hadoop 客户端要求为准
Hive/Beeline: 与目标 TDH/Hive 集群客户端版本保持一致
Hadoop/HDFS: 与目标 HDFS 集群客户端版本保持一致
Kerberos client: 与内网认证环境匹配
```

脚本会调用：

```text
scripts/view_to_source_tables.sh
scripts/copy_hive_partitions.sh
scripts/file_to_prodb_optimized.sh
scripts/prodb_dm_to_target_partitions.sh
scripts/count_table_rows.sh
```

## 12. 部署前检查

```bash
cd /opt/data-recovery-console
export PATH=/opt/node-v14.21.3/bin:$PATH
node --version
npm --version
java -version
command -v beeline
command -v hdfs || command -v hadoop
command -v kinit
test -r "$KRB_KEYTAB"
bash -n scripts/*.sh
test -d dist
test -f dist/index.html
```

如果生产包按推荐方式交付，`node_modules/` 不需要存在。

## 13. 目录和权限建议

运行用户需要：

- 读取 `config/recovery.local.json`、脚本和 keytab。
- 写入 `uploads/` 和 `generated/`。
- 读取 `sourceRoot` 下的恢复源文件。
- 写入 `stageRoot` 中转目录。
- 执行 `beeline`、`hdfs`、`kinit` 并访问 Hive/HDFS。

建议：

```bash
mkdir -p uploads generated
chmod 750 uploads generated
chmod +x scripts/*.sh
```

## 14. Nginx 可选反代

Nginx 不是必需依赖。没有 Nginx 时，直接访问：

```text
http://<内网服务器IP>:3001/
```

如果希望使用 80 端口访问，可用 Nginx 反代到 Node：

```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

SSE 实时进度依赖长连接，如遇到进度不刷新，增加：

```nginx
proxy_buffering off;
proxy_read_timeout 3600s;
```
