package internal

import (
	"runtime/debug"
	"time"
)

func buildStamp() (revision, stamp string) {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "", ""
	}

	var dirty bool
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			if len(s.Value) > 7 {
				revision = s.Value[:7]
			} else {
				revision = s.Value
			}
		case "vcs.time":
			if t, err := time.Parse(time.RFC3339, s.Value); err == nil {
				stamp = t.Local().Format("02.01 15:04")
			}
		case "vcs.modified":
			dirty = s.Value == "true"
		}
	}

	if revision == "" {
		return "bez wersji", ""
	}
	if dirty {
		revision += "+"
	}
	return revision, stamp
}
