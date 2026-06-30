#!/usr/bin/env bash
#
# 统计 Hive/Inceptor 表数据量。
#
# 用法:
#   ./count_table_rows.sh /path/to/input.conf /path/to/count_result.txt
#
# 输入文件每个非空、非注释行格式，支持空格、制表符或 | 分隔:
#   库名 表名 开始日期 结束日期
# 或:
#   视图名 库名 表名 开始日期 结束日期
#
# 输出格式:
#   有视图名: 视图名|表名|日期|数据量
#   无视图名: 表名|日期|数据量
#
# 分区表按 PARTITION_COLUMN 指定的日期分区字段统计，默认 tx_dt。
# 非分区表忽略输入日期范围，只输出当前整表数据量，日期列输出 ALL。

set -Eeuo pipefail
IFS=$'\n\t'
umask 027

INCP_IP="${INCP_IP:-}"
INCP_USER="${INCP_USER:-}"
INCP_PASSWD="${INCP_PASSWD:-}"
KRB_KEYTAB="${KRB_KEYTAB:-/home/tyf/etc/ekg.keytab}"
KRB_PRINCIPAL="${KRB_PRINCIPAL:-ekg@TDH}"
PARTITION_COLUMN="${PARTITION_COLUMN:-tx_dt}"

TEMP_OUTPUT=""

log() {
    printf '[%s] %s\n' "$(date '+%F %T')" "$*" >&2
}

die() {
    log "错误：$*"
    exit 1
}

cleanup() {
    [[ -z "$TEMP_OUTPUT" ]] || rm -f -- "$TEMP_OUTPUT"
}

on_error() {
    local exit_code=$?
    log "执行失败：第 ${BASH_LINENO[0]} 行，退出码 ${exit_code}"
    exit "$exit_code"
}
trap cleanup EXIT
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
    [[ "$value" =~ ^[a-z_][a-z0-9_]*$ ]] ||
        die "${label}不合法：${value}；只允许字母、数字和下划线，且不能以数字开头"
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

