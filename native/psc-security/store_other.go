//go:build !windows

package main

func selfCheck() error               { return refused }
func execute(Request) (Reply, error) { return Reply{}, refused }
