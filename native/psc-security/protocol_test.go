package main

import (
	"strings"
	"testing"
)

func TestClosedProtocol(t *testing.T) {
	good := []string{`{"version":1,"op":"preflight","root":"C:/owned/config"}`, `{"version":1,"op":"read","root":"C:/owned/config","kind":"credentials"}`, `{"version":1,"op":"write","root":"C:/owned/config","kind":"pins","data":"ZmFrZQ=="}`}
	for _, s := range good {
		if _, e := decode(strings.NewReader(s)); e != nil {
			t.Fatal(e)
		}
	}
	bad := []string{`{"version":1,"version":1,"op":"preflight","root":"C:/owned"}`, `{"version":1,"Op":"preflight","root":"C:/owned"}`, `{"version":1,"op":"shell","root":"C:/owned"}`, `{"version":1,"op":"preflight","root":"C:relative"}`, `{"version":1,"op":"preflight","root":"//network/share"}`, `{"version":1,"op":"read","root":"C:/owned","kind":"arbitrary"}`, `{"version":1,"op":"read","root":"C:/owned","kind":"pins","name":"../escape"}`, `{"version":1,"op":"write","root":"C:/owned","kind":"credentials","data":"!?"}`, `{"version":1,"op":"preflight","root":"C:/owned","data":"secret"}`}
	for _, s := range bad {
		if _, e := decode(strings.NewReader(s)); e == nil {
			t.Fatalf("accepted %s", s)
		}
	}
}
func TestNativePaths(t *testing.T) {
	for _, p := range []string{`C:relative`, `\rooted`, `C:/x/../y`, `C:/x:stream`, `C:/x.`, `C:/x `, `C:/x?`, `C:/x` + string(rune(0))} {
		if validPath(p) {
			t.Fatalf("accepted %q", p)
		}
	}
}
func TestStatusFixedNames(t *testing.T) {
	if _, _, e := fileName(Request{Kind: "status", Name: "st-0123456789abcdef01234567"}); e != nil {
		t.Fatal(e)
	}
	for _, n := range []string{"st-1", "../st-0123456789abcdef01234567", "st-0123456789abcdef01234567.tmp"} {
		if _, _, e := fileName(Request{Kind: "status", Name: n}); e == nil {
			t.Fatal(n)
		}
	}
}
