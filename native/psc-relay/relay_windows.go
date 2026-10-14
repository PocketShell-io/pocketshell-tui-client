//go:build windows

// The Windows daemon transport: a named pipe with an explicit owner-only
// security descriptor, plus a per-connection 256-bit secret that every
// client must present first (compared in constant time). The daemon is
// OPT-IN here (PSC_DAEMON=1): the classic path stays the default until
// this has soaked. The pipe DACL denies every other principal, local or
// remote (named pipes reachable over SMB are still gated by the DACL, and
// the secret is the second factor); Node's default pipe DACL is never
// relied on because the listener is this process, not Node.
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

const secretBytes = 32

func daemonEnabled() bool { return os.Getenv("PSC_DAEMON") == "1" }

func termSignal() os.Signal { return syscall.SIGTERM }

func serveSpawnAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW}
}

func terminateProcess(cmd *exec.Cmd) {
	cmd.Process.Kill()
	done := make(chan struct{})
	go func() { cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
}

func stdinIsTTY() bool {
	var mode uint32
	return windows.GetConsoleMode(windows.Handle(os.Stdin.Fd()), &mode) == nil
}

func signalIgnoreSigpipe() {}

// spawnMarkerPath: the Windows state dir under the user profile.
func spawnMarkerPath() string {
	dir, e := stateDir()
	if e != nil {
		return ""
	}
	return filepath.Join(dir, "psc-daemon-spawn.failed")
}

// currentUserSID is the process token's user SID (S-1-5-…), the identity
// both the pipe DACL and the pipe name are keyed on.
func currentUserSID() (string, error) {
	token, e := windows.OpenCurrentProcessToken()
	if e != nil {
		return "", e
	}
	defer token.Close()
	user, e := token.GetTokenUser()
	if e != nil {
		return "", e
	}
	sid := user.User.Sid.String()
	if sid == "" {
		return "", errors.New("process token has no user SID")
	}
	return sid, nil
}

// pipeServerOwnerSID answers "which user owns the process serving this pipe
// handle". Injectable so tests can simulate a foreign squatter.
var pipeServerOwnerSID = func(handle windows.Handle) (string, error) {
	var serverPID uint32
	if e := windows.GetNamedPipeServerProcessId(handle, &serverPID); e != nil {
		return "", e
	}
	proc, e := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, serverPID)
	if e != nil {
		return "", e
	}
	defer windows.CloseHandle(proc)
	var token windows.Token
	if e := windows.OpenProcessToken(proc, windows.TOKEN_QUERY, &token); e != nil {
		return "", e
	}
	defer token.Close()
	user, e := token.GetTokenUser()
	if e != nil {
		return "", e
	}
	return user.User.Sid.String(), nil
}

// errForeignPipeServer marks a pipe served by another user's process.
var errForeignPipeServer = errors.New("daemon pipe is served by another user")

var warnForeignPipe sync.Once

// verifyPipeServerOwner refuses a pipe whose serving process is not our own
// user: pipe names are derived from the user SID and are therefore
// PREDICTABLE, so another local user can squat \\.\pipe\psc-… and harvest
// the connection secret (and afterwards request payloads) if we talked to
// it. The owner-only DACL protects only a pipe WE created — a squatter's
// pipe has the squatter's DACL. This check runs after DialPipe and BEFORE
// any secret byte is written; on refusal the relay says so once and falls
// back to the classic path.
func verifyPipeServerOwner(c net.Conn) error {
	fd, ok := c.(interface{ Fd() uintptr })
	if !ok {
		return errors.New("pipe handle unavailable")
	}
	owner, e := pipeServerOwnerSID(windows.Handle(fd.Fd()))
	if e != nil {
		return e
	}
	mine, e := currentUserSID()
	if e != nil || owner != mine {
		warnForeignPipe.Do(func() {
			fmt.Fprintln(os.Stderr, "psc: the daemon pipe is served by another user; using the classic path")
		})
		return errForeignPipeServer
	}
	return nil
}

// userStableId is the SID, else the username + profile path the spec
// allows as a stand-in.
func userStableId() string {
	if sid, e := currentUserSID(); e == nil && sid != "" {
		return sid
	}
	return os.Getenv("USERNAME") + "|" + os.Getenv("USERPROFILE")
}

func stateDir() (string, error) {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		return "", errors.New("LOCALAPPDATA unset")
	}
	// The directory inherits the profile ACL: this user, and nobody else.
	dir := filepath.Join(base, "PocketShell")
	if e := os.MkdirAll(dir, 0700); e != nil {
		return "", e
	}
	return dir, nil
}

type pipeEndpoint struct {
	name   string
	secret string
}

// daemonAddr is the namespace-scoped pipe name.
func daemonAddr() (string, error) {
	ep, e := resolvePipe()
	if e != nil {
		return "", e
	}
	return ep.name, nil
}

// resolvePipe derives the namespace-scoped pipe name and its secret file.
func resolvePipe() (pipeEndpoint, error) {
	dir, e := stateDir()
	if e != nil {
		return pipeEndpoint{}, e
	}
	sum := sha256.Sum256([]byte(userStableId() + "\x00" + namespace()))
	digest := hex.EncodeToString(sum[:])
	return pipeEndpoint{
		name:   `\\.\pipe\psc-` + digest[:32],
		secret: filepath.Join(dir, "psc-daemon-"+digest[:16]+".secret"),
	}, nil
}

func readSecretFile(path string) ([]byte, error) {
	b, e := os.ReadFile(path)
	if e != nil || len(b) != secretBytes {
		return nil, errors.New("unreadable daemon secret")
	}
	return b, nil
}

