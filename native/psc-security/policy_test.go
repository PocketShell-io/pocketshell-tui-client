package main

import "testing"

func TestOpenedHandleACLPolicy(t *testing.T) {
	good := []aceFact{{current: true}, {system: true}}
	if descriptorPolicy(true, true, true, true, good) != nil {
		t.Fatal("private current-user/SYSTEM refused")
	}
	cases := []struct {
		name             string
		owner, protected bool
		a                []aceFact
	}{
		{"foreign owner", false, true, good}, {"inherited directory", true, false, good}, {"null DACL", true, true, nil},
		{"broad read", true, true, append(append([]aceFact{}, good...), aceFact{mask: 1})}, {"admin grant private", true, true, []aceFact{{trusted: true}}},
		{"inherited ACE", true, true, []aceFact{{current: true, flags: 16}}}, {"callback ACE", true, true, []aceFact{{current: true, kind: 9}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if descriptorPolicy(true, c.owner, c.protected, true, c.a) == nil {
				t.Fatal("unsafe native ACL admitted")
			}
		})
	}
	if descriptorPolicy(true, false, false, false, []aceFact{{trusted: true, mask: dangerousAncestorRights}, {mask: 1}}) != nil {
		t.Fatal("trusted ancestors/read grants refused")
	}
	if descriptorPolicy(true, false, false, false, []aceFact{{mask: 0x40}}) == nil {
		t.Fatal("untrusted delete-child ancestor admitted")
	}
}
func TestOpenedHandleObjectPolicy(t *testing.T) {
	if filePolicy(false, false, false, 1, true) != nil {
		t.Fatal("regular disk file refused")
	}
	for _, x := range []struct {
		r, d, w bool
		l       uint32
		disk    bool
	}{{true, false, false, 1, true}, {false, true, false, 1, true}, {false, false, false, 2, true}, {false, false, false, 1, false}} {
		if filePolicy(x.r, x.d, x.w, x.l, x.disk) == nil {
			t.Fatal("unsafe opened object admitted")
		}
	}
}
