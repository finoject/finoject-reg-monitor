#!/bin/bash
# 母艦ヘルスチェック実行スクリプト
# launchd（com.finoject.mcp-healthcheck）から毎朝7:00に起動される。
# 役割は「claude -p を1回だけ確実に走らせ、静かに失敗させないこと」。
# 点検内容そのものは healthcheck-prompt.md 側にあり、このスクリプトは触らずに育てられる。

set -u

# --- 設定 -------------------------------------------------
BASE_DIR="${HEALTHCHECK_BASE_DIR:-$HOME/healthcheck}"
PROMPT_FILE="$BASE_DIR/healthcheck-prompt.md"
CONFIG_FILE="$BASE_DIR/config.env"
LOG_DIR="$BASE_DIR/logs"
LOCK_DIR="$BASE_DIR/.lock"          # mkdirの原子性を使ったロック（macOSにflockは無い）
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).log"

# launchdはログインシェルのPATHを引き継がないため明示する
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG_FILE"; }

# --- 設定ファイル（秘密情報はリポジトリに置かずここで与える） ---
# HEALTHCHECK_SLACK_WEBHOOK_URL / SLACK_CHANNEL / REG_MONITOR_DATA_URL /
# STALE_HOURS / TIMEOUT_SEC / MAX_TURNS / LOG_RETENTION_DAYS を上書きできる。
# shellcheck source=/dev/null
[ -f "$CONFIG_FILE" ] && . "$CONFIG_FILE"

SLACK_CHANNEL="${SLACK_CHANNEL:-#ops}"
REG_MONITOR_DATA_URL="${REG_MONITOR_DATA_URL:-https://finoject.github.io/finoject-reg-monitor/data.json}"
STALE_HOURS="${STALE_HOURS:-3}"     # 巡回は毎時:37。数回の遅延/ドロップは許して3時間で異常とする
TIMEOUT_SEC="${TIMEOUT_SEC:-600}"   # 10分で打ち切り
MAX_TURNS="${MAX_TURNS:-30}"
LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-30}"

CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"
JQ_BIN="$(command -v jq || true)"

# --- フォールバック通知（claude自体が死んでいる場合用） ---
# 利用枠上限・認証切れ・タイムアウト時はSlack MCPも使えない。claudeに依存しない経路で必ず痕跡を残す。
notify_fallback() {
  local msg="⚠️ 母艦ヘルスチェック失敗: $1"
  log "FALLBACK: $1"

  # 1) Slack Incoming Webhook（claudeを経由しないので最も生存性が高い）
  if [ -n "${HEALTHCHECK_SLACK_WEBHOOK_URL:-}" ]; then
    local payload
    if [ -n "$JQ_BIN" ]; then
      payload="$("$JQ_BIN" -n --arg t "$msg" '{text:$t}')"
    else
      # jqが無い場合の最小エスケープ（バックスラッシュ→引用符→改行の順で処理する）
      local esc="${msg//\\/\\\\}"; esc="${esc//\"/\\\"}"; esc="${esc//$'\n'/\\n}"
      payload="{\"text\":\"$esc\"}"
    fi
    if ! curl -sS -m 20 -X POST -H 'Content-type: application/json' \
         --data "$payload" "$HEALTHCHECK_SLACK_WEBHOOK_URL" >> "$LOG_FILE" 2>&1; then
      log "FALLBACK: Slack Webhookへの通知も失敗"
    fi
  fi

  # 2) macOS通知（GUIセッションにログイン中のときだけ届く）
  osascript -e "display notification \"$1\" with title \"母艦ヘルスチェック失敗\"" 2>/dev/null
}

