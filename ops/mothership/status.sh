#!/bin/bash
# 母艦の生存確認。困ったらまずこれを実行する。
#   bash ops/mothership/status.sh   （または ~/mothership/status.sh）

BASE_DIR="${MOTHERSHIP_BASE_DIR:-$HOME/mothership}"
LABEL="com.finoject.mothership"
HC_LABEL="com.finoject.mcp-healthcheck"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[ -f "$BASE_DIR/config.env" ] && . "$BASE_DIR/config.env"
TMUX_SOCKET="${MOTHERSHIP_TMUX_SOCKET:-$BASE_DIR/tmux.sock}"
[ "${#TMUX_SOCKET}" -gt 90 ] && TMUX_SOCKET="/tmp/mothership-$(id -u).sock"
TMUX_SESSION="${MOTHERSHIP_TMUX_SESSION:-mothership}"

ok()   { printf '  \033[32m●\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m●\033[0m %s\n' "$1"; }

echo "=== 母艦ステータス $(date '+%F %T') ==="

echo; echo "[1] launchd 登録"
for L in "$LABEL" "$HC_LABEL"; do
  line="$(launchctl list 2>/dev/null | grep -F "$L")"
  if [ -n "$line" ]; then
    pid="$(echo "$line" | awk '{print $1}')"
    st="$(echo "$line" | awk '{print $2}')"
    if [ "$pid" != "-" ]; then ok "$L 稼働中 (pid=$pid)"; else
      [ "$st" = "0" ] && ok "$L 登録済み（常駐しない種別/待機中）" || bad "$L 停止中 (最終終了コード=$st)"
    fi
  else
    bad "$L 未登録"
  fi
done

echo; echo "[2] Remote Control プロセス"
# pgrep -f "--remote-control" は使わない。その文字列を含むコマンドラインを実行中の
# 無関係なシェルにも当たるため（判定が壊れるだけでなく、killに使うと事故になる）。
PID_FILE="$BASE_DIR/claude.pid"
CPID="$( [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null )"
if [ -n "$CPID" ] && kill -0 "$CPID" 2>/dev/null; then
  ok "稼働中 (pid=$CPID)"
  ps -o pid,etime,command -p "$CPID" 2>/dev/null | sed 1d | cut -c1-140 | sed 's/^/      /'
else
  bad "動いていない → これが computer_unreachable の原因"
  [ -n "$CPID" ] && echo "      （$PID_FILE は pid=$CPID を指しているが、そのプロセスは居ない）"
  # 常駐の外で手起動されたものが居ないかだけ、表示目的で確認する（killはしない）
  STRAY="$(ps -eo pid=,command= 2>/dev/null | grep -- '--remote-control' | grep -i 'claude' | grep -v ' grep ' | grep -v "^ *$$ ")"
  [ -n "$STRAY" ] && { echo "      常駐外で動いている可能性のあるプロセス:"; echo "$STRAY" | cut -c1-140 | sed 's/^/      /'; }
fi

echo; echo "[3] tmux セッション"
if command -v tmux >/dev/null 2>&1 && tmux -S "$TMUX_SOCKET" has-session -t "$TMUX_SESSION" 2>/dev/null; then
  ok "あり（覗く: tmux -S $TMUX_SOCKET attach -t $TMUX_SESSION / 抜ける: Ctrl-b d）"
else
  echo "  － なし（script モードなら正常）"
fi

echo; echo "[4] 電源設定（寝ると全 bridge セッションが落ちる）"
for k in sleep disksleep womp autorestart powernap; do
  v="$(pmset -g custom 2>/dev/null | grep -E "^[[:space:]]*$k[[:space:]]" | head -1 | awk '{print $2}')"
  case "$k:$v" in
    sleep:0|disksleep:0|womp:1|autorestart:1|powernap:0) ok "$k = $v" ;;
    *:"") echo "  － $k 取得不可" ;;
    *) bad "$k = $v （power-settings.sh を未適用）" ;;
  esac
done

echo; echo "[5] 自動ログイン（再起動後に自力で復帰できるか）"
au="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null)"
[ -n "$au" ] && ok "有効 (user=$au)" || bad "無効 → 再起動すると手でログインするまで母艦は戻らない"

echo; echo "[6] 直近のログ"
LOG="$BASE_DIR/logs/$(date +%Y-%m-%d).log"
[ -f "$LOG" ] && tail -n 12 "$LOG" | sed 's/^/      /' || echo "      本日のログなし ($LOG)"
if [ -s "$BASE_DIR/logs/launchd-err.log" ]; then
  echo; echo "  launchd-err.log の末尾:"; tail -n 5 "$BASE_DIR/logs/launchd-err.log" | sed 's/^/      /'
fi

echo; echo "[7] claude"
command -v claude >/dev/null 2>&1 && ok "$(claude --version 2>&1 | head -1)" || bad "claude が PATH に無い"
