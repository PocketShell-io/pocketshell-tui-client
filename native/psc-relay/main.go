// Native local boundary. No TCP, token handling, shell evaluation or per-request environment injection.
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var version = "dev"
var traceStart = time.Now()

func trace(stage string) {
	if os.Getenv("PSC_TRACE") == "1" {
		b, _ := json.Marshal(map[string]any{"psc_trace": 1, "stage": stage, "elapsedMs": float64(time.Since(traceStart).Microseconds()) / 1000})
		fmt.Fprintln(os.Stderr, string(b))
	}
}

const maxFrame = 2 << 20
const maxInput = 1 << 20
const maxOutput = 16 << 20

type request struct {
	Protocol  int      `json:"protocol"`
	ID        string   `json:"id"`
	Namespace string   `json:"namespace"`
	Args      []string `json:"argv"`
	Input     []byte   `json:"stdin"`
	TTY       bool     `json:"tty"`
	Deadline  int64    `json:"deadline"`
	Cancel    bool     `json:"cancel,omitempty"`
}
type response struct {
	Protocol int    `json:"protocol"`
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Data     string `json:"data,omitempty"`
	Status   int    `json:"status"`
	Fallback bool   `json:"fallback,omitempty"`
}

func readFrame(r io.Reader) ([]byte, error) {
	var h [4]byte
	if _, e := io.ReadFull(r, h[:]); e != nil {
		return nil, e
	}
	n := binary.BigEndian.Uint32(h[:])
	if n == 0 || n > maxFrame {
		return nil, errors.New("frame bounds")
	}
	b := make([]byte, n)
	_, e := io.ReadFull(r, b)
	return b, e
}
func writeFrame(w io.Writer, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	if len(b) > maxFrame {
		return errors.New("frame bounds")
	}
	var h [4]byte
	binary.BigEndian.PutUint32(h[:], uint32(len(b)))
	if _, e = w.Write(h[:]); e != nil {
		return e
	}
	_, e = w.Write(b)
	return e
}

// Only explicit client settings cross the resident process boundary. In particular,
// ambient provider credentials, loader/preload options and TLS-disable flags do not.
func daemonEnvironment() []string {
	keys := []string{"HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "XDG_DATA_HOME", "APLEXER_RUNTIME_DIR", "APLEXER_STATE_DIR", "APLEXER_CONFIG", "POCKETSHELL_BROKER_URL", "NODE_EXTRA_CA_CERTS", "PSC_RPC_BINARY", "PSC_JSON", "PSC_HOST", "PSC_TRACE", "PSC_DAEMON_IDLE_MS", "USERPROFILE", "LOCALAPPDATA"}
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		if value, ok := os.LookupEnv(key); ok {
			result = append(result, key+"="+value)
		}
	}
	return result
}
func namespace() string {
	scope := daemonEnvironment()
	if cwd, err := os.Getwd(); err == nil {
		if canonical, e := filepath.EvalSymlinks(cwd); e == nil {
			scope = append(scope, "CWD="+canonical)
		}
	}
	h := sha256.Sum256([]byte(strings.Join(scope, "\x00")))
	return hex.EncodeToString(h[:8])
}

func eligible(a []string) bool {
	if len(a) == 0 {
		return false
	}
	if a[0] == "daemon" {
		return true
	}
	for _, s := range a {
		if s == "--help" || s == "-h" || s == "--wait-for" {
			return false
		}
	}
	for i, w := range a {
		if w == "--bytes" && i+1 < len(a) {
			n, e := strconv.Atoi(a[i+1])
			if e == nil && n > 1<<20 {
				return false
			}
		}
	}
	b := a
	if b[0] == "--json" {
		b = b[1:]
	}
	explicitRemote := len(b) > 0 && b[0] == "a"
	if explicitRemote {
		b = b[1:]
	}
	// Local top-level commands whose second word looks like a host verb
	// (`psc vault status`) never go to the daemon.
	if !explicitRemote && len(b) > 0 && b[0] == "vault" {
		return false
	}
	if len(b) == 0 {
		return false
	}
	if b[0] == "hosts" {
		return len(b) == 1 || b[1] == "--json" || b[1] == "--check" || b[1] == "check"
	}
	if len(b) < 2 {
		return false
	}
	switch b[1] {
	case "ls", "list", "status", "show", "capture", "send":
		return true
	}
	return false
}
func entry(name string) string {
	p, e := os.Executable()
	if e != nil {
		return ""
	}
	p, _ = filepath.EvalSymlinks(p)
	return filepath.Join(filepath.Dir(p), name)
}