# --- 多重起動防止（前回実行が長引いた場合に重ねない） -----
# ロックが残ったまま母艦が再起動/強制終了すると、以後永久にSKIPして「静かに死ぬ」。
# それを防ぐため、プロセス生存とロック年齢の両方で残存ロックを回収する。
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then echo $$ > "$LOCK_DIR/pid"; return 0; fi

  local old_pid=""; local stale=0
  [ -f "$LOCK_DIR/pid" ] && old_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"

  if [ -z "$old_pid" ] || ! kill -0 "$old_pid" 2>/dev/null; then
    stale=1   # ロックを作った側が居ない＝異常終了の置き土産
  elif [ -z "$(find "$LOCK_DIR" -maxdepth 0 -mmin "-$(( (TIMEOUT_SEC * 2 + 59) / 60 ))" 2>/dev/null)" ]; then
    stale=1   # 生きてはいるがタイムアウトの2倍以上経過＝PID再利用か本当のハング
  fi

  if [ "$stale" -eq 1 ]; then
    log "WARN: 残存ロックを回収（前回pid=${old_pid:-unknown}）"
    rm -rf "$LOCK_DIR"
    if mkdir "$LOCK_DIR" 2>/dev/null; then echo $$ > "$LOCK_DIR/pid"; return 0; fi
  fi
  return 1
}

if ! acquire_lock; then
  log "SKIP: 前回の実行が継続中（ロックあり）"
  exit 0
fi
trap 'rm -rf "$LOCK_DIR"' EXIT

# --- 前提の確認 -------------------------------------------
if [ ! -x "$CLAUDE_BIN" ] && ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  notify_fallback "claudeコマンドが見つからない（$CLAUDE_BIN）。ログ: $LOG_FILE"
  exit 1
fi
if [ ! -f "$PROMPT_FILE" ]; then
  notify_fallback "点検プロンプトが無い（$PROMPT_FILE）。ログ: $LOG_FILE"
  exit 1
fi

# --- 本体実行 ---------------------------------------------
log "START"

# プロンプト内のプレースホルダを設定値で埋める（プロンプトを静的ファイルのまま可変にする）
PROMPT_TEXT="$(sed \
  -e "s|__SLACK_CHANNEL__|${SLACK_CHANNEL}|g" \
  -e "s|__REG_MONITOR_DATA_URL__|${REG_MONITOR_DATA_URL}|g" \
  -e "s|__STALE_HOURS__|${STALE_HOURS}|g" \
  "$PROMPT_FILE")"

OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/healthcheck-result.XXXXXX")"
trap 'rm -rf "$LOCK_DIR"; rm -f "$OUT_FILE"' EXIT

# 権限の最小化: 読み取り系Bashと点検に要るMCPだけ許可し、書き込み系は明示的に禁止する。
# Bashのパターンは Claude Code の書式に合わせて `Bash(cmd:*)`（前方一致）を使う。
# `Bash(df *)` のような空白+* は一致しないので通らない。
ALLOWED_TOOLS="Bash(claude mcp list),Bash(df:*),Bash(uptime),Bash(curl:*),Bash(jq:*),Bash(head:*),Bash(date:*),mcp__freee__freee_auth_status,mcp__Gmail__search_threads,mcp__Slack__slack_send_message"
DISALLOWED_TOOLS="Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task"

# claudeに渡す引数は1か所で組み立て、タイムアウト手段の有無で使い回す
CLAUDE_ARGS=( -p "$PROMPT_TEXT"
  --output-format json
  --max-turns "$MAX_TURNS"
  --allowedTools "$ALLOWED_TOOLS"
  --disallowedTools "$DISALLOWED_TOOLS" )

TIMED_OUT=0
TIMEOUT_BIN="$(command -v gtimeout || command -v timeout || true)"
if [ -n "$TIMEOUT_BIN" ]; then
  "$TIMEOUT_BIN" -k 30 "$TIMEOUT_SEC" "$CLAUDE_BIN" "${CLAUDE_ARGS[@]}" \
    > "$OUT_FILE" 2>> "$LOG_FILE"
  EXIT_CODE=$?
  [ "$EXIT_CODE" -eq 124 ] && TIMED_OUT=1
