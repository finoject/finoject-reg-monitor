#!/bin/bash
# 母艦（Mac mini）常駐スクリプト
# launchd（com.finoject.mothership）から起動され、Remote Control セッションを
# 抱えたまま動き続ける。落ちれば launchd の KeepAlive が再起動する。
#
# 目的は「再起動やログアウトのあと、母艦が自力で戻ってくること」だけ。
# 2026-08-29 に起きた「メニューが開いたままで入力が詰まる」障害は、これでは防げない
# （プロセスは生きているため）。詳しくは README の「これで直らないもの」を参照。

set -u

# --- 設定 -------------------------------------------------
BASE_DIR="${MOTHERSHIP_BASE_DIR:-$HOME/mothership}"
CONFIG_FILE="$BASE_DIR/config.env"
LOG_DIR="$BASE_DIR/logs"
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).log"
LOCK_DIR="$BASE_DIR/.lock"        # mkdirの原子性でロックする（macOSにflockは無い）
PID_FILE="$BASE_DIR/claude.pid"   # 実際に claude を抱えているプロセスのpid

# launchd はログインシェルのPATHを引き継がない（claude/tmux が見えなくなる）
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$LOG_DIR"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG_FILE"; }

# shellcheck source=/dev/null
[ -f "$CONFIG_FILE" ] && . "$CONFIG_FILE"

# config.env を `.` で読んでもシェル変数になるだけで claude には渡らない。
# 認証系は明示的に export する（Keychainが読めない環境ではこれが生命線になる）。
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && export CLAUDE_CODE_OAUTH_TOKEN
[ -n "${ANTHROPIC_API_KEY:-}" ] && export ANTHROPIC_API_KEY

SESSION_NAME="${MOTHERSHIP_SESSION_NAME:-母艦}"
PTY_MODE="${MOTHERSHIP_PTY:-auto}"                    # auto | tmux | script
# 既存の手動運用に合わせた既定値。母艦は tmux セッション 'bokan' を
# tmux の既定ソケット上で使っているため、こちらもそれに合わせて
# 「既に在るならそれを引き継ぐ」ようにする（二重起動を作らないため）。
TMUX_SESSION="${MOTHERSHIP_TMUX_SESSION:-bokan}"
TMUX_SOCKET="${MOTHERSHIP_TMUX_SOCKET:-}"             # 空 = tmuxの既定ソケット
RC_LOG="${MOTHERSHIP_RC_LOG:-$HOME/Library/Logs/bokan-remote-control.log}"
WORKDIR="${MOTHERSHIP_WORKDIR:-$HOME}"
NET_WAIT_SEC="${MOTHERSHIP_NET_WAIT_SEC:-180}"
NET_PROBE_URL="${MOTHERSHIP_NET_PROBE_URL:-https://api.anthropic.com}"
LOG_RETENTION_DAYS="${MOTHERSHIP_LOG_RETENTION_DAYS:-30}"
FAIL_BACKOFF_SEC="${MOTHERSHIP_FAIL_BACKOFF_SEC:-300}"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"

# UNIXドメインソケットのパス長上限（sun_path: macOS 104 / Linux 108バイト）を超えると
# tmux が "File name too long" で起動できない。長すぎるときは短い場所へ逃がす。
if [ -n "$TMUX_SOCKET" ] && [ "${#TMUX_SOCKET}" -gt 90 ]; then
  TMUX_SOCKET="/tmp/mothership-$(id -u).sock"
fi

# tmux の -S は「指定したときだけ」渡す。macOS の bash 3.2 では set -u のもとで
# 空配列の "${arr[@]}" が unbound エラーになるため、必ず ${arr[@]+...} で包む。
if [ -n "$TMUX_SOCKET" ]; then TMUX_ARGS=(-S "$TMUX_SOCKET"); else TMUX_ARGS=(); fi
tmux_() { tmux ${TMUX_ARGS[@]+"${TMUX_ARGS[@]}"} "$@"; }