// jsEntry resolves a sidecar JS entry for this binary's layout: the npm
// dist-bundle ships psc.mjs/daemon.mjs beside the relay binary, the
// Windows package ships psc/dist/cli.js and psc/dist/daemon/main.js.
func jsEntry(bundle, pkg string) (string, error) {
	for _, candidate := range []string{entry(bundle), entry(pkg)} {
		if candidate == "" {
			continue
		}
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("no %s beside the relay", bundle)
}

// The Node interpreter for the legacy entry and the resident daemon: a
// bundled node beside the relay binary (the Windows package layout) wins
// over whatever PATH the caller had.
const bundledNodeName = "node.exe"

func nodeCommand() string {
	if bundled := entry(bundledNodeName); bundled != "" {
		if _, err := os.Stat(bundled); err == nil {
			return bundled
		}
	}
	return "node"
}

func legacy(a []string, input []byte, consumed bool) int {
	js, e := jsEntry("psc.mjs", filepath.Join("psc", "dist", "cli.js"))
	if e != nil {
		fmt.Fprintln(os.Stderr, "psc: legacy entry unavailable")
		return 1
	}
	cmd := exec.Command(nodeCommand(), append([]string{js}, a...)...)
	if consumed {
		cmd.Stdin = strings.NewReader(string(input))
	} else {
		cmd.Stdin = os.Stdin
	}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	e = cmd.Run()
	if e == nil {
		return 0
	}
	var x *exec.ExitError
	if errors.As(e, &x) {
		return x.ExitCode()
	}
	fmt.Fprintln(os.Stderr, "psc: legacy entry unavailable")
	return 1
}
func relayFailure(a []string, code, message string) {
	wantJSON := os.Getenv("PSC_JSON") == "1"
	for _, word := range a {
		if word == "--" {
			break
		}
		if word == "--json" {
			wantJSON = true
		}
	}
	if wantJSON {
		b, _ := json.Marshal(map[string]any{"ok": false, "error": map[string]string{"code": code, "message": message}})
		fmt.Fprintln(os.Stdout, string(b))
	} else {
		fmt.Fprintln(os.Stderr, "psc: "+message)
	}
}
func relay(a []string) int {
	if len(a) == 1 && (a[0] == "--version" || a[0] == "-V") {
		fmt.Println(version)
		return 0
	}
	if !daemonEnabled() && !(len(a) > 0 && a[0] == "daemon") || !eligible(a) {
		return legacy(a, nil, false)
	}
	addr, e := daemonAddr()
	if e != nil {
		// An unusable daemon runtime (unsafe ownership or modes, an
		// unwritable dir): the daemon can never live there. Serve the
		// classic path at once — never a hard failure, never a spawn, and
		// never a multi-second timeout.
		trace("daemon_unsafe")
		if len(a) > 1 && a[0] == "daemon" && (a[1] == "stop" || a[1] == "status") {
			if a[1] == "status" {
				fmt.Println("{\"running\":false}")
			}
			return 0
		}
		return legacy(a, nil, false)
	}
	if spawnFailedRecently() {
		// The serve child recently died without listening; skip the spawn
		// and its wait for the marker's lifetime.
		trace("daemon_spawn_backoff")
		return legacy(a, nil, false)
	}
	c, e := daemonDial(addr, 10*time.Millisecond)
	if e != nil {
		if len(a) > 1 && a[0] == "daemon" && (a[1] == "stop" || a[1] == "status") {
			if a[1] == "status" {
				fmt.Println("{\"running\":false}")
			}
			return 0
		}
		exe, _ := os.Executable()
		cmd := exec.Command(exe, "--serve")
		cmd.Env = daemonEnvironment()
		cmd.Stdin = nil
		cmd.Stdout = nil
		cmd.Stderr = nil
		cmd.SysProcAttr = serveSpawnAttr()
		if e = cmd.Start(); e != nil {
			return legacy(a, nil, false)
		}
		waitErr := make(chan error, 1)
		go func() { waitErr <- cmd.Wait() }()
		end := time.Now().Add(5 * time.Second)
		for time.Now().Before(end) {
			c, e = daemonDial(addr, 100*time.Millisecond)
			if e == nil {
				break
			}
			select {
			case we := <-waitErr:
				if we != nil {
					// The serve child exited without ever listening
					// (unusable runtime, missing node): stop waiting out
					// the clock and remember the verdict briefly so the
					// next calls skip the spawn entirely. The reason is
					// printed by the child under PSC_TRACE=1.
					markSpawnFailed()
					trace("daemon_spawn_failed")
					return legacy(a, nil, false)
				}
			default:
			}
			time.Sleep(10 * time.Millisecond)
		}
		if e != nil {
			return legacy(a, nil, false)
		}
	}
	clearSpawnMarker()
	defer c.Close()
	connected := daemonAlive(addr)
	var input []byte
	consumed := false
	tty := stdinIsTTY()
	for i, v := range a {
		tail := []string{}
		if v == "send" && i+2 <= len(a) {
			for _, w := range a[i+2:] {
				if w != "--json" && w != "--enter" && w != "--no-enter" {
					tail = append(tail, w)
				}
			}
		}
		if v == "send" && (len(tail) == 0 || tail[0] == "-") && !tty {
			consumed = true
			input, e = io.ReadAll(io.LimitReader(os.Stdin, maxInput+1))
			if e != nil || len(input) > maxInput {
				relayFailure(a, "USAGE", "stdin exceeds 1 MiB")
				return 2
			}
		}
	}
	idBytes := make([]byte, 16)
	if _, e = rand.Read(idBytes); e != nil {
		relayFailure(a, "INTERNAL", "request identifier unavailable")
		return 1
	}
	id := hex.EncodeToString(idBytes)
	req := request{1, id, namespace(), a, input, tty, time.Now().Add(60 * time.Second).UnixMilli(), false}
	c.SetDeadline(time.Now().Add(65 * time.Second))
	if e = writeFrame(c, req); e != nil {
		relayFailure(a, "OUTCOME_UNKNOWN", "request outcome unknown; not retried")
		return 4
	}
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, os.Interrupt, termSignal())
	defer signal.Stop(sigs)
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-sigs:
			c.Close()
		case <-done:
		}
	}()
	total := 0
	for {
		b, e := readFrame(c)
		if e != nil {
			relayFailure(a, "OUTCOME_UNKNOWN", "request outcome unknown; not retried")
			return 4
		}
		var r response
		if json.Unmarshal(b, &r) != nil || r.Protocol != 1 || r.ID != id {
			relayFailure(a, "OUTCOME_UNKNOWN", "invalid daemon reply; request not retried")
			return 4
		}
		total += len(r.Data)
		if total > maxOutput {
			return 4
		}
		switch r.Kind {
		case "ack":
			trace("ipc")
		case "stdout":
			if _, e = os.Stdout.WriteString(r.Data); e != nil {
				return 0
			}
		case "stderr":
			if _, e = os.Stderr.WriteString(r.Data); e != nil {
				return 0
			}
		case "status":
			if len(a) > 1 && a[0] == "daemon" && a[1] == "stop" && r.Status == 0 {
				deadline := time.Now().Add(5 * time.Second)
				for time.Now().Before(deadline) {
					if daemonGone(addr, connected) {
						return 0
					}
					time.Sleep(5 * time.Millisecond)
				}
				relayFailure(a, "DAEMON_STOP_TIMEOUT", "daemon shutdown did not finish")
				return 4
			}
			if r.Fallback {
				return legacy(a, input, consumed)
			}
			return r.Status
		default:
			return 4
		}
	}
}

