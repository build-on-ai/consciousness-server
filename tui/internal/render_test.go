package internal

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/build-on-ai/consciousness-server/tui/internal/api"
)

func TestRenderSurvivesDeadSources(t *testing.T) {
	c := api.New("http://127.0.0.1:1", "http://127.0.0.1:2")
	m := NewModel(c, api.NewStream(c))

	updated, _ := m.Update(tea.WindowSizeMsg{Width: 120, Height: 35})
	m = updated.(*Model)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	updated, _ = m.Update(snapshotMsg(c.Fetch(ctx, true)))
	m = updated.(*Model)

	out := m.View().Content
	if strings.TrimSpace(out) == "" {
		t.Fatal("view is empty while every source is down; it must still draw")
	}
	if !strings.Contains(out, "BuildOnAI") {
		t.Error("header missing from a degraded view")
	}

	if !strings.Contains(out, "źródła bez odpowiedzi") && !strings.Contains(out, "brak źródła") {
		t.Error("dead sources are not reported anywhere in the view")
	}
}

func TestPanelsOpenAndClose(t *testing.T) {
	c := api.New("http://127.0.0.1:1", "http://127.0.0.1:2")
	m := NewModel(c, api.NewStream(c))
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 200, Height: 40})
	m = updated.(*Model)

	before := len(m.panels)
	m.openPanel(PanelAgents)
	if len(m.panels) != before {
		t.Errorf("opening an already-open panel duplicated it: %d -> %d", before, len(m.panels))
	}

	for len(m.panels) > 1 {
		m.focused = 0
		updated, _ = m.handleKey(keyPress("w"))
		m = updated.(*Model)
	}
	updated, _ = m.handleKey(keyPress("w"))
	m = updated.(*Model)
	if len(m.panels) != 1 {
		t.Errorf("the last panel was closed, leaving %d panels", len(m.panels))
	}
}

func TestNarrowTerminalCapsPanels(t *testing.T) {
	c := api.New("http://127.0.0.1:1", "http://127.0.0.1:2")
	m := NewModel(c, api.NewStream(c))
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 30})
	m = updated.(*Model)

	m.openPanel(PanelServices)
	m.openPanel(PanelEvents)
	m.openPanel(PanelEndpoints)

	if len(m.panels) > m.maxPanels() {
		t.Errorf("%d panels open at width %d, cap is %d", len(m.panels), m.width, m.maxPanels())
	}
}

func TestPreview(t *testing.T) {
	if os.Getenv("BOA_PREVIEW") == "" {
		t.Skip("set BOA_PREVIEW=1 to print the layout")
	}

	core := envOr("BOA_CORE", "http://127.0.0.1:3032")
	machines := envOr("BOA_MACHINES", "http://127.0.0.1:3038")

	c := api.New(core, machines)
	s := api.NewStream(c)
	go s.Run("PODGLAD")
	defer s.Stop()

	m := NewModel(c, s)
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 132, Height: 34})
	m = updated.(*Model)

	m.openPanel(PanelServices)
	m.openPanel(PanelEvents)

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	updated, _ = m.Update(snapshotMsg(c.Fetch(ctx, true)))
	m = updated.(*Model)

	time.Sleep(1500 * time.Millisecond)
	updated, _ = m.Update(tickMsg(time.Now()))
	m = updated.(*Model)

	fmt.Println(m.View().Content)
}

