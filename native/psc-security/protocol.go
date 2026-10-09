package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
)

const maxRequest = 1500000

var statusName = regexp.MustCompile(`^st-[0-9a-f]{24}$`)

type Request struct {
	Version int    `json:"version"`
	Op      string `json:"op"`
	Root    string `json:"root"`
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	Data    string `json:"data"`
	Path    string `json:"path"`
}
type Reply struct {
	Version int     `json:"version"`
	OK      bool    `json:"ok"`
	Present *bool   `json:"present,omitempty"`
	Data    *string `json:"data,omitempty"`
}

var refused = errors.New("protected operation refused")

func fileName(r Request) (string, int, error) {
	switch r.Kind {
	case "credentials":
		return "credentials.dpapi", 16384, nil
	case "pins":
		return "gateway_known_hosts", 1048576, nil
	case "hosts":
		return "hosts.json", 1048576, nil
	case "empty":
		return "known_hosts_empty", 0, nil
	case "status":
		if statusName.MatchString(r.Name) {
			return r.Name, 4096, nil
		}
	}
	return "", 0, refused
}
func validPath(s string) bool {
	if len(s) < 3 || !((s[0] >= 'A' && s[0] <= 'Z') || (s[0] >= 'a' && s[0] <= 'z')) || s[1] != ':' || (s[2] != '\\' && s[2] != '/') {
		return false
	}
	for _, v := range s {
		if v < 32 || v == 127 {
			return false
		}
	}
	if strings.ContainsAny(s[2:], `:<>"|?*`) {
		return false
	}
	for _, p := range strings.FieldsFunc(s[3:], func(r rune) bool { return r == '/' || r == '\\' }) {
		if p == "." || p == ".." || strings.HasSuffix(p, ".") || strings.HasSuffix(p, " ") {
			return false
		}
	}
	return true
}
func decode(in io.Reader) (Request, error) {
	b, e := io.ReadAll(io.LimitReader(in, maxRequest+1))
	if e != nil || len(b) > maxRequest {
		return Request{}, refused
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	var r Request
	if d.Decode(&r) != nil {
		return r, refused
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return r, refused
	}
	// Reject duplicate keys, including case variants interpreted by encoding/json.
	tokens := json.NewDecoder(bytes.NewReader(b))
	if t, e := tokens.Token(); e != nil || t != json.Delim('{') {
		return r, refused
	}
	keys := map[string]bool{}
	for tokens.More() {
		k, e := tokens.Token()
		if e != nil {
			return r, refused
		}
		key, ok := k.(string)
		if !ok {
			return r, refused
		}
		switch key {
		case "version", "op", "root", "kind", "name", "data", "path":
		default:
			return r, refused
		}
		if keys[strings.ToLower(key)] {
			return r, refused
		}
		keys[strings.ToLower(key)] = true
		var v any
		if tokens.Decode(&v) != nil {
			return r, refused
		}
	}
	if r.Version != 1 || !validPath(r.Root) {
		return r, refused
	}
	switch r.Op {
	case "preflight":
		if r.Kind != "" || r.Name != "" || r.Data != "" || r.Path != "" {
			return r, refused
		}
	case "check-executable", "check-identity":
		if !validPath(r.Path) || r.Kind != "" || r.Name != "" || r.Data != "" {
			return r, refused
		}
	case "read", "write", "remove", "exists":
		_, limit, e := fileName(r)
		if e != nil || r.Path != "" || (r.Kind != "status" && r.Name != "") {
			return r, refused
		}
		if r.Op == "write" {
			v, e := base64.StdEncoding.Strict().DecodeString(r.Data)
			if e != nil || len(v) > limit {
				return r, refused
			}
		} else if r.Data != "" {
			return r, refused
		}
	default:
		return r, refused
	}
	return r, nil
}