// daemonCore is the transport-independent resident core: it owns the Node
// daemon child, the request pump, the idle exit and the per-connection
// framing. `accept` returns only peer-verified connections (peer UID on
// unix, the connection secret on Windows); `stopListener` releases the
// transport listener. Idle exit counts CLIENT requests only: background
// work inside the daemon (P1 pre-warm) never reaches this process.
func daemonCore(accept func() (net.Conn, error), stopListener func()) error {
	daemonJs, e := jsEntry("daemon.mjs", filepath.Join("psc", "dist", "daemon", "main.js"))
	if e != nil {
		return e
	}
	cmd := exec.Command(nodeCommand(), daemonJs)
	cmd.Env = append(daemonEnvironment(), "PSC_DAEMON_NAMESPACE="+namespace())
	in, e := cmd.StdinPipe()
	if e != nil {
		return e
	}
	out, e := cmd.StdoutPipe()
	if e != nil {
		return e
	}
	cmd.Stderr = nil
	if e = cmd.Start(); e != nil {
		return e
	}
	defer func() {
		in.Close()
		terminateProcess(cmd)
	}()
	var mu sync.Mutex
	var writeMu sync.Mutex
	pending := map[string]chan response{}
	shutdown := make(chan struct{})
	var once sync.Once
	stop := func() { once.Do(func() { close(shutdown); stopListener() }) }
	go func() {
		for {
			b, e := readFrame(out)
			if e != nil {
				stop()
				return
			}
			var r response
			if json.Unmarshal(b, &r) != nil {
				stop()
				return
			}
			mu.Lock()
			ch := pending[r.ID]
			mu.Unlock()
			if ch != nil {
				select {
				case ch <- r:
				case <-shutdown:
					return
				}
			}
		}
	}()
	idleAfter := 10 * time.Minute
	if value := os.Getenv("PSC_DAEMON_IDLE_MS"); value != "" {
		ms, err := strconv.Atoi(value)
		if err != nil || ms < 100 || ms > 600000 {
			return errors.New("invalid idle interval")
		}
		idleAfter = time.Duration(ms) * time.Millisecond
	}
	last := time.Now()
	active := 0
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-shutdown:
				return
			case <-t.C:
				mu.Lock()
				idle := active == 0 && time.Since(last) > idleAfter
				mu.Unlock()
				if idle {
					stop()
					return
				}
			}
		}
	}()
	slots := make(chan struct{}, 64)
	for {
		c, e := accept()
		if e != nil {
			return nil
		}
		select {
		case slots <- struct{}{}:
		default:
			c.Close()
			continue
		}
		mu.Lock()
		active++
		mu.Unlock()
		go func(c net.Conn) {
			defer func() {
				c.Close()
				<-slots
				mu.Lock()
				active--
				last = time.Now()
				mu.Unlock()
			}()
			c.SetDeadline(time.Now().Add(65 * time.Second))
			b, e := readFrame(c)
			if e != nil {
				return
			}
			var r request
			if json.Unmarshal(b, &r) != nil || r.Cancel || r.Protocol != 1 || r.Namespace != namespace() || len(r.ID) != 32 || len(r.Args) > 256 || len(r.Input) > maxInput || r.Deadline <= time.Now().UnixMilli() || r.Deadline > time.Now().Add(61*time.Second).UnixMilli() {
				return
			}
			if _, err := hex.DecodeString(r.ID); err != nil {
				return
			}
			if len(r.Args) > 1 && r.Args[0] == "daemon" && r.Args[1] == "stop" {
				writeFrame(c, response{Protocol: 1, ID: r.ID, Kind: "status"})
				stop()
				return
			}
			if writeFrame(c, response{Protocol: 1, ID: r.ID, Kind: "ack"}) != nil {
				return
			}
			ch := make(chan response, 8)
			mu.Lock()
			if pending[r.ID] != nil {
				mu.Unlock()
				return
			}
			pending[r.ID] = ch
			mu.Unlock()
			defer func() { mu.Lock(); delete(pending, r.ID); mu.Unlock() }()
			writeMu.Lock()
			e = writeFrame(in, r)
			writeMu.Unlock()
			if e != nil {
				return
			}
			gone := make(chan struct{})
			go func() { var b [1]byte; c.Read(b[:]); close(gone) }()
			timer := time.NewTimer(time.Until(time.UnixMilli(r.Deadline)))
			defer timer.Stop()
			total := 0
			for {
				select {
				case reply := <-ch:
					total += len(reply.Data)
					if total > maxOutput {
						return
					}
					if writeFrame(c, reply) != nil {
						return
					}
					if reply.Kind == "status" {
						return
					}
				case <-gone:
					writeMu.Lock()
					writeFrame(in, request{Protocol: 1, ID: r.ID, Cancel: true})
					writeMu.Unlock()
					return
				case <-timer.C:
					return
				case <-shutdown:
					return
				}
			}
		}(c)
	}
}

