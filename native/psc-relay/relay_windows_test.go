//go:build windows

// The named-pipe daemon boundary: owner-scoped pipe naming, exclusive
// secret creation, and the constant-time connection secret handshake.
// These run on the Windows runner only (the transport itself is Windows).
package main

import (
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
)

func TestPipeEndpointIsStableAndNamespaced(t *testing.T) {
	a, e := resolvePipe()
	if e != nil {
		t.Fatal(e)
	}
	b, e := resolvePipe()
	if e != nil {
		t.Fatal(e)
	}
	if a.name == "" || a.secret == "" || a.name != b.name || a.secret != b.secret {
		t.Fatal("pipe endpoint is not stable")
	}
	if filepath.Base(a.secret) == "psc-daemon.secret" {
		t.Fatal("secret file must be namespace-scoped, not shared across daemons")
	}
	addr, e := daemonAddr()
	if e != nil || addr != a.name {
		t.Fatal("daemonAddr does not match the resolved pipe")
	}
}

func TestSecretCreateReadAndExclusiveCreate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "psc-daemon-test.secret")
	secret, e := createSecretExcl(path)
	if e != nil || len(secret) != secretBytes {
		t.Fatal(e)
	}
	if _, e := createSecretExcl(path); !os.IsExist(e) {
		t.Fatal("exclusive creation allowed a second writer")
	}
	got, e := readSecretFile(path)
	if e != nil || string(got) != string(secret) {
		t.Fatal(e)
	}
	os.Remove(path)
	if _, e := readSecretFile(path); e == nil {
		t.Fatal("missing secret accepted")
	}
}

func TestListenDialSecretHandshake(t *testing.T) {
	os.Setenv("LOCALAPPDATA", t.TempDir())
	defer os.Unsetenv("LOCALAPPDATA")
	accept, stop, cleanup, e := listenDaemon()
	if e != nil {
		t.Fatal(e)
	}
	if accept == nil {
		t.Fatal("listener refused to own a fresh pipe")
	}
	defer cleanup()
	done := make(chan net.Conn, 1)
	go func() {
		c, e := accept()
		if e != nil {
			stop()
			close(done)
			return
		}
		done <- c
	}()
	ep, e := resolvePipe()
	if e != nil {
		t.Fatal(e)
	}
	// A correct secret is accepted; a wrong one is dropped.
	secret, e := readSecretFile(ep.secret)
	if e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(ep.secret); e != nil {
		t.Fatal(e)
	}
	c, e := daemonDial(ep.name, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	accepted := <-done
	if accepted == nil {
		t.Fatal("daemon dropped a correct secret")
	}
	accepted.Close()
	c.Close()
	// Corrupt the presented secret: the daemon must close the connection.
	presented := make([]byte, secretBytes)
	copy(presented, secret)
	presented[0] ^= 0xff
	bad, e := dialWithSecret(ep.name, presented)
	if e != nil {
		t.Fatal(e)
	}
	defer bad.Close()
	if _, e := bad.Write([]byte("{}")); e == nil {
		// The write may succeed locally before the daemon reacts; give it a
		// moment, then the read side must be closed.
		bad.SetReadDeadline(time.Now().Add(2 * time.Second))
		var b [1]byte
		if _, e := bad.Read(b[:]); e == nil {
			t.Fatal("daemon served a connection with a wrong secret")
		}
	}
	stop()
}

func dialWithSecret(name string, secret []byte) (net.Conn, error) {
	timeout := time.Second
	c, e := winio.DialPipe(name, &timeout)
	if e != nil {
		return nil, e
	}
	if _, e := c.Write(secret); e != nil {
		c.Close()
		return nil, e
	}
	return c, nil
}

// A second daemon must not steal a pipe that is already answering.
func TestListenDaemonYieldsToLivePipe(t *testing.T) {
	os.Setenv("LOCALAPPDATA", t.TempDir())
	defer os.Unsetenv("LOCALAPPDATA")
	accept, stop, cleanup, e := listenDaemon()
	if e != nil || accept == nil {
		t.Fatal(e)
	}
	defer cleanup()
	done := make(chan struct{})
	go func() {
		accept()
		close(done)
	}()
	accept2, _, cleanup2, e := listenDaemon()
	if e != nil {
		t.Fatal(e)
	}
	if accept2 != nil {
		cleanup2()
		t.Fatal("second daemon did not yield to the live one")
	}
	stop()
	<-done
}

func TestSecretIsRandom(t *testing.T) {
	dir := t.TempDir()
	a, e := createSecretExcl(filepath.Join(dir, "a.secret"))
	if e != nil {
		t.Fatal(e)
	}
	b, e := createSecretExcl(filepath.Join(dir, "b.secret"))
	if e != nil {
		t.Fatal(e)
	}
	same := true
	for i := range a {
		if a[i] != b[i] {
			same = false
		}
	}
	if same {
		t.Fatal("secrets are not random")
	}
}
