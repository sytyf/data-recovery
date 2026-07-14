#!/usr/bin/env bash
#
# 从 prodb_dm 库同名表复制指定日期范围内的 HDFS 分区数据到目标库同名表。
#
# 用法:
#   ./prodb_dm_to_target_partitions.sh /path/to/tasks.conf
#
# 配置文件每个非空、非注释行格式，支持空格、制表符或 | 分隔:
#   库名 表名 开始日期 结束日期
# 或:
#   视图名 库名 表名 开始日期 结束日期
#
# 日期支持 YYYYMMDD、YYYY-M-D、YYYY-MM-DD、YYYY/M/D、YYYY/MM/DD，
# 脚本内部统一转换为 YYYY-MM-DD。
#
# 默认源库为 prodb_dm，默认分区字段为 tx_dt，可通过环境变量覆盖:
#   SOURCE_DATABASE=prodb_dm
#   PARTITION_COLUMN=tx_dt

set -Eeuo pipefail
IFS=$'\n\t'
umask 027

INCP_IP="${INCP_IP:-}"
INCP_USER="${INCP_USER:-}"
INCP_PASSWD="${INCP_PASSWD:-}"
KRB_KEYTAB="${KRB_KEYTAB:-/home/tyf/etc/ekg.keytab}"
KRB_PRINCIPAL="${KRB_PRINCIPAL:-ekg@TDH}"
SOURCE_DATABASE="${SOURCE_DATABASE:-prodb_dm}"
PARTITION_COLUMN="${PARTITION_COLUMN:-tx_dt}"

declare -a HDFS_CMD=()

log() {
    printf '[%s] %s\n' "$(date '+%F %T')" "$*"
}

die() {
    log "错误：$*" >&2
    exit 1
}

on_error() {
    local exit_code=$?
    log "执行失败：第 ${BASH_LINENO[0]} 行，退出码 ${exit_code}" >&2
    exit "$exit_code"
}
trap on_error ERR

trim() {
    local value=$1
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf '%s' "$value"
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "未找到命令：$1"
}

setup_hdfs_command() {
    if command -v hdfs >/dev/null 2>&1; then
        HDFS_CMD=(hdfs dfs)
    elif command -v hadoop >/dev/null 2>&1; then
        HDFS_CMD=(hadoop fs)
    else
        die "未找到 hdfs 或 hadoop 命令，请先加载 Hadoop/TDH 客户端环境"
    fi
}

validate_identifier() {
    local value=$1
    local label=$2
    [[ "$value" =~ ^[a-z_][a-z0-9_]*$ ]] ||
        die "${label}不合法：${value}；只允许字母、数字和下划线，且不能以数字开头"
}