// --- spawn-failure memo -----------------------------------------------------
//
// When the serve child dies without ever listening, the verdict is written
// to a per-OS marker file and honored for a short window, so a broken
// daemon runtime costs at most one failed spawn instead of a spawn plus a
// timeout on every call. A successful dial clears it.

const spawnFailureMemo = 60 * time.Second

// spawnMarkerPath is per-OS: the daemon's own private dir when one can
// exist, else a private temp file.
// markSpawnFailed/spawnFailedRecently/clearSpawnMarker never throw.

func markSpawnFailed() {
	path := spawnMarkerPath()
	if path == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(path), 0700)
	_ = os.WriteFile(path, []byte(fmt.Sprintf("%d\n", time.Now().UnixMilli())), 0600)
}

func spawnFailedRecently() bool {
	path := spawnMarkerPath()
	if path == "" {
		return false
	}
	st, e := os.Lstat(path)
	if e != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0o077 != 0 {
		return false
	}
	return time.Since(st.ModTime()) < spawnFailureMemo
}

func clearSpawnMarker() {
	if path := spawnMarkerPath(); path != "" {
		_ = os.Remove(path)
	}
}

func serve() error {
	accept, stopListener, cleanup, e := listenDaemon()
	if e != nil {
		return e
	}
	if accept == nil {
		return nil
	}
	defer cleanup()
	return daemonCore(accept, stopListener)
}
func main() {
	if runtime.GOOS != "windows" && os.Getuid() != os.Geteuid() {
		os.Exit(1)
	}
	if len(os.Args) == 2 && os.Args[1] == "--serve" {
		if e := serve(); e != nil {
			// The parent relay watches this exit; under PSC_TRACE the one
			// line a human needs (why the daemon cannot start) is printed.
			if os.Getenv("PSC_TRACE") == "1" {
				fmt.Fprintln(os.Stderr, "psc: daemon start failed:", e)
			}
			os.Exit(1)
		}
		return
	}
	trace("client_entry")
	code := relay(os.Args[1:])
	trace("output_exit")
	os.Exit(code)
}
