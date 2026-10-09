package main

import (
	"encoding/json"
	"os"
)

func main() {
	// Native authority validates its own executable custody before receiving secret input.
	if selfCheck() != nil {
		os.Exit(1)
	}
	r, e := decode(os.Stdin)
	if e != nil {
		os.Exit(1)
	}
	v, e := execute(r)
	if e != nil {
		os.Exit(1)
	}
	if json.NewEncoder(os.Stdout).Encode(v) != nil {
		os.Exit(1)
	}
}
