//go:build darwin

package main

import (
	"golang.org/x/sys/unix"
	"net"
	"os"
)

func peerUID(c *net.UnixConn) (uint32, error) {
	raw, e := c.SyscallConn()
	if e != nil {
		return 0, e
	}
	var uid uint32
	var err error
	e = raw.Control(func(fd uintptr) {
		var p *unix.Xucred
		p, err = unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		if err == nil {
			uid = p.Uid
		}
	})
	if e != nil {
		return 0, e
	}
	return uid, err
}

func stdinIsTTY() bool {
	_, err := unix.IoctlGetTermios(int(os.Stdin.Fd()), unix.TIOCGETA)
	return err == nil
}
