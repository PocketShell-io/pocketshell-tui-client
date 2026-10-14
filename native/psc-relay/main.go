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
	"golang.org/x/sys/unix"
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
	"syscall"
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
func namespace() string {
	h := sha256.Sum256([]byte(strings.Join([]string{os.Getenv("HOME"), os.Getenv("XDG_CONFIG_HOME"), os.Getenv("POCKETSHELL_BROKER_URL"), os.Getenv("PSC_RPC_BINARY"), os.Getenv("PSC_JSON"), os.Getenv("PSC_DAEMON_IDLE_MS"), os.Getenv("PSC_HOST")}, "\x00")))
	return hex.EncodeToString(h[:8])
}
func checkComponents(path string) error {
	path = filepath.Clean(path)
	if !filepath.IsAbs(path) {
		return errors.New("absolute runtime path required")
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	p := "/"
	for _, s := range parts {
		p = filepath.Join(p, s)
		st, e := os.Lstat(p)
		if e != nil {
			return e
		}
		if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return errors.New("runtime symlink/non-directory")
		}
		sys := st.Sys().(*syscall.Stat_t)
		if sys.Uid != 0 && int(sys.Uid) != os.Geteuid() {
			return errors.New("foreign runtime parent")
		}
		if st.Mode().Perm()&0022 != 0 && !(sys.Uid == 0 && st.Mode()&os.ModeSticky != 0) {
			return errors.New("writable runtime parent")
		}
	}
	return nil
}
func runtimePath() (string, error) {
	base := os.Getenv("XDG_RUNTIME_DIR")
	if base == "" {
		base = "/tmp"
		if runtime.GOOS == "darwin" {
			base = "/private/tmp"
		}
	}
	if e := checkComponents(base); e != nil {
		return "", e
	}
	p := filepath.Join(base, fmt.Sprintf("psc-daemon-%d", os.Geteuid()))
	e := os.Mkdir(p, 0700)
	if e != nil && !os.IsExist(e) {
		return "", e
	}
	st, e := os.Lstat(p)
	if e != nil {
		return "", e
	}
	if !st.IsDir() || st.Mode().Perm() != 0700 || int(st.Sys().(*syscall.Stat_t).Uid) != os.Geteuid() {
		return "", errors.New("unsafe runtime directory")
	}
	return filepath.Join(p, namespace()+".sock"), nil
}
func sameUser(uid uint32, err error) bool { return err == nil && int(uid) == os.Geteuid() }
func connect(path string) (*net.UnixConn, error) {
	st, e := os.Lstat(path)
	if e != nil {
		return nil, e
	}
	if st.Mode()&os.ModeSocket == 0 || st.Mode().Perm() != 0600 || int(st.Sys().(*syscall.Stat_t).Uid) != os.Geteuid() {
		return nil, errors.New("unsafe socket")
	}
	raw, e := (&net.Dialer{Timeout: 10 * time.Millisecond}).Dial("unix", path)
	var c *net.UnixConn
	if e == nil {
		c = raw.(*net.UnixConn)
	}
	if e != nil {
		return nil, e
	}
	uid, e := peerUID(c)
	if !sameUser(uid, e) {
		c.Close()
		return nil, errors.New("foreign daemon peer")
	}
	return c, nil
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
	if len(b) > 0 && b[0] == "a" {
		b = b[1:]
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
func legacy(a []string, input []byte, consumed bool) int {
	cmd := exec.Command("node", append([]string{entry("psc.mjs")}, a...)...)
	if consumed {
		cmd.Stdin = strings.NewReader(string(input))
	} else {
		cmd.Stdin = os.Stdin
	}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	e := cmd.Run()
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
	if os.Getenv("PSC_DAEMON") != "1" && !(len(a) > 0 && a[0] == "daemon") || !eligible(a) {
		return legacy(a, nil, false)
	}
	path, e := runtimePath()
	if e != nil {
		relayFailure(a, "DAEMON_UNSAFE", "unsafe daemon runtime")
		return 1
	}
	c, e := connect(path)
	if e != nil {
		if len(a) > 1 && a[0] == "daemon" && (a[1] == "stop" || a[1] == "status") {
			if a[1] == "status" {
				fmt.Println("{\"running\":false}")
			}
			return 0
		}
		exe, _ := os.Executable()
		cmd := exec.Command(exe, "--serve")
		cmd.Stdin = nil
		cmd.Stdout = nil
		cmd.Stderr = nil
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if e = cmd.Start(); e != nil {
			return legacy(a, nil, false)
		}
		go cmd.Wait()
		end := time.Now().Add(5 * time.Second)
		for time.Now().Before(end) {
			c, e = connect(path)
			if e == nil {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if e != nil {
			return legacy(a, nil, false)
		}
	}
	defer c.Close()
	connectedSocket, _ := os.Lstat(path)
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
	signal.Notify(sigs, os.Interrupt, unix.SIGTERM)
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
					current, err := os.Lstat(path)
					if os.IsNotExist(err) || err == nil && connectedSocket != nil && !os.SameFile(current, connectedSocket) {
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
func serve() error {
	path, e := runtimePath()
	if e != nil {
		return e
	}
	lock, e := os.OpenFile(strings.TrimSuffix(path, ".sock")+".lock", os.O_CREATE|os.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0600)
	if e != nil {
		return e
	}
	defer lock.Close()
	st, e := lock.Stat()
	if e != nil || !st.Mode().IsRegular() || st.Mode().Perm() != 0600 || int(st.Sys().(*syscall.Stat_t).Uid) != os.Geteuid() {
		return errors.New("unsafe lock")
	}
	if unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB) != nil {
		return nil
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	if c, e := connect(path); e == nil {
		c.Close()
		return nil
	}
	if st, e := os.Lstat(path); e == nil {
		if live, err := (&net.Dialer{Timeout: 100 * time.Millisecond}).Dial("unix", path); err == nil {
			live.Close()
			return errors.New("refusing live socket")
		} else if !errors.Is(err, unix.ECONNREFUSED) && !errors.Is(err, os.ErrNotExist) {
			return errors.New("socket liveness unknown")
		}
		current, err := os.Lstat(path)
		if err != nil || !os.SameFile(current, st) {
			return errors.New("socket changed while checking")
		}
		if st.Mode()&os.ModeSocket == 0 || int(st.Sys().(*syscall.Stat_t).Uid) != os.Geteuid() {
			return errors.New("unsafe stale socket")
		}
		if e = os.Remove(path); e != nil {
			return e
		}
	}
	listener, e := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if e != nil {
		return e
	}
	listener.SetUnlinkOnClose(false)
	defer listener.Close()
	if e = os.Chmod(path, 0600); e != nil {
		return e
	}
	boundSocket, e := os.Lstat(path)
	if e != nil {
		return e
	}
	defer func() {
		current, err := os.Lstat(path)
		if err == nil && os.SameFile(current, boundSocket) {
			os.Remove(path)
		}
	}()
	cmd := exec.Command("node", entry("daemon.mjs"))
	cmd.Env = append(os.Environ(), "PSC_DAEMON_NAMESPACE="+namespace())
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
		cmd.Process.Signal(unix.SIGTERM)
		done := make(chan struct{})
		go func() { cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			cmd.Process.Kill()
			<-done
		}
	}()
	var mu sync.Mutex
	var writeMu sync.Mutex
	pending := map[string]chan response{}
	shutdown := make(chan struct{})
	var once sync.Once
	stop := func() { once.Do(func() { close(shutdown); listener.Close() }) }
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
		c, e := listener.AcceptUnix()
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
		go func(c *net.UnixConn) {
			defer func() {
				c.Close()
				<-slots
				mu.Lock()
				active--
				last = time.Now()
				mu.Unlock()
			}()
			uid, e := peerUID(c)
			if !sameUser(uid, e) {
				return
			}
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
func main() {
	if os.Getuid() != os.Geteuid() {
		os.Exit(1)
	}
	signal.Ignore(unix.SIGPIPE)
	if len(os.Args) == 2 && os.Args[1] == "--serve" {
		if e := serve(); e != nil {
			os.Exit(1)
		}
		return
	}
	trace("client_entry")
	code := relay(os.Args[1:])
	trace("output_exit")
	os.Exit(code)
}
