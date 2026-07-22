#!/usr/bin/env bash
#
# 根据 system.views_v.origin_text 查询视图 SQL，从 FROM/JOIN 中提取源表。
#
# 用法:
#   ./view_to_source_tables.sh /path/to/views.txt /path/to/view_source_tables.txt
#
# 输入文件格式（支持空行和 # 注释；可使用空格、制表符或 | 分隔）:
#   [fdm.]view_name 开始日期 结束日期
#
# 输出文件格式（| 分隔；一个视图对应多个源表时输出多行）:
#   视图名|源表库名|源表名|开始日期|结束日期
#
# 同时在输出文件所在目录生成 prod_data_recover.txt:
#   源表库名.源表名 YYYYMMDD-YYYYMMDD

set -Eeuo pipefail
IFS=$'\n\t'
umask 027

INCP_IP="${INCP_IP:-}"
INCP_USER="${INCP_USER:-}"
INCP_PASSWD="${INCP_PASSWD:-}"
KRB_KEYTAB="${KRB_KEYTAB:-/home/tyf/etc/ekg.keytab}"
KRB_PRINCIPAL="${KRB_PRINCIPAL:-ekg@TDH}"
VIEW_DATABASE="${VIEW_DATABASE:-fdm}"
VIEW_SOURCE_QUERY="${VIEW_SOURCE_QUERY:-0}"

TEMP_OUTPUT=""
TEMP_RECOVER_OUTPUT=""

# 方法说明：执行 log 函数，完成对应脚本处理。

# 参数说明：$@ 为位置参数。

# 返回说明：通过退出码表示执行成功或失败。

log() {
    printf '[%s] %s\n' "$(date '+%F %T')" "$*" >&2
}

# 方法说明：执行 die 函数，完成对应脚本处理。

# 参数说明：$@ 为位置参数。

# 返回说明：通过退出码表示执行成功或失败。

die() {
    log "错误：$*"
    exit 1
}

# 方法说明：执行 cleanup 函数，完成对应脚本处理。

# 参数说明：无显式位置参数。

# 返回说明：通过退出码表示执行成功或失败。

cleanup() {
    [[ -z "$TEMP_OUTPUT" ]] || rm -f -- "$TEMP_OUTPUT"
    [[ -z "$TEMP_RECOVER_OUTPUT" ]] || rm -f -- "$TEMP_RECOVER_OUTPUT"
}

# 方法说明：执行 on_error 函数，完成对应脚本处理。

# 参数说明：无显式位置参数。

# 返回说明：通过退出码表示执行成功或失败。

on_error() {
    local exit_code=$?
    log "执行失败：第 ${BASH_LINENO[0]} 行，退出码 ${exit_code}"
    exit "$exit_code"
}
trap cleanup EXIT
trap on_error ERR

# 方法说明：执行 trim 函数，完成对应脚本处理。

# 参数说明：$1 为位置参数。

# 返回说明：通过退出码表示执行成功或失败。

trim() {
    local value=$1
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf '%s' "$value"
}

# 方法说明：执行 require_command 函数，完成对应脚本处理。

# 参数说明：$1 为位置参数。

# 返回说明：通过退出码表示执行成功或失败。

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "未找到命令：$1"
}

# 方法说明：执行 validate_identifier 函数，完成对应脚本处理。

# 参数说明：$1 为位置参数；$2 为位置参数。

# 返回说明：通过退出码表示执行成功或失败。

validate_identifier() {
    local value=$1
    local label=$2
    [[ "$value" =~ ^[a-z_][a-z0-9_]*$ ]] ||
        die "${label}不合法：${value}；只允许字母、数字和下划线，且不能以数字开头"
}

# 方法说明：执行 normalize_date 函数，完成对应脚本处理。

# 参数说明：$1 为位置参数。

# 返回说明：通过退出码表示执行成功或失败。

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
        die "日期格式不合法：${input}；支持 YYYYMMDD、YYYY/M/D、YYYY/MM/DD、YYYY-M-D、YYYY-MM-DD"
    fi

    parsed=$(date -d "$normalized" '+%F' 2>/dev/null) ||
        die "日期不存在：${input}"
    [[ "$parsed" == "$normalized" ]] || die "日期不存在：${input}"
    printf '%s' "$normalized"
}

