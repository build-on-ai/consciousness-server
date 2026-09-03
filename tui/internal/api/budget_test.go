package api

import (
	"strings"
	"testing"
)

// Ile zrodel liczy sie do limitu rdzenia. /health i /api/rate-limits sa z niego
// zwolnione (core/server.js), reszta zapytan do rdzenia nie.
func liczoneDoLimitu(t *testing.T) (szybkie, wolne int) {
	t.Helper()
	for _, src := range sources {
		switch src.Name {
		case "health":
			continue // zwolnione w rdzeniu
		case "services", "keys":
			continue // ida do machines-server i key-servera, nie do rdzenia
		}
		if src.Slow {
			wolne++
		} else {
			szybkie++
		}
	}
	return
}

// Panel odswiezal wszystkie zrodla co 3 sekundy, czyli okolo 140 zapytan na
// minute przy limicie 60. Rdzen odmawial po jakichs 26 sekundach, a panel
// pokazywal zamrozone dane i wygladalo to na awarie serwera.
//
// Ten test wiaze tempo panelu z limitem rdzenia: dolozenie zrodla albo
// przyspieszenie odswiezania zapala sie tutaj, nie po 26 sekundach na maszynie.
func TestBudzetZapytanMiesciSieWLimicie(t *testing.T) {
	const (
		limitNaMinute = 60 // core/server.js: max_requests_per_minute
		szybkieCoS    = 6  // internal.DefaultRefresh
		coIleWolne    = 5  // internal.SlowEvery
	)

	szybkie, wolne := liczoneDoLimitu(t)
	tykiNaMinute := 60 / szybkieCoS
	zapytania := szybkie*tykiNaMinute + wolne*(tykiNaMinute/coIleWolne)

	if zapytania > limitNaMinute {
		t.Fatalf("panel wysyla %d zapytan na minute przy limicie %d "+
			"(%d szybkich co %ds, %d wolnych co %ds)",
			zapytania, limitNaMinute, szybkie, szybkieCoS, wolne, szybkieCoS*coIleWolne)
	}
	if zapytania > limitNaMinute*3/4 {
		t.Errorf("panel zjada %d z %d zapytan na minute — zostaje za malo zapasu "+
			"na reczne odswiezenie", zapytania, limitNaMinute)
	}
}

// Bez rozdzielenia grup panel wraca do stanu sprzed poprawki. Ten test pilnuje,
// ze podzial w ogole istnieje, a nie tylko ze liczby sie zgadzaja.
func TestWolneZrodlaSaOznaczone(t *testing.T) {
	oczekiwaneWolne := map[string]bool{
		"routes": true, "graph": true, "cards": true, "events": true,
	}
	for _, src := range sources {
		if oczekiwaneWolne[src.Name] && !src.Slow {
			t.Errorf("zrodlo %q zmienia sie rzadko, a odpytywane jest w kazdym tyku", src.Name)
		}
		if !oczekiwaneWolne[src.Name] && src.Slow {
			t.Errorf("zrodlo %q oznaczono jako wolne — panel przestanie pokazywac je na biezaco", src.Name)
		}
	}
}

// Zrodla ida do trzech roznych uslug. Gdyby ktores przeniesiono do rdzenia bez
// przeliczenia budzetu, limit wrocilby cicho.
func TestZrodlaRdzeniaSaTymCzymByly(t *testing.T) {
	doRdzenia := map[string]bool{}
	for _, src := range sources {
		if src.Name == "services" || src.Name == "keys" {
			continue
		}
		doRdzenia[src.Name] = true
	}
	for _, nazwa := range []string{"health", "agents", "tasks", "routes", "events", "ws", "cards", "graph"} {
		if !doRdzenia[nazwa] {
			t.Errorf("zrodlo %q znikelo z listy zapytan do rdzenia — przelicz budzet", nazwa)
		}
	}
	if len(doRdzenia) != 8 {
		var maja []string
		for n := range doRdzenia {
			maja = append(maja, n)
		}
		t.Errorf("do rdzenia idzie %d zrodel zamiast 8 (%s) — przelicz budzet",
			len(doRdzenia), strings.Join(maja, ", "))
	}
}
