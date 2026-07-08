#!/usr/bin/env bash
#
# 将本地文件批量导入 Hive 表对应的 HDFS 路径。
#
# 用法:
#   ./file_to_prodb_optimized.sh /分区表源根目录 [配置文件] [非分区表源根目录]
#
# 配置文件默认位置:
#   脚本目录/../etc/file_to_prodb.txt
#
# 配置文件每个非空、非注释行格式，支持空格、制表符或 | 分隔:
#   库名 表名 开始日期 结束日期
# 或:
#   视图名 库名 表名 开始日期 结束日期
#
# 分区表本地目录格式:
#   源根目录/YYYY-MM-DD/表名/tx_dt=YYYY-MM-DD/
#
# 非分区表本地目录格式:
#   非分区表源根目录/表名/

set -Eeuo pipefail
IFS=$'\n\t'
umask 027

SCRIPT_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
BASE_DIR=$(cd -P -- "${SCRIPT_DIR}/.." && pwd)

SOURCE_BASE="${1:-}"
CONFIG_FILE="${2:-${BASE_DIR}/etc/file_to_prodb.txt}"
NON_PARTITION_SOURCE_BASE="${3:-${NON_PARTITION_SOURCE_BASE:-$SOURCE_BASE}}"
LOG_BASE_DIR="${LOG_BASE_DIR:-${BASE_DIR}/logs}"
RUN_DATE=$(date '+%Y%m%d')
LOG_DIR="${LOG_BASE_DIR}/${RUN_DATE}"
IMPORT_LOG="${LOG_DIR}/file_to_prodb.log"

# 建议通过环境变量注入连接信息，不要把真实密码写入脚本。
INCP_IP="${INCP_IP:-}"
INCP_USER="${INCP_USER:-}"
INCP_PASSWD="${INCP_PASSWD:-}"
KRB_KEYTAB="${KRB_KEYTAB:-/home/tyf/etc/ekg.keytab}"
KRB_PRINCIPAL="${KRB_PRINCIPAL:-ekg@TDH}"

