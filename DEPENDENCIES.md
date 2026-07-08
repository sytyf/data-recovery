# 依赖和版本清单

## 应用运行依赖

| 依赖 | 推荐版本 | 是否必需 | 说明 |
| --- | --- | --- | --- |
| Node.js | 14.21.3 | 是 | CentOS 7 兼容的 Node 14 最后稳定版本；最低要求 14.18.0 |
| npm | 6.14.18 | 构建时需要 | 随 Node.js 14.21.3 提供；生产只运行已构建 `dist/` 时不需要执行 npm |
| Nginx | 不需要 | 否 | Node 后端可直接提供前端页面和 API |

## npm 依赖

生产运行时 npm 依赖为空，后端只使用 Node 内置模块。

前端构建依赖以 `package-lock.json` 为准：

| 包 | 锁定版本 | 类型 |
| --- | --- | --- |
| vue | 3.5.39 | devDependency |
| vite | 4.5.14 | devDependency |
| @vitejs/plugin-vue | 4.6.2 | devDependency |

`package-lock.json` 使用 `lockfileVersion: 1`，兼容 Node 14 自带的 npm 6。

内网不能访问 npm registry 时，推荐在可联网机器执行 `npm ci && npm run build`，只将 `dist/` 和后端文件拷贝到内网。生产运行不需要 `node_modules/`。

## Linux 命令依赖

| 命令 | 建议版本 |
| --- | --- |
| bash | 4+ |
| coreutils/date/sort/mktemp/realpath/cp/rm/mkdir | 8+ |
| findutils/find | 4+ |
| awk/gawk | 4+ |
| perl | 5+ |
| unzip | 6+ |
| curl | 7+，仅健康检查需要 |

## 大数据客户端依赖

| 依赖 | 版本要求 |
| --- | --- |
| Java | 8 或 11，以 TDH/Hive/Hadoop 客户端要求为准 |
| beeline | 与目标 TDH/Hive 集群客户端版本一致 |
| hdfs 或 hadoop | 与目标 HDFS 集群客户端版本一致 |
| kinit | 与内网 Kerberos 环境一致 |
| keytab | 运行用户可读，例如 `/home/tyf/etc/ekg.keytab` |

## 必需环境变量

```bash
HOST=0.0.0.0
PORT=3001
RECOVERY_EXECUTE=1
RECOVERY_MASKED_SOURCE_ROOT=/data/recovery/source/masked
RECOVERY_UNMASKED_SOURCE_ROOT=/data/recovery/source/unmasked
RECOVERY_NON_PARTITION_SOURCE_ROOT=/data/recovery/source/non-partition
RECOVERY_STAGE_ROOT=/data/recovery/stage
DATA_PACKAGE_ROOT=/data/recovery/package
INCP_IP=<HiveServer2地址>
INCP_USER=<Hive用户>
INCP_PASSWD=<Hive密码，可为空>
KRB_KEYTAB=/home/tyf/etc/ekg.keytab
KRB_PRINCIPAL=ekg@TDH
PARTITION_COLUMN=tx_dt
SOURCE_DATABASE=prodb_dm
TABLE_LOCATION_COLUMN=table_location
```

## 本地配置文件

`config/recovery.local.json`：

```json
{
  "maskedSourceRoot": "/data/recovery/source/masked",
  "unmaskedSourceRoot": "/data/recovery/source/unmasked",
  "nonPartitionSourceRoot": "/data/recovery/source/non-partition",
  "stageRoot": "/data/recovery/stage",
  "packageRoot": "/data/recovery/package"
}
```