func keyPress(s string) tea.KeyPressMsg {
	named := map[string]rune{
		"left": tea.KeyLeft, "right": tea.KeyRight,
		"up": tea.KeyUp, "down": tea.KeyDown,
		"esc": tea.KeyEscape, "enter": tea.KeyEnter,
		"tab": tea.KeyTab, "backspace": tea.KeyBackspace,
		"pgup": tea.KeyPgUp, "pgdown": tea.KeyPgDown,
	}
	if code, ok := named[s]; ok {
		return tea.KeyPressMsg{Code: code}
	}
	if len([]rune(s)) != 1 {
		panic("keyPress: nieznana nazwa klawisza " + s)
	}
	return tea.KeyPressMsg{Code: []rune(s)[0], Text: s}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func TestLegendExplainsEveryState(t *testing.T) {
	agents := strings.Join(flatten(agentsPanel{}.Explain()), " ")
	for _, state := range []string{"PRACUJE", "GOTOWY", "BRAK SESJI", "OFFLINE", "NIEZNANY"} {
		if !strings.Contains(agents, state) {
			t.Errorf("panel agentów nie tłumaczy stanu %q", state)
		}
	}

	general := strings.Join(flatten(generalLegend{}.Explain()), " ")
	for _, mark := range []string{"brak pisarza", "niemy kanał", "UNBOUND"} {
		if !strings.Contains(general, mark) {
			t.Errorf("legenda ogólna nie tłumaczy %q, choć panele to pokazują", mark)
		}
	}

	if strings.Contains(general, "BRAK SESJI") {
		t.Error("legenda ogólna znów mówi o stanach agentów — dwa poziomy pomocy się zlewają")
	}
}

func TestSteppingOutAlwaysReachesGeneralLegend(t *testing.T) {
	m := modelWithData(t)

	for _, kind := range []PanelKind{PanelOverview, PanelAgents, PanelTasks, PanelServices} {
		m.panels = []Panel{{Kind: kind}}
		m.focused = 0
		m.helpLevel = 0

		_, total := m.helpDepth()
		m.helpLevel = total - 1

		if got := m.helpTarget().Explain().TitleKey; got != "help.general.title" {
			t.Errorf("z panelu %q ostatni poziom to %q, a powinien być legendą ogólną", kind.Title(), got)
		}
	}
}

func TestAnyKeyClosesLegendBeforeActing(t *testing.T) {
	c := api.New("http://127.0.0.1:1", "http://127.0.0.1:2")
	m := NewModel(c, api.NewStream(c))
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 200, Height: 46})
	m = updated.(*Model)

	before := len(m.panels)
	m.showHelp = true

	updated, _ = m.handleKey(keyPress("3"))
	m = updated.(*Model)

	if m.showHelp {
		t.Error("legend stayed open after a panel key")
	}
	if len(m.panels) != before {
		t.Errorf("a key acted on the panels while the legend covered them: %d -> %d", before, len(m.panels))
	}
}

func TestOverviewNamesEverySourceTheClientQueries(t *testing.T) {
	m := modelWithData(t)
	m.panels = []Panel{{Kind: PanelOverview}}
	m.focused = 0
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 160, Height: 44})
	m = updated.(*Model)

	view := m.View().Content
	for _, name := range api.SourceNames() {
		if !strings.Contains(view, name) {
			t.Errorf("przegląd nie wymienia źródła %q, więc nie ma gdzie zgłosić jego awarii", name)
		}
	}
}

func TestUncheckedSourceIsNotDrawnAsHealthy(t *testing.T) {
	c := api.New("http://127.0.0.1:1", "http://127.0.0.1:2")
	m := NewModel(c, api.NewStream(c))
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 160, Height: 44})
	m = updated.(*Model)
	m.panels = []Panel{{Kind: PanelOverview}}

	if got := m.snap.SourceState("graph"); got != "pending" {
		t.Errorf("przed pierwszym odczytem źródło ma stan %q, a nikt go nie pytał", got)
	}
	if !strings.Contains(m.View().Content, "jeszcze nie sprawdzone") {
		t.Error("pusty snapshot nie mówi, że źródeł nie sprawdzono")
	}

	m.snap.Checked = map[string]bool{"graph": true}
	if got := m.snap.SourceState("graph"); got != "ok" {
		t.Errorf("po odpowiedzi źródło ma stan %q zamiast ok", got)
	}
}

func TestCarriedOverDataIsNotShownAsCurrent(t *testing.T) {
	m := modelWithData(t)
	m.panels = []Panel{{Kind: PanelOverview}}
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 160, Height: 44})
	m = updated.(*Model)

	now := time.Now()
	m.lastFetch = now
	m.snap.Fresh = map[string]time.Time{
		"health": now,
		"agents": now.Add(-5 * time.Minute),
	}
	m.snap.Checked = map[string]bool{"health": true, "agents": true}
	m.snap.Errors = map[string]string{"agents": "connection refused"}

	view := m.View().Content
	if strings.Contains(view, "dane teraz") {
		t.Error("nagłówek mówi „dane teraz” nad danymi sprzed pięciu minut")
	}
	if !strings.Contains(view, "nieświeże") {
		t.Error("nagłówek nie sygnalizuje, że część danych jest przeniesiona")
	}
	if !strings.Contains(view, "dane sprzed") {
		t.Error("przegląd nie mówi, jak stare są dane martwego źródła")
	}

	if age, known := m.snap.AgeOf("health", now); !known || age > time.Second {
		t.Errorf("świeże źródło ma wiek %v (znany: %v)", age, known)
	}
}