else
  # macOS標準に timeout / gtimeout は無い（brew install coreutils で入る）。無ければ自前で見張る。
  # ※ `VAR=$(cmd) &` は代入がサブシェルで起きるため親に値が残らない。必ずファイルに落としてから読む。
  # claudeはMCPサーバーを子プロセスとして抱える。親だけkillすると孫が居残るので、
  # 子孫を末端から順に落とす（macOSの標準pgrepで辿れる。setsidは無い）。
  kill_tree() {
    local pid="$1" sig="$2" kid
    for kid in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$kid" "$sig"; done
    kill "-$sig" "$pid" 2>/dev/null || true
  }
  "$CLAUDE_BIN" "${CLAUDE_ARGS[@]}" > "$OUT_FILE" 2>> "$LOG_FILE" &
  CLAUDE_PID=$!
  ( sleep "$TIMEOUT_SEC"
    kill_tree "$CLAUDE_PID" TERM
    sleep 30
    kill_tree "$CLAUDE_PID" KILL ) &
  WATCHER=$!
  wait "$CLAUDE_PID"
  EXIT_CODE=$?
  kill_tree "$WATCHER" TERM   # 見張り本体とその sleep をまとめて片付ける
  wait "$WATCHER" 2>/dev/null
  # SIGTERM/SIGKILLで落ちた＝見張りが打ち切った
  { [ "$EXIT_CODE" -eq 143 ] || [ "$EXIT_CODE" -eq 137 ]; } && TIMED_OUT=1
fi

# --- 結果ハンドリング -------------------------------------
cat "$OUT_FILE" >> "$LOG_FILE"

if [ "$TIMED_OUT" -eq 1 ]; then
  notify_fallback "claude -p が${TIMEOUT_SEC}秒でタイムアウト。ログ: $LOG_FILE"
  exit 1
fi

if [ "$EXIT_CODE" -ne 0 ]; then
  # 利用枠上限・認証切れ等で claude 自体が失敗したケース。
  notify_fallback "claude -p が終了コード $EXIT_CODE で失敗。ログ: $LOG_FILE"
  exit 1
fi

# JSON出力から is_error と本文を取り出す
IS_ERROR="false"; RESULT_TEXT=""
if [ -n "$JQ_BIN" ]; then
  IS_ERROR="$("$JQ_BIN" -r '.is_error // false' "$OUT_FILE" 2>/dev/null || echo unknown)"
  RESULT_TEXT="$("$JQ_BIN" -r '.result // ""' "$OUT_FILE" 2>/dev/null || echo "")"
else
  log "WARN: jqが無いためJSONを解析できない（brew install jq）"
  RESULT_TEXT="$(cat "$OUT_FILE")"
fi

if [ "$IS_ERROR" = "true" ] || [ "$IS_ERROR" = "unknown" ]; then
  notify_fallback "claudeは起動したが実行エラー（max-turns到達等）。ログ: $LOG_FILE"
  exit 1
fi

# 点検エージェントが判定を出さずに終わった（余計な作業をして打ち切られた等）ケースも
# 「静かな失敗」なので拾う。プロンプトは OK: / ALERT: で始めることを要求している。
case "$RESULT_TEXT" in
  OK:*)
    log "DONE OK: $RESULT_TEXT"
    printf '%s\n' "$RESULT_TEXT"
    ;;
  ALERT:*)
    log "DONE ALERT: $RESULT_TEXT"
    printf '%s\n' "$RESULT_TEXT"
    ;;
  *)
    notify_fallback "判定形式が不正（OK:/ALERT: で始まらない）。点検が完了していない可能性。ログ: $LOG_FILE"
    exit 1
    ;;
esac

# --- ログのローテーション ---------------------------------
# 日付名のログだけを対象にする（launchd-out.log / launchd-err.log はlaunchdが開き続けるため消さない）
find "$LOG_DIR" -maxdepth 1 -name '????-??-??.log' -mtime "+$LOG_RETENTION_DAYS" -delete 2>/dev/null

exit 0