validate_date() {
    local value=$1
    local parsed

    [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
        die "日期格式不合法：${value}；必须为 YYYY-MM-DD"
    parsed=$(date -d "$value" '+%F' 2>/dev/null) ||
        die "日期不存在：${value}"
    [[ "$parsed" == "$value" ]] || die "日期不存在：${value}"
}

normalize_date() {
    local input=$1
    local normalized parsed
    local year month day

    if [[ "$input" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})$ ]]; then
        normalized="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
    elif [[ "$input" =~ ^([0-9]{4})[-/]([0-9]{1,2})[-/]([0-9]{1,2})$ ]]; then
        year=$((10#${BASH_REMATCH[1]}))
        month=$((10#${BASH_REMATCH[2]}))
        day=$((10#${BASH_REMATCH[3]}))
        normalized=$(printf '%04d-%02d-%02d' "$year" "$month" "$day")
    else
        die "日期格式不合法：${input}；支持 YYYYMMDD、YYYY-M-D、YYYY-MM-DD、YYYY/M/D、YYYY/MM/DD"
    fi

    parsed=$(date -d "$normalized" '+%F' 2>/dev/null) ||
        die "日期不存在：${input}"
    [[ "$parsed" == "$normalized" ]] || die "日期不存在：${input}"
    printf '%s' "$normalized"
}

parse_config_line() {
    local line=$1

    line=${line//|/ }
    IFS=$' \t' read -r field1 field2 field3 field4 field5 extra <<< "$line"

    field1=$(trim "${field1:-}")
    field2=$(trim "${field2:-}")
    field3=$(trim "${field3:-}")
    field4=$(trim "${field4:-}")
    field5=$(trim "${field5:-}")
    extra=$(trim "${extra:-}")
}

beeline_run() {
    local sql=$1
    local -a args=(
        -u "jdbc:hive2://${INCP_IP}:10000"
        -n "$INCP_USER"
        --silent=true
        --showHeader=false
        --outputformat=csv
    )
    [[ -z "$INCP_PASSWD" ]] || args+=(-p "$INCP_PASSWD")
    beeline "${args[@]}" -e "$sql"
}

query_scalar() {
    local output
    output=$(beeline_run "$1")
    awk '{
        gsub(/\r/, "");
        gsub(/^"|"$/, "");
        gsub(/^[[:space:]]+|[[:space:]]+$/, "");
        if (length($0) > 0) {
            print;
            exit;
        }
    }' <<< "$output"
}

validate_hdfs_table_path() {
    local path=$1
    local without_scheme

    [[ -n "$path" && "$path" != *$'\n'* && "$path" != *$'\r'* ]] ||
        die "Hive 表路径为空或包含非法换行符"

    without_scheme="${path#*://}"
    if [[ "$without_scheme" != "$path" ]]; then
        without_scheme="/${without_scheme#*/}"
    fi
    [[ "$without_scheme" != "/" && "$without_scheme" != "." && "$without_scheme" != "" ]] ||
        die "拒绝操作危险的 HDFS 表路径：${path}"
}

get_table_location() {
    local database_name=$1
    local table_name=$2
    local table_path

    table_path=$(query_scalar \
        "SELECT table_location FROM system.tables_v WHERE lower(database_name)=lower('${database_name}') AND lower(table_name)=lower('${table_name}')")
    [[ -n "$table_path" ]] || die "未查询到表路径：${database_name}.${table_name}"
    validate_hdfs_table_path "$table_path"
    printf '%s' "$table_path"
}

ensure_partitioned_table() {
    local database_name=$1
    local table_name=$2
    local partition_count
    local table_ddl

    partition_count=$(query_scalar \
        "SELECT count(1) FROM system.partition_keys_all_v WHERE lower(database_name)=lower('${database_name}') AND lower(table_name)=lower('${table_name}')")
    [[ "$partition_count" =~ ^[0-9]+$ ]] ||
        die "无法判断 ${database_name}.${table_name} 是否为分区表，查询结果：${partition_count:-空}"
    if (( partition_count > 0 )); then
        return 0
    fi

    # 部分内网元数据视图不会返回分区键，使用建表语句做第二次判断。
    if table_ddl=$(beeline_run "SHOW CREATE TABLE ${database_name}.${table_name}" 2>/dev/null) &&
        grep -Eiq 'PARTITIONED[[:space:]]+BY' <<< "$table_ddl"; then
        return 0
    fi

    die "${database_name}.${table_name} 不是分区表，无法按 ${PARTITION_COLUMN} 日期范围复制"
}

hdfs_test_dir() {
    local path=$1
    "${HDFS_CMD[@]}" -test -d "$path"
}

copy_partition_contents() {
    local source_partition=$1
    local target_partition=$2

    # Hadoop shell 会在 HDFS 侧展开 *，用于复制分区目录下的文件。
    "${HDFS_CMD[@]}" -cp "${source_partition%/}/*" "${target_partition%/}/"
}

process_task() {
    local target_database=$1
    local table_name=$2
    local start_date=$3
    local end_date=$4
    local source_table_path target_table_path current_date
    local source_partition target_partition
    local -a source_partitions=()
    local -a target_partitions=()

    validate_identifier "$SOURCE_DATABASE" "源库名"
    validate_identifier "$PARTITION_COLUMN" "分区字段名"
    validate_identifier "$target_database" "目标库名"
    validate_identifier "$table_name" "表名"
    validate_date "$start_date"
    validate_date "$end_date"
    [[ "$start_date" < "$end_date" || "$start_date" == "$end_date" ]] ||
        die "开始日期 ${start_date} 晚于结束日期 ${end_date}"
    [[ "$target_database" != "$SOURCE_DATABASE" ]] ||
        die "目标库与源库相同，拒绝覆盖源表：${SOURCE_DATABASE}.${table_name}"

    log "开始任务：${SOURCE_DATABASE}.${table_name} -> ${target_database}.${table_name}，日期 ${start_date} 至 ${end_date}"

    ensure_partitioned_table "$SOURCE_DATABASE" "$table_name"
    ensure_partitioned_table "$target_database" "$table_name"

    source_table_path=$(get_table_location "$SOURCE_DATABASE" "$table_name")
    target_table_path=$(get_table_location "$target_database" "$table_name")
    [[ "$source_table_path" != "$target_table_path" ]] ||
        die "源表和目标表 HDFS 路径相同，拒绝执行：${source_table_path}"

    current_date=$start_date
    while :; do
        source_partition="${source_table_path%/}/${PARTITION_COLUMN}=${current_date}"
        target_partition="${target_table_path%/}/${PARTITION_COLUMN}=${current_date}"

        if hdfs_test_dir "$source_partition"; then
            source_partitions+=("$source_partition")
            target_partitions+=("$target_partition")
        else
            log "警告：源分区目录不存在，跳过日期 ${current_date}：${source_partition}"
        fi

        [[ "$current_date" == "$end_date" ]] && break
        current_date=$(date -d "${current_date} + 1 day" '+%F')
    done

    if (( ${#source_partitions[@]} == 0 )); then
        log "警告：${SOURCE_DATABASE}.${table_name} 在指定日期范围内没有可复制的源分区，跳过"
        return
    fi

    log "删除 ${#target_partitions[@]} 个目标 HDFS 分区目录"
    "${HDFS_CMD[@]}" -rm -r -f "${target_partitions[@]}"

    log "重建 ${#target_partitions[@]} 个目标 HDFS 分区目录"
    "${HDFS_CMD[@]}" -mkdir -p "${target_partitions[@]}"

    local i
    for (( i = 0; i < ${#source_partitions[@]}; i++ )); do
        log "复制分区数据：${source_partitions[$i]} -> ${target_partitions[$i]}/"
        copy_partition_contents "${source_partitions[$i]}" "${target_partitions[$i]}"
    done

    beeline_run "USE ${target_database};MSCK REPAIR TABLE ${table_name}"
    log "${target_database}.${table_name} 分区修复完成"
}

process_line_safely() {
    local line_no=$1
    local raw_line=$2
    local field1 field2 field3 field4 field5 extra
    local target_database table_name start_date end_date

    if (
        trap - ERR
        set -Eeuo pipefail

        parse_config_line "$raw_line"
        [[ -z "${extra:-}" ]] || die "配置文件第 ${line_no} 行字段过多"

        if [[ -n "$field5" ]]; then
            target_database=$field2
            table_name=$field3
            start_date=$field4
            end_date=$field5
        else
            target_database=$field1
            table_name=$field2
            start_date=$field3
            end_date=$field4
        fi

        [[ -n "$target_database" && -n "$table_name" &&
           -n "$start_date" && -n "$end_date" ]] ||
            die "配置文件第 ${line_no} 行必须包含 4 个或 5 个非空字段"

        target_database=${target_database,,}
        table_name=${table_name,,}
        start_date=$(normalize_date "$start_date")
        end_date=$(normalize_date "$end_date")

        log "读取配置文件第 ${line_no} 行：${target_database}.${table_name}"
        process_task "$target_database" "$table_name" "$start_date" "$end_date"
    ); then
        log "配置文件第 ${line_no} 行处理成功"
        return 0
    else
        local exit_code=$?
        log "错误：配置文件第 ${line_no} 行处理失败，已跳过：${raw_line}，退出码 ${exit_code}"
        return 1
    fi
}

main() {
    local config_file=${1:-}
    local line line_no=0 task_count=0 success_count=0 fail_count=0

    [[ $# -eq 1 ]] || die "用法：$0 /path/to/tasks.conf"
    [[ -f "$config_file" && -r "$config_file" ]] ||
        die "配置文件不存在或不可读：${config_file}"
    [[ -n "$INCP_IP" ]] || die "请通过环境变量 INCP_IP 设置 HiveServer2 地址"
    [[ -n "$INCP_USER" ]] || die "请通过环境变量 INCP_USER 设置 Hive 用户"

    SOURCE_DATABASE=${SOURCE_DATABASE,,}
    PARTITION_COLUMN=${PARTITION_COLUMN,,}

    for command_name in date kinit beeline awk; do
        require_command "$command_name"
    done
    setup_hdfs_command

    [[ -r "$KRB_KEYTAB" ]] || die "Kerberos keytab 不存在或不可读：${KRB_KEYTAB}"
    log "执行 Kerberos 认证：${KRB_PRINCIPAL}"
    kinit -kt "$KRB_KEYTAB" "$KRB_PRINCIPAL"

    while IFS= read -r line || [[ -n "$line" ]]; do
        ((++line_no))
        line=${line%$'\r'}
        line=$(trim "$line")
        [[ -z "$line" || "$line" == \#* ]] && continue

        ((++task_count))
        if process_line_safely "$line_no" "$line"; then
            ((++success_count))
        else
            ((++fail_count))
        fi
    done < "$config_file"

    (( task_count > 0 )) || die "配置文件中没有可执行任务"
    log "全部任务执行完成，共处理 ${task_count} 项，成功 ${success_count} 项，失败 ${fail_count} 项"
    (( fail_count == 0 )) || exit 2
}

main "$@"
