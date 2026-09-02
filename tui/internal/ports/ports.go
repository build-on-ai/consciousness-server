package ports

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

var (
	once   sync.Once
	loaded map[string]int
)

var (
	entryRe  = regexp.MustCompile(`^\s+([A-Za-z][\w-]*)\s*:\s*(\d+)\s*$`)
	topKeyRe = regexp.MustCompile(`^([A-Za-z][\w-]*)\s*:\s*$`)
)

func FindFile() string {
	if p := os.Getenv("CS_PORTS_FILE"); p != "" {
		return p
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	dir := filepath.Dir(exe)
	for i := 0; i < 6; i++ {
		candidate := filepath.Join(dir, "ports.yaml")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

func load() {
	loaded = map[string]int{}
	path := FindFile()
	if path == "" {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}

	inPorts := false
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		if m := topKeyRe.FindStringSubmatch(line); m != nil {
			inPorts = m[1] == "ports"
			continue
		}
		if !inPorts {
			continue
		}
		if m := entryRe.FindStringSubmatch(line); m != nil {
			if n, err := strconv.Atoi(m[2]); err == nil {
				loaded[m[1]] = n
			}
		}
	}
}

func Get(name string, fallback int) int {
	once.Do(load)
	if p, ok := loaded[name]; ok {
		return p
	}
	return fallback
}

func URL(name string, fallback int) string {
	return "http://127.0.0.1:" + strconv.Itoa(Get(name, fallback))
}

func Source() string {
	once.Do(load)
	if p := FindFile(); p != "" && len(loaded) > 0 {
		return p
	}
	return "wbudowane wartości domyślne"
}