# --- 通知（母艦が上がらない＝チャット側からは何も見えないので必ず痕跡を残す） ---
notify() {
  log "NOTIFY: $1"
  if [ -n "${MOTHERSHIP_SLACK_WEBHOOK_URL:-}" ]; then
    local esc="${1//\\/\\\\}"; esc="${esc//\"/\\\"}"; esc="${esc//$'\n'/\\n}"
    curl -sS -m 20 -X POST -H 'Content-type: application/json' \
      --data "{\"text\":\"🖥️ 母艦: $esc\"}" "$MOTHERSHIP_SLACK_WEBHOOK_URL" >> "$LOG_FILE" 2>&1 \
      || log "NOTIFY: Slack Webhookへの通知に失敗"
  fi
  osascript -e "display notification \"$1\" with title \"母艦 Remote Control\"" 2>/dev/null
}

# 設定不備など、再試行しても直らない失敗。launchd の KeepAlive による
# 高速リトライ地獄を避けるため、通知してから十分に待って抜ける。
die_slowly() {
  notify "$1"
  sleep "$FAIL_BACKOFF_SEC"
  exit 1
}

# --- 多重起動の回避 ---------------------------------------
# pgrep -f は使わない。`--remote-control` や `remote-control` という文字列を
# 実行しているだけの無関係なシェルにも当たり、誤検知・誤kill を起こすため
# （調査中に実際に自分自身を巻き込んだ）。ロックとpidで確実に判定する。
lock_holder_is_alive() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # pidの再利用に備え、そのpidが本当にこのスクリプトかを確認する
  ps -o command= -p "$pid" 2>/dev/null | grep -q 'mothership\.sh'
}

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then echo $$ > "$LOCK_DIR/pid"; return 0; fi
  local old_pid=""
  [ -f "$LOCK_DIR/pid" ] && old_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if lock_holder_is_alive "$old_pid"; then return 1; fi
  log "WARN: 残存ロックを回収（前回pid=${old_pid:-unknown}）"
  rm -rf "$LOCK_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then echo $$ > "$LOCK_DIR/pid"; return 0; fi
  return 1
}

# --- ログのローテーション（日付名のみ。launchd-*.log は launchd が開き続けるので触らない） ---
find "$LOG_DIR" -maxdepth 1 -name '????-??-??.log' -mtime "+$LOG_RETENTION_DAYS" -delete 2>/dev/null

log "=== mothership 起動 (pid=$$) ==="

if ! acquire_lock; then
  log "SKIP: 別の mothership.sh が稼働中（pid=$(cat "$LOCK_DIR/pid" 2>/dev/null)）。60秒後に再確認する。"
  sleep 60
  exit 0
fi

CHILD_PID=""
ADOPTED=0
release() { rm -rf "$LOCK_DIR"; rm -f "$PID_FILE"; }
trap release EXIT

# --- 前提の確認 -------------------------------------------
command -v "$CLAUDE_BIN" >/dev/null 2>&1 || [ -x "$CLAUDE_BIN" ] \
  || die_slowly "claude コマンドが見つからない（${CLAUDE_BIN}）。config.env の CLAUDE_BIN で絶対パスを指定してください。"

cd "$WORKDIR" 2>/dev/null || die_slowly "作業ディレクトリに移動できない（${WORKDIR}）"

# --- pty の割り当て方式を決める ---------------------------
# tmux: 後から attach して画面を覗ける（推奨。手動運用と同じ形）
# script: macOS標準の /usr/bin/script で pty を作る（tmuxが無い場合）
if [ "$PTY_MODE" = "auto" ]; then
  if command -v tmux >/dev/null 2>&1; then PTY_MODE="tmux"; else PTY_MODE="script"; fi
fi

# --- 既存の母艦が居るなら、それを引き継ぐ -----------------
# 手で起動された tmux セッションが既にあるのに新しく立てると、母艦が二重になって
# セッションが分裂する。既に在るなら作らず、生存を見張るだけにする。
if [ "$PTY_MODE" = "tmux" ] && tmux_ has-session -t "$TMUX_SESSION" 2>/dev/null; then
  ADOPTED=1
  log "既存の tmux セッション '$TMUX_SESSION' を検出。新規には起動せず、これを引き継いで見張る。"
fi