log() {
    local message=$*
    local log_line
    log_line="[$(date '+%F %T')] ${message}"
    if [[ -d "$LOG_DIR" ]]; then
        printf '%s\n' "$log_line" | tee -a "$IMPORT_LOG"
    else
        printf '%s\n' "$log_line"
    fi
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

validate_identifier() {
    local value=$1
    local label=$2
    [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
        die "${label}不合法：${value}"
}

validate_date() {
    local value=$1
    local parsed
    [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
        die "日期格式不合法：${value}；必须为 YYYY-MM-DD"
    parsed=$(date -d "$value" '+%F' 2>/dev/null) || die "日期不存在：${value}"
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

    # 支持空格、制表符和 | 分隔；允许分隔符两侧有空白。
    line=${line//|/ }
    IFS=$' \t' read -r field1 field2 field3 field4 field5 extra <<< "$line"

    field1=$(trim "${field1:-}")
    field2=$(trim "${field2:-}")
    field3=$(trim "${field3:-}")
    field4=$(trim "${field4:-}")
    field5=$(trim "${field5:-}")
    extra=$(trim "${extra:-}")
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

directory_has_files() {
    local directory=$1
    [[ -n "$(find "$directory" -mindepth 1 -maxdepth 1 -type f -print -quit)" ]]
}

process_partitioned_table() {
    local database_name=$1
    local table_name=$2
    local start_date=$3
    local end_date=$4
    local table_path=$5
    local current_date source_partition
    local -a source_partitions=()
    local -a hdfs_partitions=()

    current_date=$start_date
    while :; do
        source_partition="${SOURCE_BASE}/${current_date}/${table_name}/tx_dt=${current_date}"

        # 缺失或空分区不会触发生产数据删除；其余有效分区继续处理。
        if [[ ! -d "$source_partition" ]]; then
            log "警告：源分区目录不存在，跳过：${source_partition}"
        elif ! directory_has_files "$source_partition"; then
            log "警告：源分区目录没有普通文件，跳过：${source_partition}"
        else
            source_partitions+=("$source_partition")
            hdfs_partitions+=("${table_path%/}/tx_dt=${current_date}")
        fi

        [[ "$current_date" == "$end_date" ]] && break
        current_date=$(date -d "${current_date} + 1 day" '+%F')
    done

    if (( ${#source_partitions[@]} == 0 )); then
        log "警告：${database_name}.${table_name} 没有可上传的有效分区，跳过"
        return
    fi

    log "删除 ${#hdfs_partitions[@]} 个旧 HDFS 分区目录"
    hdfs dfs -rm -r -f "${hdfs_partitions[@]}"

    # 多源 put 的目标根目录必须存在；不要提前创建分区子目录。
    hdfs dfs -mkdir -p "$table_path"
    log "批量上传 ${#source_partitions[@]} 个分区目录"
    hdfs dfs -put "${source_partitions[@]}" "${table_path%/}/"

    # 已有分区元数据保持不变，新分区由 MSCK 注册。
    beeline_run "USE ${database_name};MSCK REPAIR TABLE ${table_name}"
    log "${database_name}.${table_name} 分区数据上传及修复完成"
}

process_non_partitioned_table() {
    local database_name=$1
    local table_name=$2
    local table_path=$3
    local source_table="${NON_PARTITION_SOURCE_BASE}/${table_name}"
    local -a source_files=()
    local file

    if [[ ! -d "$source_table" ]]; then
        log "警告：非分区表源目录不存在，跳过：${source_table}"
        return
    fi

    while IFS= read -r -d '' file; do
        source_files+=("$file")
    done < <(find "$source_table" -mindepth 1 -maxdepth 1 -type f -print0)

    if (( ${#source_files[@]} == 0 )); then
        log "警告：非分区表源目录没有普通文件，跳过：${source_table}"
        return
    fi

    # 保留表根目录本身，避免改变其属主、权限及 ACL；永久删除目录下旧数据。
    log "删除非分区表旧 HDFS 数据：${table_path%/}/*"
    hdfs dfs -rm -r -f "${table_path%/}/*"
    hdfs dfs -mkdir -p "$table_path"

    log "上传非分区表文件，共 ${#source_files[@]} 个"
    hdfs dfs -put "${source_files[@]}" "${table_path%/}/"
    log "${database_name}.${table_name} 数据上传完成"
}

process_task() {
    local database_name=$1
    local table_name=$2
    local start_date=$3
    local end_date=$4
    local partition_count table_path

    validate_identifier "$database_name" "库名"
    validate_identifier "$table_name" "表名"
    validate_date "$start_date"
    validate_date "$end_date"
    [[ "$start_date" < "$end_date" || "$start_date" == "$end_date" ]] ||
        die "开始日期 ${start_date} 晚于结束日期 ${end_date}"

    partition_count=$(query_scalar \
        "SELECT count(1) FROM system.partition_keys_all_v WHERE database_name='${database_name}' AND table_name='${table_name}'")
    [[ "$partition_count" =~ ^[0-9]+$ ]] ||
        die "无法判断 ${database_name}.${table_name} 是否为分区表，查询结果：${partition_count:-空}"

    table_path=$(query_scalar \
        "SELECT table_location FROM system.tables_v WHERE database_name='${database_name}' AND table_name='${table_name}'")
    [[ -n "$table_path" ]] || die "表不存在或未查询到表路径：${database_name}.${table_name}"
    validate_hdfs_table_path "$table_path"

    log "开始处理：${database_name}.${table_name}，HDFS 路径：${table_path}"
    if (( partition_count > 0 )); then
        process_partitioned_table "$database_name" "$table_name" \
            "$start_date" "$end_date" "$table_path"
    else
        process_non_partitioned_table "$database_name" "$table_name" "$table_path"
    fi
}

run_task_safely() {
    local line_no=$1
    local database_name=$2
    local table_name=$3
    local start_date=$4
    local end_date=$5

    if (
        trap - ERR
        set -Eeuo pipefail
        process_task "$database_name" "$table_name" "$start_date" "$end_date"
    ); then
        log "配置文件第 ${line_no} 行处理成功：${database_name}.${table_name}"
        return 0
    else
        local exit_code=$?
        log "错误：配置文件第 ${line_no} 行处理失败，已跳过：${database_name}.${table_name}，退出码 ${exit_code}"
        return 1
    fi
}

main() {
    local line line_no=0 task_count=0 success_count=0 fail_count=0
    local field1 field2 field3 field4 field5 extra
    local database_name table_name start_date end_date

    [[ $# -ge 1 && $# -le 3 ]] ||
        die "用法：$0 /分区表源根目录 [配置文件] [非分区表源根目录]"
    [[ -d "$SOURCE_BASE" ]] || die "本地源根目录不存在：${SOURCE_BASE}"
    [[ -d "$NON_PARTITION_SOURCE_BASE" ]] || die "非分区表源根目录不存在：${NON_PARTITION_SOURCE_BASE}"
    [[ -f "$CONFIG_FILE" && -r "$CONFIG_FILE" ]] ||
        die "配置文件不存在或不可读：${CONFIG_FILE}"
    [[ -n "$INCP_IP" ]] || die "请通过环境变量 INCP_IP 设置 HiveServer2 地址"
    [[ -n "$INCP_USER" ]] || die "请通过环境变量 INCP_USER 设置 Hive 用户"

    mkdir -p "$LOG_DIR"
    SOURCE_BASE=$(cd -P -- "$SOURCE_BASE" && pwd)
    NON_PARTITION_SOURCE_BASE=$(cd -P -- "$NON_PARTITION_SOURCE_BASE" && pwd)

    for command_name in date find kinit beeline hdfs awk tee; do
        require_command "$command_name"
    done

    [[ -r "$KRB_KEYTAB" ]] || die "Kerberos keytab 不存在或不可读：${KRB_KEYTAB}"
    log "执行 Kerberos 认证：${KRB_PRINCIPAL}"
    kinit -kt "$KRB_KEYTAB" "$KRB_PRINCIPAL"

    while IFS= read -r line || [[ -n "$line" ]]; do
        ((++line_no))
        line=${line%$'\r'}
        line=$(trim "$line")
        [[ -z "$line" || "$line" == \#* ]] && continue
        ((++task_count))

        if ! parse_config_line "$line"; then
            log "错误：配置文件第 ${line_no} 行解析失败，已跳过：${line}"
            ((++fail_count))
            continue
        fi

        if [[ -n "${extra:-}" ]]; then
            log "错误：配置文件第 ${line_no} 行字段过多，已跳过：${line}"
            ((++fail_count))
            continue
        fi

        if [[ -n "${field5:-}" ]]; then
            database_name=$field2
            table_name=$field3
            start_date=$field4
            end_date=$field5
        else
            database_name=$field1
            table_name=$field2
            start_date=$field3
            end_date=$field4
        fi

        if [[ -z "${database_name:-}" || -z "${table_name:-}" ||
              -z "${start_date:-}" || -z "${end_date:-}" ]]; then
            log "错误：配置文件第 ${line_no} 行必须包含 4 个或 5 个非空字段，已跳过：${line}"
            ((++fail_count))
            continue
        fi

        if ! start_date=$(normalize_date "$start_date"); then
            log "错误：配置文件第 ${line_no} 行开始日期不合法，已跳过：${line}"
            ((++fail_count))
            continue
        fi
        if ! end_date=$(normalize_date "$end_date"); then
            log "错误：配置文件第 ${line_no} 行结束日期不合法，已跳过：${line}"
            ((++fail_count))
            continue
        fi

        log "读取配置文件第 ${line_no} 行"
        if run_task_safely "$line_no" "$database_name" "$table_name" "$start_date" "$end_date"; then
            ((++success_count))
        else
            ((++fail_count))
        fi
    done < "$CONFIG_FILE"

    (( task_count > 0 )) || die "配置文件中没有可执行任务"
    log "全部任务执行完成，共处理 ${task_count} 项，成功 ${success_count} 项，失败 ${fail_count} 项"
    (( fail_count == 0 )) || exit 2
}

main "$@"
