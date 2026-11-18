#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$ROOT/tmp/ssh-test"
KEYS="$TEST_DIR/keys"
SANDBOX="$TEST_DIR/sandbox"
LOGS="$TEST_DIR/logs"
CONFIG="$TEST_DIR/sshd_config"
PIDFILE="$TEST_DIR/sshd.pid"
PORT="${TERMIX_TEST_SSH_PORT:-22222}"
USER_NAME="${USER:-$(id -un)}"
SSHD_BIN="${SSHD_BIN:-/usr/sbin/sshd}"
SFTP_SERVER_BIN="${SFTP_SERVER_BIN:-/usr/libexec/sftp-server}"

if [[ ! -x "$SFTP_SERVER_BIN" ]]; then
  for candidate in /usr/lib/openssh/sftp-server /usr/lib/ssh/sftp-server; do
    if [[ -x "$candidate" ]]; then
      SFTP_SERVER_BIN="$candidate"
      break
    fi
  done
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

is_running() {
  [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

setup() {
  require_command ssh-keygen
  require_command "$SSHD_BIN"
  mkdir -p "$KEYS" "$SANDBOX" "$LOGS"

  if [[ ! -f "$KEYS/host_ed25519" ]]; then
    ssh-keygen -q -t ed25519 -N '' -C 'termix-test-host' -f "$KEYS/host_ed25519"
  fi
  if [[ ! -f "$KEYS/client_ed25519" ]]; then
    ssh-keygen -q -t ed25519 -N '' -C 'termix-test-client' -f "$KEYS/client_ed25519"
  fi
  cp "$KEYS/client_ed25519.pub" "$KEYS/authorized_keys"
  chmod 600 "$KEYS/host_ed25519" "$KEYS/client_ed25519" "$KEYS/authorized_keys"

  cat > "$CONFIG" <<EOF
Port $PORT
ListenAddress 127.0.0.1
HostKey $KEYS/host_ed25519
PidFile $PIDFILE
AuthorizedKeysFile $KEYS/authorized_keys
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
UsePAM no
AllowUsers $USER_NAME
Subsystem sftp $SFTP_SERVER_BIN
LogLevel VERBOSE
EOF
}

start() {
  setup
  if is_running; then
    echo "SSH test server already running on 127.0.0.1:$PORT"
    return
  fi
  "$SSHD_BIN" -t -f "$CONFIG"
  "$SSHD_BIN" -f "$CONFIG" -E "$LOGS/sshd.log"
  sleep 0.3
  if ! is_running; then
    echo "sshd failed to start; see $LOGS/sshd.log" >&2
    exit 1
  fi
  echo "SSH test server started on 127.0.0.1:$PORT"
}

stop() {
  if ! is_running; then
    rm -f "$PIDFILE"
    echo "SSH test server is not running"
    return
  fi
  kill "$(cat "$PIDFILE")"
  sleep 0.3
  rm -f "$PIDFILE"
  echo "SSH test server stopped"
}

status() {
  if is_running; then
    echo "running on 127.0.0.1:$PORT (PID $(cat "$PIDFILE"))"
  else
    echo "stopped"
    return 1
  fi
}

smoke() {
  start
  require_command ssh
  require_command sftp
  local known_hosts="$KEYS/known_hosts"
  local ssh_args=(-p "$PORT" -i "$KEYS/client_ed25519" -o BatchMode=yes
    -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$known_hosts")
  local sftp_args=(-P "$PORT" -i "$KEYS/client_ed25519" -o BatchMode=yes
    -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$known_hosts")
  printf 'ssh-sftp-smoke\n' > "$SANDBOX/upload-source.txt"

  local output
  output="$(ssh "${ssh_args[@]}" "$USER_NAME@127.0.0.1" 'printf "SSH_OK\n"; whoami')"
  local expected=$'SSH_OK\n'"$USER_NAME"
  [[ "$output" == "$expected" ]] || {
    echo "unexpected SSH output: $output" >&2
    exit 1
  }

  sftp "${sftp_args[@]}" -b - "$USER_NAME@127.0.0.1" <<EOF
put "$SANDBOX/upload-source.txt" "$SANDBOX/uploaded-by-sftp.txt"
get "$SANDBOX/uploaded-by-sftp.txt" "$SANDBOX/downloaded-by-sftp.txt"
bye
EOF
  [[ -f "$SANDBOX/uploaded-by-sftp.txt" && -f "$SANDBOX/downloaded-by-sftp.txt" ]]
  echo "SSH/SFTP smoke test passed"
}

rust_test() {
  start
  require_command ssh-keygen
  local fingerprint
  fingerprint="$(ssh-keygen -lf "$KEYS/host_ed25519.pub" | awk '{print $2}')"
  (
    cd "$ROOT/src-tauri"
    TERMIX_TEST_SSH_PORT="$PORT" \
    TERMIX_TEST_SSH_USER="$USER_NAME" \
    TERMIX_TEST_SSH_KEY="$KEYS/client_ed25519" \
    TERMIX_TEST_SSH_SANDBOX="$SANDBOX" \
    TERMIX_TEST_SSH_FINGERPRINT="$fingerprint" \
    cargo test local_sshd_ -- --nocapture
  )
}

case "${1:-all}" in
  setup) setup ;;
  start) start ;;
  stop) stop ;;
  status) status ;;
  smoke) smoke ;;
  rust-test) rust_test ;;
  all)
    start
    smoke
    rust_test
    ;;
  *)
    echo "usage: $0 [setup|start|stop|status|smoke|rust-test|all]" >&2
    exit 2
    ;;
esac
