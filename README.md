# data-recovery

Hive/HDFS 数据恢复辅助脚本集合。

## 目录

- `scripts/copy_hive_partitions.sh`: 从本地日期分区目录复制数据到中转目录，再批量替换 Hive 表 HDFS 分区目录并修复分区。
- `scripts/file_to_prodb_optimized.sh`: 根据配置文件将本地文件导入目标 Hive 表 HDFS 目录，兼容分区表和非分区表。
- `scripts/view_to_source_tables.sh`: 根据视图名解析源表，并生成可供恢复脚本使用的配置文件。
- `scripts/count_table_rows.sh`: 统计指定表在日期范围内的数据量，分区表按日期输出，非分区表输出整表数据量。
- `scripts/prodb_dm_to_target_partitions.sh`: 将 `prodb_dm` 库中指定表日期范围内的数据拷贝到目标库同名表分区目录。
- `examples/`: 配置文件示例。

## 运行前置条件

脚本依赖 Bash 4+、GNU `date -d`、`beeline`、`hdfs`、`kinit` 等命令。执行前请根据环境设置：

```bash
export INCP_IP="HiveServer2 地址"
export INCP_USER="用户名"
export INCP_PASSWD="密码"
export KRB_KEYTAB="/home/tyf/etc/ekg.keytab"
export KRB_PRINCIPAL="ekg@TDH"
```

具体配置文件格式请参考 `examples/` 下的示例文件。
