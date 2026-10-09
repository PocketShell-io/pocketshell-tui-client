//go:build windows

package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"golang.org/x/sys/windows"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unsafe"
)

func userSID() (*windows.SID, error) {
	t, e := windows.OpenCurrentProcessToken()
	if e != nil {
		return nil, e
	}
	defer t.Close()
	u, e := t.GetTokenUser()
	if e != nil {
		return nil, e
	}
	return u.User.Sid.Copy()
}
func trusted(s, u *windows.SID) bool {
	if s == nil {
		return false
	}
	if windows.EqualSid(s, u) || s.IsWellKnown(windows.WinLocalSystemSid) || s.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		return true
	}
	ti, _, _, e := windows.LookupSID("", "NT SERVICE\\TrustedInstaller")
	return e == nil && windows.EqualSid(s, ti)
}
func security(h windows.Handle, private bool) error {
	u, e := userSID()
	if e != nil {
		return e
	}
	sd, e := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if e != nil {
		return e
	}
	owner, _, e := sd.Owner()
	if e != nil {
		return refused
	}
	ctrl, _, e := sd.Control()
	if e != nil {
		return refused
	}
	acl, _, e := sd.DACL()
	if e != nil || acl == nil {
		return refused
	}
	var facts []aceFact
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var a *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, i, &a) != nil {
			return refused
		}
		f := aceFact{kind: a.Header.AceType, flags: a.Header.AceFlags, mask: uint32(a.Mask)}
		if a.Header.AceType == windows.ACCESS_ALLOWED_ACE_TYPE {
			sid := (*windows.SID)(unsafe.Pointer(&a.SidStart))
			f.current = windows.EqualSid(sid, u)
			f.system = sid.IsWellKnown(windows.WinLocalSystemSid)
			f.trusted = trusted(sid, u)
		}
		facts = append(facts, f)
	}
	return descriptorPolicy(trusted(owner, u), windows.EqualSid(owner, u), ctrl&windows.SE_DACL_PROTECTED != 0, private, facts)
}
func attributes(h windows.Handle, directory bool) error {
	var i windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(h, &i) != nil {
		return refused
	}
	typ, e := windows.GetFileType(h)
	if e != nil {
		return refused
	}
	return filePolicy(i.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0, i.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0, directory, i.NumberOfLinks, typ == windows.FILE_TYPE_DISK)
}
func descriptor() (*windows.SECURITY_DESCRIPTOR, error) {
	u, e := userSID()
	if e != nil {
		return nil, e
	}
	return windows.SecurityDescriptorFromString("O:" + u.String() + "D:P(A;;FA;;;" + u.String() + ")(A;;FA;;;SY)")
}
func ptr(p string) *uint16 { v, _ := windows.UTF16PtrFromString(p); return v }

