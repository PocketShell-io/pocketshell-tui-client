package main

import (
	"bytes"
	"encoding/binary"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestFrames(t *testing.T) {
	var b bytes.Buffer
	if e := writeFrame(&b, map[string]string{"payload": "hello"}); e != nil {
		t.Fatal(e)
	}
	v, e := readFrame(&b)
	if e != nil || !bytes.Contains(v, []byte("hello")) {
		t.Fatal(e)
	}
	for _, n := range []uint32{0, maxFrame + 1} {
		var h [4]byte
		binary.BigEndian.PutUint32(h[:], n)
		if _, e = readFrame(bytes.NewReader(h[:])); e == nil {
			t.Fatal("oversize/empty accepted")
		}
	}
	if _, e = readFrame(bytes.NewReader([]byte{0, 0, 0, 5, 1})); e == nil {
		t.Fatal("truncated accepted")
	}
}
func TestRuntimeRefusesSymlinksAndModes(t *testing.T) {
	base := t.TempDir()
	os.Chmod(base, 0700)
	t.Setenv("XDG_RUNTIME_DIR", base)
	p, e := runtimePath()
	if e != nil {
		t.Fatal(e)
	}
	os.Chmod(filepath.Dir(p), 0755)
	if _, e = runtimePath(); e == nil {
		t.Fatal("loose directory accepted")
	}
	os.Chmod(filepath.Dir(p), 0700)
	link := filepath.Join(base, "linked")
	os.Symlink(filepath.Dir(p), link)
	t.Setenv("XDG_RUNTIME_DIR", link)
	if _, e = runtimePath(); e == nil {
		t.Fatal("symlink accepted")
	}
}
func TestPeerAndSocket(t *testing.T) {
	base := t.TempDir()
	os.Chmod(base, 0700)
	t.Setenv("XDG_RUNTIME_DIR", base)
	p, e := runtimePath()
	if e != nil {
		t.Fatal(e)
	}
	listener, e := net.ListenUnix("unix", &net.UnixAddr{Name: p, Net: "unix"})
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	os.Chmod(p, 0600)
	done := make(chan error, 1)
	go func() {
		c, e := listener.AcceptUnix()
		if e == nil {
			defer c.Close()
			uid, err := peerUID(c)
			if err != nil || int(uid) != os.Geteuid() {
				t.Error("peer mismatch")
			}
		}
		done <- e
	}()
	c, e := connect(p)
	if e != nil {
		t.Fatal(e)
	}
	c.Close()
	if e = <-done; e != nil {
		t.Fatal(e)
	}
	os.Chmod(p, 0666)
	if c, e = connect(p); e == nil {
		c.Close()
		t.Fatal("loose socket accepted")
	}
}
func TestEligibility(t *testing.T) {
	for _, a := range [][]string{{"box", "send", "id", "text"}, {"--json", "box", "ls"}, {"daemon", "noop"}} {
		if !eligible(a) {
			t.Fatal(a)
		}
	}
	for _, a := range [][]string{nil, {"box", "connect"}, {"box", "start", "x"}, {"gateway", "proxy", "id"}, {"box", "send", "--help"}} {
		if eligible(a) {
			t.Fatal(a)
		}
	}
}

func TestForeignUID(t *testing.T) {
	if sameUser(uint32(os.Geteuid()+1), nil) {
		t.Fatal("foreign UID accepted")
	}
	if !sameUser(uint32(os.Geteuid()), nil) {
		t.Fatal("owner refused")
	}
}
