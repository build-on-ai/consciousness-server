package internal

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

func coreSource(t *testing.T) string {
	t.Helper()

	path := filepath.Join("..", "..", "core", "server.js")
	data, err := os.ReadFile(path)
	if err == nil {
		return string(data)
	}

	if os.Getenv("BOA_NO_CORE") != "" {
		t.Skipf("BOA_NO_CORE=1 — świadomie pomijam sprawdzenie zgodności z rdzeniem (%v)", err)
	}
	t.Fatalf("nie ma %s, więc nic nie pilnuje zgodności katalogów z rdzeniem.\n"+
		"Jeśli to celowe (panel budowany bez rdzenia), ustaw BOA_NO_CORE=1.\nBłąd: %v", path, err)
	return ""
}

var channelListRe = regexp.MustCompile(`const WS_CHANNELS\s*=\s*\[([^\]]*)\]`)

func TestEveryChannelIsDescribed(t *testing.T) {
	src := coreSource(t)

	m := channelListRe.FindStringSubmatch(src)
	if m == nil {
		t.Fatal("nie znaleziono WS_CHANNELS w rdzeniu — zmieniła się deklaracja, ten test trzeba poprawić")
	}

	declared := map[string]bool{}
	for _, raw := range strings.Split(m[1], ",") {
		if name := strings.Trim(strings.TrimSpace(raw), "'\"`"); name != "" {
			declared[name] = true
		}
	}
	if len(declared) == 0 {
		t.Fatal("rdzeń deklaruje pustą listę kanałów — to na pewno błąd odczytu")
	}

	described := map[string]bool{}
	for _, row := range channelDocs {
		if described[row[0]] {
			t.Errorf("kanał %q opisany dwa razy", row[0])
		}
		described[row[0]] = true

		if strings.TrimSpace(row[1]) == "" {
			t.Errorf("kanał %q ma pusty opis", row[0])
		}
	}

	for _, name := range sorted(declared) {
		if !described[name] {
			t.Errorf("rdzeń nadaje na kanał %q, a panel nie mówi, co na nim leci — dopisz go do channelDocs", name)
		}
	}
	for _, name := range sorted(described) {
		if !declared[name] {
			t.Errorf("panel opisuje kanał %q, którego rdzeń już nie ma — opis przeżył kanał", name)
		}
	}
}

func emitters(src string) map[string]bool {
	out := map[string]bool{}
	for _, m := range regexp.MustCompile(`emit\(\s*['"]([a-z_]+)['"]`).FindAllStringSubmatch(src, -1) {
		out[m[1]] = true
	}
	return out
}

func TestSilentChannelsAreCalledSilent(t *testing.T) {
	src := coreSource(t)
	sends := emitters(src)
	if len(sends) == 0 {
		t.Fatal("nie znaleziono żadnego emit() — zmienił się rdzeń, ten test trzeba poprawić")
	}

	for _, row := range channelDocs {
		name, description := row[0], row[1]
		if sends[name] {
			if strings.Contains(description, "nikt nie nadaje") {
				t.Errorf("kanał %q ma nadawcę, a opis mówi, że nie ma", name)
			}
			continue
		}
		if !strings.Contains(description, "nikt nie nadaje") {
			t.Errorf("na kanał %q nikt nie nadaje, a opis tego nie mówi: %q", name, description)
		}
	}
}

var edgeKindRe = regexp.MustCompile(`edge\([^,]+,[^,]+,\s*['"]([a-z_]+)['"]`)

func TestEveryEdgeKindIsDescribed(t *testing.T) {
	src := coreSource(t)

	produced := map[string]bool{}
	for _, m := range edgeKindRe.FindAllStringSubmatch(src, -1) {
		produced[m[1]] = true
	}
	if len(produced) == 0 {
		t.Fatal("nie znaleziono żadnego wywołania edge() — zmienił się rdzeń, ten test trzeba poprawić")
	}

	explained := map[string]bool{}
	for _, section := range (graphPanel{}).Explain().Sections {
		for _, row := range section.Rows {
			explained[row[0]] = true
		}
	}

	for _, kind := range sorted(produced) {
		if !explained[kind] {
			t.Errorf("rdzeń tworzy krawędzie rodzaju %q, a panel nie tłumaczy tego rodzaju", kind)
		}
	}
}

func TestEveryAgentCardIsReadable(t *testing.T) {
	cards, err := filepath.Glob(filepath.Join("..", "..", "agents", "*.md"))
	if err != nil || len(cards) == 0 {
		t.Skip("brak katalogu agents/ — nie ma kart do sprawdzenia")
	}

	for _, path := range cards {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("karta %s nie daje się odczytać: %v", filepath.Base(path), err)
			continue
		}
		if len(strings.TrimSpace(string(data))) == 0 {
			t.Errorf("karta %s jest pusta — agent bez opisanej roli", filepath.Base(path))
		}
	}
}

func sorted(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