// Every existing ancestor is held without FILE_SHARE_DELETE, preventing its
// rename/replacement while final-name Win32 calls occur in the verified tree.
func holdDirs(path string, createFinal bool, strictFinal bool) ([]windows.Handle, error) {
	if !validPath(path) {
		return nil, refused
	}
	path = filepath.Clean(path)
	vol := filepath.VolumeName(path)
	if len(vol) != 2 || windows.GetDriveType(ptr(vol+"\\")) != windows.DRIVE_FIXED {
		return nil, refused
	}
	var held []windows.Handle
	fail := func(e error) ([]windows.Handle, error) {
		for _, h := range held {
			windows.CloseHandle(h)
		}
		return nil, e
	}
	parts := strings.Split(strings.TrimPrefix(path, vol+"\\"), "\\")
	prefix := vol + "\\"
	paths := []string{prefix}
	for _, s := range parts {
		if s != "" {
			prefix = filepath.Join(prefix, s)
			paths = append(paths, prefix)
		}
	}
	for i, p := range paths {
		final := i == len(paths)-1
		h, e := windows.CreateFile(ptr(p), windows.READ_CONTROL|windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if e == windows.ERROR_FILE_NOT_FOUND || e == windows.ERROR_PATH_NOT_FOUND {
			if !createFinal {
				return fail(e)
			}
			// Newly created intermediate and final private directories receive their
			// protected DACL at creation. Never tighten an existing untrusted object.
			sd, e2 := descriptor()
			if e2 != nil {
				return fail(e2)
			}
			sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
			e2 = windows.CreateDirectory(ptr(p), &sa)
			runtime.KeepAlive(sd)
			if e2 != nil {
				return fail(e2)
			}
			h, e = windows.CreateFile(ptr(p), windows.READ_CONTROL|windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		}
		if e != nil {
			return fail(e)
		}
		held = append(held, h)
		if attributes(h, true) != nil || security(h, final && strictFinal) != nil {
			return fail(refused)
		}
	}
	return held, nil
}
func closeDirs(h []windows.Handle) {
	for i := len(h) - 1; i >= 0; i-- {
		windows.CloseHandle(h[i])
	}
}
func openPrivate(path string, write bool) (*os.File, error) {
	access := uint32(windows.GENERIC_READ | windows.READ_CONTROL)
	if write {
		access |= windows.GENERIC_WRITE
	}
	h, e := windows.CreateFile(ptr(path), access, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if e != nil {
		return nil, e
	}
	if attributes(h, false) != nil || security(h, true) != nil {
		windows.CloseHandle(h)
		return nil, refused
	}
	return os.NewFile(uintptr(h), path), nil
}
func readPrivate(path string, max int) ([]byte, error) {
	f, e := openPrivate(path, false)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, int64(max+1)))
	if e != nil || len(b) > max {
		return nil, refused
	}
	return b, nil
}
func dpapi(b []byte, decrypt bool) ([]byte, error) {
	if len(b) == 0 {
		return nil, refused
	}
	in := windows.DataBlob{Size: uint32(len(b)), Data: &b[0]}
	var out windows.DataBlob
	var e error
	if decrypt {
		e = windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	} else {
		e = windows.CryptProtectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	}
	runtime.KeepAlive(b)
	if e != nil {
		return nil, refused
	}
	defer windows.LocalFree(windows.Handle(uintptr(unsafe.Pointer(out.Data))))
	if out.Size > 65536 {
		return nil, refused
	}
	v := unsafe.Slice(out.Data, int(out.Size))
	copyOut := append([]byte(nil), v...)
	for i := range v {
		v[i] = 0
	}
	return copyOut, nil
}
func writePrivate(root, name string, b []byte) error {
	dest := filepath.Join(root, name)
	if f, e := openPrivate(dest, false); e == nil {
		f.Close()
	} else if e != windows.ERROR_FILE_NOT_FOUND {
		return e
	}
	var nonce [16]byte
	if _, e := rand.Read(nonce[:]); e != nil {
		return e
	}
	tmp := filepath.Join(root, fmt.Sprintf(".psc-%x", nonce))
	sd, e := descriptor()
	if e != nil {
		return e
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	h, e := windows.CreateFile(ptr(tmp), windows.GENERIC_READ|windows.GENERIC_WRITE|windows.READ_CONTROL, 0, &sa, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_WRITE_THROUGH|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	runtime.KeepAlive(sd)
	if e != nil {
		return e
	}
	f := os.NewFile(uintptr(h), tmp)
	published := false
	defer func() {
		f.Close()
		if !published {
			windows.DeleteFile(ptr(tmp))
		}
	}()
	if attributes(h, false) != nil || security(h, true) != nil {
		return refused
	}
	for off := 0; off < len(b); {
		n, e := f.Write(b[off:])
		if e != nil || n == 0 {
			return refused
		}
		off += n
	}
	if windows.FlushFileBuffers(h) != nil {
		return refused
	}
	if f.Close() != nil {
		return refused
	}
	if windows.MoveFileEx(ptr(tmp), ptr(dest), windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH) != nil {
		return refused
	}
	published = true
	// Checked publication/readback; file flush and write-through are not claimed
	// equivalent to POSIX directory-fsync or a universal power-loss guarantee.
	g, e := openPrivate(dest, true)
	if e != nil {
		return e
	}
	defer g.Close()
	if windows.FlushFileBuffers(windows.Handle(g.Fd())) != nil {
		return refused
	}
	got, e := io.ReadAll(io.LimitReader(g, int64(len(b)+1)))
	if e != nil || !bytes.Equal(got, b) {
		return refused
	}
	return nil
}
func lockDir(root string) (windows.Handle, error) {
	sd, e := descriptor()
	if e != nil {
		return 0, e
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	h, e := windows.CreateFile(ptr(filepath.Join(root, ".psc-store-lock")), windows.GENERIC_READ|windows.GENERIC_WRITE|windows.READ_CONTROL, 0, &sa, windows.OPEN_ALWAYS, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	runtime.KeepAlive(sd)
	if e != nil {
		return 0, e
	}
	if attributes(h, false) != nil || security(h, true) != nil {
		windows.CloseHandle(h)
		return 0, refused
	}
	return h, nil
}
func checkPath(path string, private bool) error {
	dirs, e := holdDirs(filepath.Dir(path), false, false)
	if e != nil {
		return e
	}
	defer closeDirs(dirs)
	h, e := windows.CreateFile(ptr(path), windows.GENERIC_READ|windows.READ_CONTROL, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if e != nil {
		return e
	}
	defer windows.CloseHandle(h)
	if attributes(h, false) != nil {
		return refused
	}
	return security(h, private)
}
func selfCheck() error {
	p, e := os.Executable()
	if e != nil {
		return e
	}
	return checkPath(p, true)
}
func execute(r Request) (Reply, error) {
	v := Reply{Version: 1, OK: true}
	if r.Op == "check-executable" || r.Op == "check-identity" {
		return v, checkPath(r.Path, r.Op == "check-identity")
	}
	held, e := holdDirs(r.Root, r.Op == "preflight" || r.Op == "write", true)
	if e != nil {
		if (e == windows.ERROR_FILE_NOT_FOUND || e == windows.ERROR_PATH_NOT_FOUND) && (r.Op == "read" || r.Op == "exists" || r.Op == "remove") {
			p := false
			v.Present = &p
			return v, nil
		}
		return Reply{}, e
	}
	defer closeDirs(held)
	if r.Op == "preflight" {
		return v, nil
	}
	lock, e := lockDir(r.Root)
	if e != nil {
		return Reply{}, e
	}
	defer windows.CloseHandle(lock)
	name, limit, e := fileName(r)
	if e != nil {
		return Reply{}, e
	}
	path := filepath.Join(r.Root, name)
	if r.Op == "write" {
		b, e := base64.StdEncoding.Strict().DecodeString(r.Data)
		if e != nil || len(b) > limit {
			return Reply{}, refused
		}
		if r.Kind == "credentials" {
			plain := b
			defer func() {
				for i := range plain {
					plain[i] = 0
				}
			}()
			b, e = dpapi(b, false)
			if e != nil {
				return Reply{}, e
			}
		}
		return v, writePrivate(r.Root, name, b)
	}
	b, e := readPrivate(path, limit+65536)
	if e == windows.ERROR_FILE_NOT_FOUND {
		p := false
		v.Present = &p
		return v, nil
	}
	if e != nil {
		return Reply{}, e
	}
	p := true
	v.Present = &p
	if r.Op == "remove" {
		return v, windows.DeleteFile(ptr(path))
	}
	if r.Op == "exists" {
		return v, nil
	}
	if r.Kind == "credentials" {
		b, e = dpapi(b, true)
		if e != nil {
			return Reply{}, e
		}
		defer func() {
			for i := range b {
				b[i] = 0
			}
		}()
	}
	if len(b) > limit {
		return Reply{}, refused
	}
	data := base64.StdEncoding.EncodeToString(b)
	v.Data = &data
	return v, nil
}