# 方法说明：执行 compact_date 函数，完成对应脚本处理。

# 参数说明：$1 为位置参数。

# 返回说明：通过退出码表示执行成功或失败。

compact_date() {
    local value=$1
    printf '%s' "${value//-/}"
}

# 方法说明：执行 beeline_run 函数，完成对应脚本处理。

# 参数说明：$1 为位置参数。

# 返回说明：通过退出码表示执行成功或失败。

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

# 方法说明：执行 query_view_origin_text 函数，完成对应脚本处理。

# 参数说明：$1 为位置参数。

# 返回说明：通过退出码表示执行成功或失败。

query_view_origin_text() {
    local view_name=$1
    local database_name=${view_name%%.*}
    local table_name=${view_name#*.}
    local origin_text

    log "查询视图定义：${view_name}"
    if ! origin_text=$(beeline_run \
        "SELECT origin_text FROM system.views_v WHERE database_name='${database_name}' AND view_name='${table_name}' LIMIT 1"); then
        die "查询 system.views_v.origin_text 失败：${view_name}"
    fi

    [[ -n "$origin_text" ]] ||
        die "system.views_v 中未找到视图或 origin_text 为空：${view_name}"

    printf '%s\n' "$origin_text"
}

# 方法说明：执行 extract_base_tables 函数，完成对应脚本处理。

# 参数说明：$1 为位置参数；$2 为位置参数。

# 返回说明：通过退出码表示执行成功或失败。

extract_base_tables() {
    local root_view=$1

    # origin_text 经 Beeline CSV 输出后，最外层可能有双引号，内部双引号会写成 ""。
    # 解析前删除 SQL 注释及字符串常量，避免从注释和表达式中误提取表名。
    ROOT_VIEW="$root_view" perl -0777 -ne '
        s/\r//g;
        s/^"//s;
        s/"\s*$//s;
        s/""/"/g;

        s{/\*.*?\*/}{ }gs;
        s{--[^\n]*}{ }g;
        s{\#[^\n]*}{ }g;
        s{\x27(?:\x27\x27|[^\x27])*\x27}{ }gs;

        my $root = lc($ENV{"ROOT_VIEW"} // "");
        my %seen;

        while (/\b(?:from|join)\s+
                `?([a-z_][a-z0-9_]*)`?\s*\.\s*
                `?([a-z_][a-z0-9_]*)`?
               /igx) {
            my ($database, $table) = (lc($1), lc($2));
            my $key = "$database.$table";
            next if $key eq $root;
            next if $seen{$key}++;
            print "$database\t$table\n";
        }
    '
}

# 方法说明：执行 emit_source_table 函数，完成对应脚本处理。

# 参数说明：$1 为位置参数；$2 为位置参数；$3 为位置参数；$4 为位置参数；$5 为位置参数。

# 返回说明：通过退出码表示执行成功或失败。

emit_source_table() {
    local root_view=$1
    local source_database=$2
    local source_table=$3
    local start_date=$4
    local end_date=$5
    local compact_start compact_end

    printf '%s|%s|%s|%s|%s\n' \
        "$root_view" "$source_database" "$source_table" "$start_date" "$end_date" >> "$TEMP_OUTPUT"

    compact_start=$(compact_date "$start_date")
    compact_end=$(compact_date "$end_date")
    printf '%s.%s %s-%s\n' \
        "$source_database" "$source_table" "$compact_start" "$compact_end" >> "$TEMP_RECOVER_OUTPUT"
}

# 方法说明：执行 expand_view_sources 函数，完成对应脚本处理。

# 参数说明：$1 为位置参数；$2 为位置参数；$3 为位置参数；$4 为位置参数；$5 为位置参数。

# 返回说明：通过退出码表示执行成功或失败。

expand_view_sources() {
    local root_view=$1
    local current_view=$2
    local start_date=$3
    local end_date=$4
    local visited=${5:-}
    local origin_text source_tables source_database source_table next_view
    local source_count=0

    if [[ "|${visited}|" == *"|${current_view}|"* ]]; then
        die "检测到 fdm 视图循环依赖：${visited}|${current_view}"
    fi
    visited="${visited:+${visited}|}${current_view}"

    origin_text=$(query_view_origin_text "$current_view")
    source_tables=$(printf '%s\n' "$origin_text" | extract_base_tables "$current_view")
    if [[ -z "$source_tables" ]]; then
        log "警告：未从视图中解析到源表：${current_view}"
        return
    fi

    while IFS=$'\t' read -r source_database source_table; do
        [[ -n "$source_database" && -n "$source_table" ]] || continue

        if [[ "$source_database" == "$VIEW_DATABASE" ]]; then
            next_view="${source_database}.${source_table}"
            log "继续展开 fdm 源视图：${current_view} -> ${next_view}"
            expand_view_sources "$root_view" "$next_view" "$start_date" "$end_date" "$visited"
        else
            emit_source_table "$root_view" "$source_database" "$source_table" "$start_date" "$end_date"
            ((++source_count))
        fi
    done <<< "$source_tables"

    log "${current_view} 展开得到 ${source_count} 个直接非 fdm 源表"
}

# 方法说明：执行 process_view 函数，完成对应脚本处理。

# 参数说明：$1 为位置参数；$2 为位置参数；$3 为位置参数。

# 返回说明：通过退出码表示执行成功或失败。

process_view() {
    local view_name=$1
    local start_date=$2
    local end_date=$3
    local database_name=${view_name%%.*}
    local table_name=${view_name#*.}

    validate_identifier "$database_name" "视图库名"
    validate_identifier "$table_name" "视图名"
    [[ "$database_name" == "$VIEW_DATABASE" ]] ||
        die "仅允许查询 ${VIEW_DATABASE} 库中的视图，收到：${view_name}"

    expand_view_sources "$view_name" "$view_name" "$start_date" "$end_date"
}

# 方法说明：执行 process_line_safely 函数，完成对应脚本处理。

# 参数说明：$1 为位置参数；$2 为位置参数。

# 返回说明：通过退出码表示执行成功或失败。

process_line_safely() {
    local line_no=$1
    local raw_line=$2
    local line view_name start_date end_date extra
    local line_output line_recover

    line_output=$(mktemp "${TEMP_OUTPUT}.line.${line_no}.XXXXXX")
    line_recover=$(mktemp "${TEMP_RECOVER_OUTPUT}.line.${line_no}.XXXXXX")

    if (
        trap - ERR
        set -Eeuo pipefail

        TEMP_OUTPUT=$line_output
        TEMP_RECOVER_OUTPUT=$line_recover

        line=${raw_line//|/ }
        IFS=$' \t' read -r view_name start_date end_date extra <<< "$line"
        [[ -n "${view_name:-}" && -z "${extra:-}" ]] ||
            die "视图列表第 ${line_no} 行必须包含视图名"

        # 视图名忽略大小写；未提供库名时使用 VIEW_DATABASE（默认 fdm）。
        view_name=${view_name,,}
        if [[ "$view_name" != *.* ]]; then
            view_name="${VIEW_DATABASE}.${view_name}"
        fi
        [[ "$view_name" =~ ^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$ ]] ||
            die "视图列表第 ${line_no} 行视图名格式不合法：${view_name}"

        if [[ -n "${start_date:-}" ]]; then
            start_date=$(normalize_date "$start_date")
        elif [[ "$VIEW_SOURCE_QUERY" != "1" ]]; then
            die "视图列表第 ${line_no} 行缺少开始日期"
        fi
        if [[ -n "${end_date:-}" ]]; then
            end_date=$(normalize_date "$end_date")
        elif [[ "$VIEW_SOURCE_QUERY" != "1" ]]; then
            die "视图列表第 ${line_no} 行缺少结束日期"
        fi
        if [[ -n "${start_date:-}" && -n "${end_date:-}" ]]; then
            [[ "$start_date" < "$end_date" || "$start_date" == "$end_date" ]] ||
                die "视图列表第 ${line_no} 行开始日期 ${start_date} 晚于结束日期 ${end_date}"
        fi

        process_view "$view_name" "$start_date" "$end_date"
    ); then
        cat "$line_output" >> "$TEMP_OUTPUT"
        cat "$line_recover" >> "$TEMP_RECOVER_OUTPUT"
        rm -f -- "$line_output" "$line_recover"
        log "视图列表第 ${line_no} 行处理成功"
        return 0
    else
        local exit_code=$?
        rm -f -- "$line_output" "$line_recover"
        log "错误：视图列表第 ${line_no} 行处理失败，已跳过：${raw_line}，退出码 ${exit_code}"
        return 1
    fi
}

# 方法说明：执行 main 函数，完成对应脚本处理。

# 参数说明：$1 为位置参数；$2 为位置参数；$@ 为位置参数。

# 返回说明：通过退出码表示执行成功或失败。

main() {
    local input_file=${1:-}
    local output_file=${2:-}
    local output_dir recover_file line
    local line_no=0 view_count=0 success_count=0 fail_count=0

    [[ $# -eq 2 ]] || die "用法：$0 /path/to/views.txt /path/to/view_source_tables.txt"
    [[ -f "$input_file" && -r "$input_file" ]] ||
        die "视图列表文件不存在或不可读：${input_file}"
    [[ -n "$output_file" ]] || die "输出文件路径不能为空"
    [[ -n "$INCP_IP" ]] || die "请通过环境变量 INCP_IP 设置 HiveServer2 地址"
    [[ -n "$INCP_USER" ]] || die "请通过环境变量 INCP_USER 设置 Hive 用户"

    VIEW_DATABASE=${VIEW_DATABASE,,}
    validate_identifier "$VIEW_DATABASE" "允许的视图库名"

    for command_name in date dirname mkdir mktemp mv rm sort kinit beeline perl; do
        require_command "$command_name"
    done

    [[ -r "$KRB_KEYTAB" ]] || die "Kerberos keytab 不存在或不可读：${KRB_KEYTAB}"

    output_dir=$(dirname -- "$output_file")
    mkdir -p -- "$output_dir"
    recover_file="${output_dir}/prod_data_recover.txt"
    TEMP_OUTPUT=$(mktemp "${output_file}.tmp.XXXXXX")
    TEMP_RECOVER_OUTPUT=$(mktemp "${recover_file}.tmp.XXXXXX")

    log "执行 Kerberos 认证：${KRB_PRINCIPAL}"
    kinit -kt "$KRB_KEYTAB" "$KRB_PRINCIPAL"

    while IFS= read -r line || [[ -n "$line" ]]; do
        ((++line_no))
        line=${line%$'\r'}
        line=$(trim "$line")
        [[ -z "$line" || "$line" == \#* ]] && continue

        ((++view_count))
        if process_line_safely "$line_no" "$line"; then
            ((++success_count))
        else
            ((++fail_count))
        fi
    done < "$input_file"

    (( view_count > 0 )) || die "视图列表文件中没有可执行的视图"

    # 保证同一视图与源表映射唯一，并使用临时文件避免失败时产生半成品。
    LC_ALL=C sort -u "$TEMP_OUTPUT" -o "$TEMP_OUTPUT"
    LC_ALL=C sort -u "$TEMP_RECOVER_OUTPUT" -o "$TEMP_RECOVER_OUTPUT"
    mv -f -- "$TEMP_OUTPUT" "$output_file"
    mv -f -- "$TEMP_RECOVER_OUTPUT" "$recover_file"
    TEMP_OUTPUT=""
    TEMP_RECOVER_OUTPUT=""

    log "处理完成：共处理 ${view_count} 个视图，成功 ${success_count} 个，失败 ${fail_count} 个，映射文件：${output_file}，恢复文件：${recover_file}"
    (( fail_count == 0 )) || exit 2
}

main "$@"
