//go:build linux

package main

import (
	"golang.org/x/sys/unix"
	"net"
)

func peerUID(c *net.UnixConn) (uint32, error) {
	raw, e := c.SyscallConn()
	if e != nil {
		return 0, e
	}
	var uid uint32
	var err error
	e = raw.Control(func(fd uintptr) {
		var p *unix.Ucred
		p, err = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		if err == nil {
			uid = p.Uid
		}
	})
	if e != nil {
		return 0, e
	}
	return uid, err
}