validate_date() {
    local value=$1
    local parsed

    [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
        die "日期格式不合法：${value}；必须为 YYYY-MM-DD"
    parsed=$(date -d "$value" '+%F' 2>/dev/null) ||
        die "日期不存在：${value}"
    [[ "$parsed" == "$value" ]] || die "日期不存在：${value}"
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

clean_scalar() {
    awk '{
        gsub(/\r/, "");
        gsub(/^"|"$/, "");
        gsub(/""/, "\"");
        gsub(/^[[:space:]]+|[[:space:]]+$/, "");
        if (length($0) > 0) {
            print;
            exit;
        }
    }'
}

query_scalar() {
    local output
    output=$(beeline_run "$1")
    printf '%s\n' "$output" | clean_scalar
}

emit_count_result() {
    local view_name=$1
    local table_name=$2
    local stat_date=$3
    local row_count=$4

    if [[ -n "$view_name" ]]; then
        printf '%s|%s|%s|%s\n' "$view_name" "$table_name" "$stat_date" "$row_count" >> "$TEMP_OUTPUT"
    else
        printf '%s|%s|%s\n' "$table_name" "$stat_date" "$row_count" >> "$TEMP_OUTPUT"
    fi
}

load_partition_counts() {
    local sql_output=$1
    local line stat_date row_count

    PARTITION_COUNTS=()
    while IFS= read -r line || [[ -n "$line" ]]; do
        line=$(printf '%s' "$line" | clean_scalar)
        [[ -n "$line" ]] || continue
        stat_date=${line%%|*}
        row_count=${line#*|}
        [[ "$stat_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
        [[ "$row_count" =~ ^[0-9]+$ ]] || die "查询返回的数据量不是数字：${line}"
        PARTITION_COUNTS["$stat_date"]=$row_count
    done <<< "$sql_output"
}

process_partitioned_table() {
    local view_name=$1
    local database_name=$2
    local table_name=$3
    local start_date=$4
    local end_date=$5
    local sql_output current_date row_count

    log "统计分区表：${database_name}.${table_name}，${PARTITION_COLUMN} ${start_date} 至 ${end_date}"

    sql_output=$(beeline_run \
        "SELECT concat(cast(${PARTITION_COLUMN} as string),'|',cast(count(1) as string)) FROM ${database_name}.${table_name} WHERE ${PARTITION_COLUMN}>='${start_date}' AND ${PARTITION_COLUMN}<='${end_date}' GROUP BY ${PARTITION_COLUMN}")

    declare -gA PARTITION_COUNTS
    load_partition_counts "$sql_output"

    current_date=$start_date
    while :; do
        row_count=${PARTITION_COUNTS[$current_date]:-0}
        emit_count_result "$view_name" "$table_name" "$current_date" "$row_count"

        [[ "$current_date" == "$end_date" ]] && break
        current_date=$(date -d "${current_date} + 1 day" '+%F')
    done
}

process_non_partitioned_table() {
    local view_name=$1
    local database_name=$2
    local table_name=$3
    local row_count

    log "统计非分区表：${database_name}.${table_name}"
    row_count=$(query_scalar "SELECT count(1) FROM ${database_name}.${table_name}")
    [[ "$row_count" =~ ^[0-9]+$ ]] ||
        die "非分区表 ${database_name}.${table_name} 查询返回的数据量不是数字：${row_count:-空}"

    emit_count_result "$view_name" "$table_name" "ALL" "$row_count"
}

process_task() {
    local view_name=$1
    local database_name=$2
    local table_name=$3
    local start_date=$4
    local end_date=$5
    local partition_count

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

    if (( partition_count > 0 )); then
        process_partitioned_table "$view_name" "$database_name" "$table_name" "$start_date" "$end_date"
    else
        process_non_partitioned_table "$view_name" "$database_name" "$table_name"
    fi
}

process_line_safely() {
    local line_no=$1
    local raw_line=$2
    local line_output
    local field1 field2 field3 field4 field5 extra
    local view_name database_name table_name start_date end_date

    line_output=$(mktemp "${TEMP_OUTPUT}.line.${line_no}.XXXXXX")

    if (
        trap - ERR
        set -Eeuo pipefail

        TEMP_OUTPUT=$line_output

        parse_config_line "$raw_line"
        [[ -z "${extra:-}" ]] || die "配置文件第 ${line_no} 行字段过多"

        if [[ -n "$field5" ]]; then
            view_name=${field1,,}
            database_name=${field2,,}
            table_name=${field3,,}
            start_date=$field4
            end_date=$field5
        else
            view_name=""
            database_name=${field1,,}
            table_name=${field2,,}
            start_date=$field3
            end_date=$field4
        fi

        [[ -n "$database_name" && -n "$table_name" &&
           -n "$start_date" && -n "$end_date" ]] ||
            die "配置文件第 ${line_no} 行必须包含 4 个或 5 个非空字段"
        if [[ -n "$view_name" ]]; then
            [[ "$view_name" =~ ^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$ ]] ||
                die "配置文件第 ${line_no} 行视图名不合法：${view_name}"
        fi

        start_date=$(normalize_date "$start_date")
        end_date=$(normalize_date "$end_date")

        log "读取配置文件第 ${line_no} 行：${database_name}.${table_name}"
        process_task "$view_name" "$database_name" "$table_name" "$start_date" "$end_date"
    ); then
        cat "$line_output" >> "$TEMP_OUTPUT"
        rm -f -- "$line_output"
        log "配置文件第 ${line_no} 行处理成功"
        return 0
    else
        local exit_code=$?
        rm -f -- "$line_output"
        log "错误：配置文件第 ${line_no} 行处理失败，已跳过：${raw_line}，退出码 ${exit_code}"
        return 1
    fi
}

main() {
    local input_file=${1:-}
    local output_file=${2:-}
    local output_dir line line_no=0 task_count=0 success_count=0 fail_count=0

    [[ $# -eq 2 ]] || die "用法：$0 /path/to/input.conf /path/to/count_result.txt"
    [[ -f "$input_file" && -r "$input_file" ]] || die "输入配置文件不存在或不可读：${input_file}"
    [[ -n "$output_file" ]] || die "输出文件路径不能为空"
    [[ -n "$INCP_IP" ]] || die "请通过环境变量 INCP_IP 设置 HiveServer2 地址"
    [[ -n "$INCP_USER" ]] || die "请通过环境变量 INCP_USER 设置 Hive 用户"

    PARTITION_COLUMN=${PARTITION_COLUMN,,}
    validate_identifier "$PARTITION_COLUMN" "分区字段名"

    for command_name in date dirname mkdir mktemp mv rm sort kinit beeline awk; do
        require_command "$command_name"
    done

    [[ -r "$KRB_KEYTAB" ]] || die "Kerberos keytab 不存在或不可读：${KRB_KEYTAB}"

    output_dir=$(dirname -- "$output_file")
    mkdir -p -- "$output_dir"
    TEMP_OUTPUT=$(mktemp "${output_file}.tmp.XXXXXX")

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
    done < "$input_file"

    (( task_count > 0 )) || die "输入配置文件中没有可执行任务"

    LC_ALL=C sort "$TEMP_OUTPUT" -o "$TEMP_OUTPUT"
    mv -f -- "$TEMP_OUTPUT" "$output_file"
    TEMP_OUTPUT=""

    log "统计完成：共处理 ${task_count} 项，成功 ${success_count} 项，失败 ${fail_count} 项，结果文件：${output_file}"
    (( fail_count == 0 )) || exit 2
}

main "$@"
