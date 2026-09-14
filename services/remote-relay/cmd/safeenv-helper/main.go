package main

import (
	"fmt"
	"os"
	"sort"

	"github.com/freebuddy/freebuddy/services/remote-relay/internal/safeenv"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "usage: safeenv-helper <dump|generate|validate> [args...]\n")
		os.Exit(1)
	}

	cmd := os.Args[1]
	switch cmd {
	case "dump":
		if len(os.Args) != 3 {
			fmt.Fprintf(os.Stderr, "usage: safeenv-helper dump <env-file>\n")
			os.Exit(1)
		}
		path := os.Args[2]
		data, err := safeenv.OpenAndValidateEnvFile(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
		// Deterministic sorted output
		keys := make([]string, 0, len(data))
		for k := range data {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Printf("%s=%s\n", k, data[k])
		}

	case "generate":
		if len(os.Args) != 4 {
			fmt.Fprintf(os.Stderr, "usage: safeenv-helper generate <env-file> <db-file>\n")
			os.Exit(1)
		}
		envPath := os.Args[2]
		dbPath := os.Args[3]
		created, err := safeenv.GenerateEnvFile(envPath, dbPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
		if created {
			fmt.Printf("Local dev environment generated at %s (mode: 0600)\n", envPath)
		}

	case "validate":
		if len(os.Args) != 3 {
			fmt.Fprintf(os.Stderr, "usage: safeenv-helper validate <env-file>\n")
			os.Exit(1)
		}
		path := os.Args[2]
		_, err := safeenv.OpenAndValidateEnvFile(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}

	default:
		fmt.Fprintf(os.Stderr, "unknown command %q (only dump, generate, validate supported)\n", cmd)
		os.Exit(1)
	}
}