# --- ネットワーク復帰待ち ---------------------------------
# 再起動直後は launchd の方が Wi-Fi/DNS より先に走る。ここで待たないと
# 起動に失敗し、KeepAlive の再試行を無駄に消費する。
# 既存を引き継ぐ場合は起動しないので待つ必要が無い。
if [ "$ADOPTED" -eq 0 ]; then
  waited=0
  until curl -sS -o /dev/null -m 10 "$NET_PROBE_URL" 2>/dev/null; do
    if [ "$waited" -ge "$NET_WAIT_SEC" ]; then
      log "WARN: ${NET_WAIT_SEC}秒待ってもネットワークに到達しない（${NET_PROBE_URL}）。それでも起動を試みる。"
      break
    fi
    [ "$waited" -eq 0 ] && log "ネットワーク復帰を待機中（${NET_PROBE_URL}）"
    sleep 5
    waited=$(( waited + 5 ))
  done
  [ "$waited" -gt 0 ] && log "ネットワーク待機: ${waited}秒"

  log "起動: mode=$PTY_MODE session='$SESSION_NAME' cwd='$WORKDIR' claude=$CLAUDE_BIN"
  "$CLAUDE_BIN" --version >> "$LOG_FILE" 2>&1
fi

cleanup() {
  log "シグナル受信。停止処理に入る。"
  # 引き継いだだけのセッションは、こちらの都合で落とさない
  if [ "$PTY_MODE" = "tmux" ] && [ "$ADOPTED" -eq 0 ]; then
    tmux_ kill-session -t "$TMUX_SESSION" 2>/dev/null
  elif [ -n "$CHILD_PID" ]; then
    kill -TERM "$CHILD_PID" 2>/dev/null
  fi
  release
  exit 0
}
trap cleanup TERM INT

EXIT_CODE=0
if [ "$PTY_MODE" = "tmux" ]; then
  if [ "$ADOPTED" -eq 0 ]; then
    mkdir -p "$(dirname "$RC_LOG")" 2>/dev/null
    # 起動の形は母艦の実運用に合わせる（`remote-control` サブコマンド + --name）。
    # `claude --remote-control <名前>` というオプション形式も有効だが、
    # 実績があるのはこちらなので既定はこちらにする。
    if ! tmux_ new-session -d -s "$TMUX_SESSION" -c "$WORKDIR" \
         "$CLAUDE_BIN" remote-control --name "$SESSION_NAME" ; then
      die_slowly "tmux セッションを起動できなかった。ログ: $LOG_FILE"
    fi
    log "tmux セッション '$TMUX_SESSION' で起動（覗く: tmux attach -t $TMUX_SESSION / 抜ける: Ctrl-b d）"
  fi
  tmux_ list-panes -t "$TMUX_SESSION" -F '#{pane_pid}' 2>/dev/null | head -1 > "$PID_FILE"

  # tmux は detach して即返るので、ここで生存を見張って launchd に「まだ生きている」と示し続ける。
  # 落ちたら抜けて KeepAlive に再起動させる。
  while tmux_ has-session -t "$TMUX_SESSION" 2>/dev/null; do
    sleep 20
  done
  log "tmux セッションが消滅した。launchd による再起動に委ねる。"
else
  # BSD script: `script [-q] <typescript file> <command...>`。/dev/null に捨てて pty だけ得る。
  # TUI の再描画をそのままログに流すとエスケープシーケンスで肥大するため、画面は捨てる。
  /usr/bin/script -q /dev/null "$CLAUDE_BIN" remote-control --name "$SESSION_NAME" >/dev/null 2>&1 &
  CHILD_PID=$!
  echo "$CHILD_PID" > "$PID_FILE"
  log "script(pty) で起動 pid=$CHILD_PID"
  wait "$CHILD_PID"
  EXIT_CODE=$?
  log "claude が終了した (exit=$EXIT_CODE)。launchd による再起動に委ねる。"
fi

# 想定外に即死する場合（認証切れ等）は、KeepAlive の連打を避けるため一拍置いて知らせる
if [ "$EXIT_CODE" -ne 0 ]; then
  notify "Remote Control が異常終了した (exit=$EXIT_CODE)。認証切れの可能性。ログ: $LOG_FILE"
  sleep 30
fi

exit "$EXIT_CODE"
