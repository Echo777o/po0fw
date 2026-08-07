#!/bin/sh
# po0fw - po0 防火墙自动加白（PC / 软路由 / Termux 通用版）
# https://github.com/kelenetwork/po0fw
#
# 用法:
#   PO0FW_TOKENS="pgnfw_xxx" ./po0fw.sh          # 环境变量方式
#   ./po0fw.sh pgnfw_xxx,pgnfw_yyy@0             # 参数方式（多 token 逗号分割, @N 固定槽位）
#   ./po0fw.sh status                            # 只看状态不加白
#
# 配置文件（可选，优先级低于环境变量/参数）: /etc/po0fw.conf 内容示例:
#   PO0FW_TOKENS="pgnfw_xxx,pgnfw_yyy@0"

set -u

API_BASE="${PO0FW_API:-https://console.po0.io/modules/servers/penguin/api/firewall.php}"
CONF="${PO0FW_CONF:-/etc/po0fw.conf}"
STATE_DIR="${PO0FW_STATE:-/tmp/po0fw}"
CURL_OPTS="-4sS -m 20 --retry 2 --retry-delay 2"

MODE="add"
ARG_TOKENS=""
case "${1:-}" in
  status) MODE="status" ;;
  "") ;;
  *) ARG_TOKENS="$1" ;;
esac

# token 来源优先级: 命令行参数 > 环境变量 > 配置文件
TOKENS="${ARG_TOKENS:-${PO0FW_TOKENS:-}}"
if [ -z "$TOKENS" ] && [ -f "$CONF" ]; then
  # shellcheck disable=SC1090
  . "$CONF"
  TOKENS="${PO0FW_TOKENS:-}"
fi
if [ -z "$TOKENS" ]; then
  echo "po0fw: 未配置 token。请设置 PO0FW_TOKENS 或写入 $CONF" >&2
  exit 1
fi

mkdir -p "$STATE_DIR" 2>/dev/null || STATE_DIR="/tmp"

log() { echo "[po0fw] $*"; }

# 探测本机 IPv4 出口（多源兜底，全部直连）
get_exit_ip() {
  for u in "https://api-ipv4.ip.sb/ip" "https://ipv4.icanhazip.com" "https://api.ipify.org"; do
    ip=$(curl $CURL_OPTS "$u" 2>/dev/null | tr -d ' \r\n')
    case "$ip" in
      *[!0-9.]*|"") continue ;;
      *) echo "$ip"; return 0 ;;
    esac
  done
  return 1
}

EXIT_IP=$(get_exit_ip) || { echo "po0fw: 无法探测出口 IPv4" >&2; exit 1; }
EXIT_NET=$(echo "$EXIT_IP" | awk -F. '{print $1"."$2"."$3".0/24"}')
# JSON 里 / 被转义为 \/，且必须只匹配 whitelist 数组的 "ip":"..." 条目，
# 不能全文匹配（status 响应的 currentIp 字段会回显调用者自己的网段，导致假阳性）
EXIT_NET_JSON="\"ip\":\"$(echo "$EXIT_NET" | sed 's|/|\\/|')\""
log "出口 IP: $EXIT_IP (网段 $EXIT_NET)"

FAIL=0
IDX=0
OLDIFS=$IFS; IFS=','
for entry in $TOKENS; do
  IFS=$OLDIFS
  IDX=$((IDX+1))
  entry=$(echo "$entry" | tr -d ' ')
  [ -z "$entry" ] && continue
  tok=${entry%@*}
  slot=""
  case "$entry" in *@*) slot=${entry##*@} ;; esac
  short=$(echo "$tok" | cut -c1-12)

  st=$(curl $CURL_OPTS "$API_BASE?action=status&token=$tok" 2>&1)
  if ! echo "$st" | grep -q '"whitelist"'; then
    log "#$IDX $short… status 失败: $st"
    FAIL=1
    IFS=','; continue
  fi

  if [ "$MODE" = "status" ]; then
    log "#$IDX $short… $st"
    IFS=','; continue
  fi

  # 已在白名单则跳过（幂等 + 不推进淘汰队列）；只匹配 whitelist 的 "ip":"..." 条目
  if echo "$st" | grep -qF "$EXIT_NET_JSON"; then
    log "#$IDX $short… ✅ $EXIT_NET 已在白名单，跳过"
    IFS=','; continue
  fi

  url="$API_BASE?action=add&token=$tok"
  [ -n "$slot" ] && url="$url&slot=$slot"
  res=$(curl $CURL_OPTS "$url" 2>&1)
  # add 后必须以复查 status 为准，不信任 add 的回显
  st2=$(curl $CURL_OPTS "$API_BASE?action=status&token=$tok" 2>/dev/null)
  if echo "$st2" | grep -qF "$EXIT_NET_JSON"; then
    log "#$IDX $short… ➕ 已加白 $EXIT_NET${slot:+ (槽位 $slot)}"
  else
    log "#$IDX $short… ❌ 加白失败，复查未见 $EXIT_NET。add 响应: $res"
    FAIL=1
  fi
  IFS=','
done
IFS=$OLDIFS

exit $FAIL
