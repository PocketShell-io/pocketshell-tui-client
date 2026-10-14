//go:build unix

// The unix daemon transport: a peer-UID-checked unix socket in a private
// runtime directory. The resident daemon is the DEFAULT on unix; an
// explicit PSC_DAEMON=0 opts out, and every daemon failure falls back
// transparently to the classic entry.
package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

func init() {
	signalIgnoreSigpipe()
}

func daemonEnabled() bool { return os.Getenv("PSC_DAEMON") != "0" }

func termSignal() os.Signal { return syscall.SIGTERM }

func serveSpawnAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }

func terminateProcess(cmd *exec.Cmd) {
	cmd.Process.Signal(unix.SIGTERM)
	done := make(chan struct{})
	go func() { cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		cmd.Process.Kill()
		<-done
	}
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

// daemonAddr is the unix socket path (DAEMON_UNSAFE refusal included).
func daemonAddr() (string, error) { return runtimePath() }

// daemonDial connects to the socket and verifies the peer is our own uid.
func daemonDial(path string, timeout time.Duration) (net.Conn, error) {
	st, e := os.Lstat(path)
	if e != nil {
		return nil, e
	}
	if st.Mode()&os.ModeSocket == 0 || st.Mode().Perm() != 0600 || int(st.Sys().(*syscall.Stat_t).Uid) != os.Geteuid() {
		return nil, errors.New("unsafe socket")
	}
	raw, e := (&net.Dialer{Timeout: timeout}).Dial("unix", path)
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

// daemonAlive snapshots the socket identity for `daemon stop` confirmation.
func daemonAlive(path string) any {
	st, e := os.Lstat(path)
	if e != nil {
		return nil
	}
	return st
}

func daemonGone(path string, snapshot any) bool {
	if snapshot == nil {
		return true
	}
	current, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return true
	}
	return err == nil && !os.SameFile(current, snapshot.(os.FileInfo))
}

// listenDaemon owns the socket exclusively: a lock file held under flock,
// stale-socket cleanup, then the 0600 listener. A nil accept means another
// daemon already owns this endpoint.
func listenDaemon() (func() (net.Conn, error), func(), func(), error) {
	path, e := runtimePath()
	if e != nil {
		return nil, nil, nil, e
	}
	lock, e := os.OpenFile(strings.TrimSuffix(path, ".sock")+".lock", os.O_CREATE|os.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0600)
	if e != nil {
		return nil, nil, nil, e
	}
	st, e := lock.Stat()
	if e != nil || !st.Mode().IsRegular() || st.Mode().Perm() != 0600 || int(st.Sys().(*syscall.Stat_t).Uid) != os.Geteuid() {
		lock.Close()
		return nil, nil, nil, errors.New("unsafe lock")
	}
	if unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB) != nil {
		lock.Close()
		return nil, nil, nil, nil
	}
	cleanup := func() {
		unix.Flock(int(lock.Fd()), unix.LOCK_UN)
		lock.Close()
	}
	if c, e := daemonDial(path, 10*time.Millisecond); e == nil {
		c.Close()
		cleanup()
		return nil, nil, nil, nil
	}
	if st, e := os.Lstat(path); e == nil {
		if live, err := (&net.Dialer{Timeout: 100 * time.Millisecond}).Dial("unix", path); err == nil {
			live.Close()
			cleanup()
			return nil, nil, nil, errors.New("refusing live socket")
		} else if !errors.Is(err, unix.ECONNREFUSED) && !errors.Is(err, os.ErrNotExist) {
			cleanup()
			return nil, nil, nil, errors.New("socket liveness unknown")
		}
		current, err := os.Lstat(path)
		if err != nil || !os.SameFile(current, st) {
			cleanup()
			return nil, nil, nil, errors.New("socket changed while checking")
		}
		if st.Mode()&os.ModeSocket == 0 || int(st.Sys().(*syscall.Stat_t).Uid) != os.Geteuid() {
			cleanup()
			return nil, nil, nil, errors.New("unsafe stale socket")
		}
		if e = os.Remove(path); e != nil {
			cleanup()
			return nil, nil, nil, e
		}
	}
	listener, e := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if e != nil {
		cleanup()
		return nil, nil, nil, e
	}
	listener.SetUnlinkOnClose(false)
	if e = os.Chmod(path, 0600); e != nil {
		listener.Close()
		cleanup()
		return nil, nil, nil, e
	}
	boundSocket, e := os.Lstat(path)
	if e != nil {
		listener.Close()
		cleanup()
		return nil, nil, nil, e
	}
	cleanupSocket := func() {
		listener.Close()
		if current, err := os.Lstat(path); err == nil && os.SameFile(current, boundSocket) {
			os.Remove(path)
		}
		cleanup()
	}
	var once sync.Once
	stop := func() { once.Do(func() { listener.Close() }) }
	accept := func() (net.Conn, error) {
		for {
			c, e := listener.AcceptUnix()
			if e != nil {
				return nil, e
			}
			uid, pe := peerUID(c)
			if sameUser(uid, pe) {
				return c, nil
			}
			c.Close()
		}
	}
	return accept, stop, cleanupSocket, nil
}

func signalIgnoreSigpipe() { signal.Ignore(unix.SIGPIPE) }