// createSecretExcl writes a fresh secret under exclusive creation.
func createSecretExcl(path string) ([]byte, error) {
	secret := make([]byte, secretBytes)
	if _, e := rand.Read(secret); e != nil {
		return nil, e
	}
	f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return nil, e
	}
	if _, e := f.Write(secret); e != nil {
		f.Close()
		os.Remove(path)
		return nil, e
	}
	return secret, f.Close()
}

// daemonDial connects to the pipe, verifies its SERVER is a process of our
// own user (pipe squatting: the name is SID-derived and predictable), and
// only then presents the connection secret.
func daemonDial(name string, timeout time.Duration) (net.Conn, error) {
	ep, e := resolvePipe()
	if e != nil {
		return nil, e
	}
	secret, e := readSecretFile(ep.secret)
	if e != nil {
		return nil, e
	}
	t := timeout
	c, e := winio.DialPipe(ep.name, &t)
	if e != nil {
		return nil, e
	}
	if e := verifyPipeServerOwner(c); e != nil {
		c.Close()
		return nil, e
	}
	if e := c.SetDeadline(time.Now().Add(2 * time.Second)); e != nil {
		c.Close()
		return nil, e
	}
	if _, e := c.Write(secret); e != nil {
		c.Close()
		return nil, e
	}
	if e := c.SetDeadline(time.Time{}); e != nil {
		c.Close()
		return nil, e
	}
	return c, nil
}

// daemonAlive snapshots the secret file identity for stop confirmation: a
// replaced secret means a different daemon generation owns the pipe.
func daemonAlive(name string) any {
	ep, e := resolvePipe()
	if e != nil {
		return nil
	}
	st, e := os.Stat(ep.secret)
	if e != nil {
		return nil
	}
	return st
}

func daemonGone(name string, snapshot any) bool {
	if snapshot == nil {
		return true
	}
	ep, e := resolvePipe()
	if e != nil {
		return true
	}
	current, err := os.Stat(ep.secret)
	if os.IsNotExist(err) {
		return true
	}
	if err != nil {
		return false
	}
	want := snapshot.(os.FileInfo)
	return !current.ModTime().Equal(want.ModTime()) || current.Size() != want.Size()
}

func pipeAnswers(ep pipeEndpoint, wait time.Duration) bool {
	end := time.Now().Add(wait)
	for time.Now().Before(end) {
		if c, e := daemonDial(ep.name, 100*time.Millisecond); e == nil {
			c.Close()
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// listenDaemon owns the pipe exclusively: after proving the pipe is not
// answering, the secret file is created EXCLUSIVELY, so exactly one serve
// process survives a start race (losers exit silently once the winner's
// pipe answers). A nil accept means the daemon is already running.
func listenDaemon() (func() (net.Conn, error), func(), func(), error) {
	ep, e := resolvePipe()
	if e != nil {
		return nil, nil, nil, e
	}
	if pipeAnswers(ep, 0) {
		return nil, nil, nil, nil
	}
	secret, e := createSecretExcl(ep.secret)
	if e != nil && !os.IsExist(e) {
		return nil, nil, nil, e
	}
	if os.IsExist(e) {
		// Either a racer is mid-start or the file is stale from a dead daemon.
		if pipeAnswers(ep, 2*time.Second) {
			return nil, nil, nil, nil
		}
		os.Remove(ep.secret)
		secret, e = createSecretExcl(ep.secret)
		if e != nil {
			// A racer won the replacement; it owns the pipe.
			return nil, nil, nil, nil
		}
	}
	sid, e := currentUserSID()
	if e != nil || sid == "" {
		os.Remove(ep.secret)
		return nil, nil, nil, errors.New("daemon pipe requires a user SID")
	}
	// go-winio's ListenPipe creates its first instance with FILE_CREATE
	// disposition ("The pipe must not already exist", pipe.go makeServerPipeHandle
	// first=true) — the NT form of FILE_FLAG_FIRST_PIPE_INSTANCE: a squatter's
	// pre-existing pipe of the same name makes this call FAIL, so our daemon
	// never coexists with (or answers behind) a foreign listener. The
	// behavior is pinned by TestListenerRefusesToCoexistWithSquatter.
	listener, e := winio.ListenPipe(ep.name, &winio.PipeConfig{
		// Owner-only: no other local or remote principal may open the pipe.
		SecurityDescriptor: "D:P(A;;GA;;;" + sid + ")",
		MessageMode:        false,
		InputBufferSize:    1 << 20,
		OutputBufferSize:   1 << 20,
	})
	if e != nil {
		os.Remove(ep.secret)
		return nil, nil, nil, e
	}
	var once sync.Once
	stop := func() { once.Do(func() { listener.Close() }) }
	accept := func() (net.Conn, error) {
		for {
			c, e := listener.Accept()
			if e != nil {
				return nil, e
			}
			if e := c.SetReadDeadline(time.Now().Add(2 * time.Second)); e != nil {
				c.Close()
				continue
			}
			presented := make([]byte, secretBytes)
			_, e = io.ReadFull(c, presented)
			if e != nil || subtle.ConstantTimeCompare(presented, secret) != 1 {
				c.Close()
				continue
			}
			if e := c.SetDeadline(time.Time{}); e != nil {
				c.Close()
				continue
			}
			return c, nil
		}
	}
	// Removing the secret both confirms `daemon stop` (the stop watcher sees
	// the file go) and leaves no stale secret for the next start to clear.
	cleanup := func() {
		stop()
		os.Remove(ep.secret)
	}
	return accept, stop, cleanup, nil
}
