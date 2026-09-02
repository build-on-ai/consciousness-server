package ports

import (
	"os"
	"path/filepath"
	"testing"
)

const registry = `# Comment lines are skipped, including this one.
version: 1

ports:
  # Indented comments are skipped too.
  consciousness-server: 13032
  semantic-search: 13037
  machines-server: 13038
  redis: 16380
  not-a-port: abc
  ollama: 11434

active_blocks:
  - core
  - mesh

other-top-key:
  machines-server: 999
`

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "ports-test")
	if err != nil {
		panic(err)
	}
	path := filepath.Join(dir, "ports.yaml")
	if err := os.WriteFile(path, []byte(registry), 0o644); err != nil {
		panic(err)
	}
	os.Setenv("CS_PORTS_FILE", path)
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func TestGetReadsRegistry(t *testing.T) {
	for _, tc := range []struct {
		name     string
		fallback int
		want     int
	}{
		{"consciousness-server", 3032, 13032},
		{"semantic-search", 3037, 13037},
		{"machines-server", 3038, 13038},
		{"redis", 6380, 16380},
	} {
		if got := Get(tc.name, tc.fallback); got != tc.want {
			t.Errorf("Get(%q, %d) = %d, chcemy %d z rejestru", tc.name, tc.fallback, got, tc.want)
		}
	}
}

func TestRegistryBeatsFallback(t *testing.T) {
	if got := Get("consciousness-server", 3032); got == 3032 {
		t.Fatal("fallback wygrał z rejestrem — to dokładnie ta usterka, przed którą pakiet ma chronić")
	}
}

func TestFallbackWhenServiceAbsent(t *testing.T) {
	if got := Get("nieistniejaca-usluga", 4242); got != 4242 {
		t.Errorf("Get(brak w rejestrze) = %d, chcemy fallback 4242", got)
	}
}

func TestNonNumericValueFallsBack(t *testing.T) {
	if got := Get("not-a-port", 7777); got != 7777 {
		t.Errorf("Get(wartosc nieliczbowa) = %d, chcemy fallback 7777", got)
	}
}

func TestKeysOutsidePortsSectionIgnored(t *testing.T) {
	if got := Get("machines-server", 3038); got != 13038 {
		t.Errorf("Get(machines-server) = %d — klucz spoza sekcji ports nie może nadpisywać rejestru", got)
	}
}

func TestURLBuildsLoopbackAddress(t *testing.T) {
	if got, want := URL("consciousness-server", 3032), "http://127.0.0.1:13032"; got != want {
		t.Errorf("URL() = %q, chcemy %q", got, want)
	}
	if got, want := URL("nieistniejaca-usluga", 4242), "http://127.0.0.1:4242"; got != want {
		t.Errorf("URL(fallback) = %q, chcemy %q", got, want)
	}
}

func TestSourceNamesTheFileItRead(t *testing.T) {
	want := os.Getenv("CS_PORTS_FILE")
	if got := Source(); got != want {
		t.Errorf("Source() = %q, chcemy sciezke rejestru %q", got, want)
	}
}

func TestFindFilePrefersEnvOverride(t *testing.T) {
	t.Setenv("CS_PORTS_FILE", "/nieistniejaca/sciezka/ports.yaml")
	if got, want := FindFile(), "/nieistniejaca/sciezka/ports.yaml"; got != want {
		t.Errorf("FindFile() = %q, chcemy wartosc z CS_PORTS_FILE %q", got, want)
	}
}

func TestFindFileReturnsEmptyWhenNoRegistryAbove(t *testing.T) {
	t.Setenv("CS_PORTS_FILE", "")
	dir := t.TempDir()
	if err := os.Chdir(dir); err != nil {
		t.Skipf("nie udało się zmienić katalogu: %v", err)
	}

	if got := FindFile(); got != "" && filepath.Base(got) != "ports.yaml" {
		t.Errorf("FindFile() = %q — spodziewamy sie pustej wartosci albo sciezki do ports.yaml", got)
	}
}
