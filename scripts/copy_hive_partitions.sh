#!/usr/bin/env bash
#
# 从配置文件读取多项任务，将指定日期范围内的本地分区文件复制到目标目录，
# 再替换 HDFS 分区目录中的数据并修复 Hive 分区元数据。
#
# 用法:
#   ./copy_hive_partitions.sh /源根目录 /目标根目录 /path/to/tasks.conf
#
# 配置文件每个非空、非注释行格式，支持空格、制表符或 | 分隔:
#   库名|表名|开始日期|结束日期
# 或直接使用 view_to_source_tables.sh 生成的五列文件:
#   视图名|库名|表名|开始日期|结束日期

set -Eeuo pipefail
IFS=$'\n\t'

# 可通过环境变量覆盖这些连接配置，避免把密码写入脚本或任务配置文件。
INCP_IP="${INCP_IP:-}"
INCP_USER="${INCP_USER:-}"
INCP_PASSWD="${INCP_PASSWD:-}"
KRB_KEYTAB="${KRB_KEYTAB:-/home/tyf/etc/ekg.keytab}"
KRB_PRINCIPAL="${KRB_PRINCIPAL:-ekg@TDH}"

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

validate_identifier() {
    local value=$1
    local label=$2
    [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
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

validate_local_path_text() {
    local value=$1
    local label=$2
    [[ -n "$value" ]] || die "${label}不能为空"
    [[ "$value" != *'|'* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] ||
        die "${label}包含不允许的字符：${value}"
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

query_scalar() {
    local sql=$1
    local output
    output=$(beeline_run "$sql")
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

copy_partition_files() {
    local src_path=$1
    local dest_path=$2
    local file
    local copied=0

    mkdir -p -- "$dest_path"
    while IFS= read -r -d '' file; do
        cp -n -- "$file" "$dest_path/"
        copied=1
    done < <(find "$src_path" -mindepth 1 -maxdepth 1 -type f -print0)

    if (( copied == 1 )); then
        log "已拷贝：${src_path} -> ${dest_path}"
    else
        log "提示：源分区目录没有普通文件，跳过复制：${src_path}"
    fi
}

cleanup_stage_table_dir() {
    local dest_base=$1
    local target_table=$2
    local table_stage_dir
    local expected_parent

    table_stage_dir="${dest_base}/${target_table}"
    expected_parent=$(realpath "$dest_base")

    [[ -n "$table_stage_dir" && "$table_stage_dir" != "/" ]] ||
        die "拒绝删除危险的中转目录：${table_stage_dir}"
    [[ -d "$table_stage_dir" ]] || {
        log "提示：中转目录不存在，无需删除：${table_stage_dir}"
        return
    }

    table_stage_dir=$(realpath "$table_stage_dir")
    [[ "$table_stage_dir" == "${expected_parent}/${target_table}" ]] ||
        die "中转目录校验失败，拒绝删除：${table_stage_dir}"

    log "删除本地中转目录：${table_stage_dir}"
    rm -rf -- "$table_stage_dir"
}

process_task() {
    local src_base=$1
    local dest_base=$2
    local database_name=$3
    local target_table=$4
    local start_date=$5
    local end_date=$6
    local current_date src_path dest_path tab_path result_cnt
    local -a prepared_dates=()
    local -a upload_paths=()
    local -a hdfs_partition_paths=()

    validate_local_path_text "$src_base" "源根目录"
    validate_local_path_text "$dest_base" "目标根目录"
    validate_identifier "$database_name" "库名"
    validate_identifier "$target_table" "表名"
    validate_date "$start_date"
    validate_date "$end_date"
    [[ "$start_date" < "$end_date" || "$start_date" == "$end_date" ]] ||
        die "开始日期 ${start_date} 晚于结束日期 ${end_date}"
    [[ -d "$src_base" ]] || die "源目录不存在：${src_base}"

    mkdir -p -- "$dest_base"
    src_base=$(realpath "$src_base")
    dest_base=$(realpath "$dest_base")
    [[ "$dest_base" != "/" ]] || die "目标根目录不能是 /"
    [[ "$src_base" != "$dest_base" ]] || die "源根目录和目标根目录不能相同"

    log "开始任务：${database_name}.${target_table}，日期 ${start_date} 至 ${end_date}"

    current_date=$start_date
    while :; do
        src_path="${src_base}/${current_date}/${target_table}/tx_dt=${current_date}"
        dest_path="${dest_base}/${target_table}/tx_dt=${current_date}"

        if [[ -d "$src_path" ]]; then
            copy_partition_files "$src_path" "$dest_path"
            prepared_dates+=("$current_date")
        else
            log "提示：源分区目录不存在，跳过：${src_path}"
        fi

        [[ "$current_date" == "$end_date" ]] && break
        current_date=$(date -d "${current_date} + 1 day" '+%F')
    done

    if (( ${#prepared_dates[@]} == 0 )); then
        log "提示：没有找到可处理的源分区，任务结束：${database_name}.${target_table}"
        return
    fi

    result_cnt=$(query_scalar \
        "SELECT count(1) FROM system.partition_keys_all_v WHERE database_name='${database_name}' AND table_name='${target_table}'")
    [[ "$result_cnt" =~ ^[0-9]+$ ]] ||
        die "无法确认表是否为分区表，查询结果为：${result_cnt:-空}"

    if (( result_cnt == 0 )); then
        log "提示：${database_name}.${target_table} 不是分区表，跳过 HDFS 上传和分区修复"
        return
    fi

    tab_path=$(query_scalar \
        "SELECT table_location FROM system.tables_v WHERE database_name='${database_name}' AND table_name='${target_table}'")
    [[ -n "$tab_path" ]] || die "未查询到表路径：${database_name}.${target_table}"
    [[ "$tab_path" != *$'\n'* && "$tab_path" != *$'\r'* ]] ||
        die "表路径包含非法换行符"

    for current_date in "${prepared_dates[@]}"; do
        upload_paths+=("${dest_base}/${target_table}/tx_dt=${current_date}")
        hdfs_partition_paths+=("${tab_path%/}/tx_dt=${current_date}")
    done

    # 不执行 DROP PARTITION，保留已存在分区的 Hive 元数据。
    # -f 允许目标目录不存在；删除的数据按集群配置进入 HDFS Trash。
    log "批量删除 ${#hdfs_partition_paths[@]} 个已有 HDFS 分区目录（如存在）"
    hdfs dfs -rm -r -f "${hdfs_partition_paths[@]}"

    # 多源 put 要求目标表根目录存在，但不能提前创建分区子目录；
    # put 会使用本地 tx_dt=日期 目录名在表根目录下创建分区目录。
    log "确保 HDFS 表根目录存在：${tab_path%/}"
    hdfs dfs -mkdir -p "${tab_path%/}"

    log "批量上传 ${#upload_paths[@]} 个分区目录 -> ${tab_path}/"
    hdfs dfs -put -f "${upload_paths[@]}" "${tab_path%/}/"

    # 已存在分区的元数据保持不变；此前不存在的分区由 MSCK 补充。
    beeline_run "USE ${database_name};MSCK REPAIR TABLE ${target_table}"
    log "${database_name}.${target_table} 分区修复完成"

    cleanup_stage_table_dir "$dest_base" "$target_table"
}

process_line_safely() {
    local line_no=$1
    local raw_line=$2
    local field1 field2 field3 field4 field5 extra
    local database_name target_table start_date end_date

    if (
        trap - ERR
        set -Eeuo pipefail

        parse_config_line "$raw_line"
        [[ -z "${extra:-}" ]] || die "配置文件第 ${line_no} 行字段过多"

        if [[ -n "$field5" ]]; then
            database_name=$field2
            target_table=$field3
            start_date=$field4
            end_date=$field5
        else
            database_name=$field1
            target_table=$field2
            start_date=$field3
            end_date=$field4
        fi

        [[ -n "$database_name" && -n "$target_table" &&
           -n "$start_date" && -n "$end_date" ]] ||
            die "配置文件第 ${line_no} 行必须包含 4 个或 5 个非空字段"

        # Hive 库名、表名统一转换为小写，避免配置中大小写不一致。
        database_name=${database_name,,}
        target_table=${target_table,,}
        start_date=$(normalize_date "$start_date")
        end_date=$(normalize_date "$end_date")

        log "读取配置文件第 ${line_no} 行：${database_name}.${target_table}"
        process_task "$src_base" "$dest_base" "$database_name" \
            "$target_table" "$start_date" "$end_date"
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
    local src_base=${1:-}
    local dest_base=${2:-}
    local config_file=${3:-}
    local line line_no=0 task_count=0 success_count=0 fail_count=0

    [[ $# -eq 3 ]] ||
        die "用法：$0 /源根目录 /目标根目录 /path/to/tasks.conf"
    validate_local_path_text "$src_base" "源根目录"
    validate_local_path_text "$dest_base" "目标根目录"
    [[ -d "$src_base" ]] || die "源根目录不存在：${src_base}"
    mkdir -p -- "$dest_base"
    src_base=$(realpath "$src_base")
    dest_base=$(realpath "$dest_base")
    [[ "$dest_base" != "/" ]] || die "目标根目录不能是 /"
    [[ "$src_base" != "$dest_base" ]] || die "源根目录和目标根目录不能相同"

    [[ -f "$config_file" && -r "$config_file" ]] ||
        die "配置文件不存在或不可读：${config_file}"
    [[ -n "$INCP_IP" ]] || die "请通过环境变量 INCP_IP 设置 HiveServer2 地址"
    [[ -n "$INCP_USER" ]] || die "请通过环境变量 INCP_USER 设置 Hive 用户"

    for command_name in date realpath find cp rm kinit beeline hdfs awk; do
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
        if process_line_safely "$line_no" "$line"; then
            ((++success_count))
        else
            ((++fail_count))
        fi
    done < "$config_file"

    (( task_count > 0 )) || die "配置文件中没有可执行的任务"
    log "全部任务执行完成，共处理 ${task_count} 项，成功 ${success_count} 项，失败 ${fail_count} 项"
    (( fail_count == 0 )) || exit 2
}

main "$@"
