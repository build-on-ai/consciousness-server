package theme

import "testing"

func TestEachSeverityHasItsOwnMark(t *testing.T) {
	marks := map[string]string{}

	for _, state := range []string{"ok", "BRAK SESJI", "OFFLINE", "cokolwiek"} {
		mark := StatusMark(state)
		if mark == "" {
			t.Fatalf("state %q has no mark; in this palette that leaves colour alone to carry it", state)
		}
		if prev, clash := marks[mark]; clash {
			t.Errorf("states %q and %q share the mark %q — indistinguishable without colour", prev, state, mark)
		}
		marks[mark] = state
	}
}

func TestUnknownDoesNotLookHealthy(t *testing.T) {

	if StatusMark("nierozpoznany") == StatusMark("ok") {
		t.Error("an unrecognised state carries the healthy mark")
	}
	if StatusStyle("nierozpoznany").GetForeground() == StatusStyle("ok").GetForeground() {
		t.Error("an unrecognised state is coloured as healthy")
	}
}

func TestWarnIsDistinguishableFromOK(t *testing.T) {

	if StatusMark("BRAK SESJI") == StatusMark("ok") {
		t.Error("GHOST carries the same mark as a healthy state")
	}
	if Status("BRAK SESJI") == Status("ok") {
		t.Error("GHOST renders identically to a healthy state")
	}
}

func TestStatusCarriesBothMarkAndWord(t *testing.T) {
	out := Status("OFFLINE")
	if len(out) == 0 {
		t.Fatal("Status rendered nothing")
	}

	if !contains(out, "OFFLINE") {
		t.Error("Status dropped the state word, leaving only a glyph")
	}
	if !contains(out, StatusMark("OFFLINE")) {
		t.Error("Status dropped the glyph, leaving colour as the only signal")
	}
}

func contains(haystack, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) &&
		(haystack == needle || indexOf(haystack, needle) >= 0)
}

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}
