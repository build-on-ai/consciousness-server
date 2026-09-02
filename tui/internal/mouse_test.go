package internal

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/build-on-ai/consciousness-server/tui/internal/api"
)

func TestLeftClickFocusesPanelUnderPointer(t *testing.T) {
	m := modelWithData(t)
	m.panels = []Panel{{Kind: PanelOverview}, {Kind: PanelTasks}}
	m.focused = 0
	_ = m.View()

	if len(m.geom) < 2 {
		t.Fatal("mapa trafień pusta — panele nie zapamiętały swoich prostokątów")
	}

	second := m.geom[1].Outer
	updated, _ := m.Update(tea.MouseClickMsg{X: second.X + 2, Y: second.Y + 3, Button: tea.MouseLeft})
	m = updated.(*Model)

	if m.focused != 1 {
		t.Errorf("klik w drugi panel nie przeniósł fokusu (fokus na %d)", m.focused)
	}
}

func TestRightClickOpensSameHelpAsQuestionMark(t *testing.T) {
	m := modelWithData(t)
	m.panels = []Panel{{Kind: PanelTasks}}
	_ = m.View()

	r := m.geom[0].Outer
	updated, _ := m.Update(tea.MouseClickMsg{X: r.X + 2, Y: r.Y + 3, Button: tea.MouseRight})
	m = updated.(*Model)

	if !m.showHelp {
		t.Fatal("prawy przycisk nie otworzył pomocy")
	}
	if got := m.helpTarget().Explain().TitleKey; got != "help.task.title" {
		t.Errorf("prawy przycisk pokazał %q zamiast opisu zadania", got)
	}
}

func TestWheelScrollsPanelUnderPointerNotFocused(t *testing.T) {
	m := modelWithData(t)
	m.panels = []Panel{{Kind: PanelOverview}, {Kind: PanelTasks}}
	m.focused = 0
	_ = m.View()

	second := m.geom[1].Outer
	updated, _ := m.Update(tea.MouseWheelMsg{X: second.X + 2, Y: second.Y + 3, Button: tea.MouseWheelDown})
	m = updated.(*Model)

	if m.panels[1].Cursor != 1 {
		t.Errorf("rolka nad drugim panelem nie przewinęła go (kursor %d)", m.panels[1].Cursor)
	}
	if m.focused != 0 {
		t.Error("rolka zmieniła fokus, a miała tylko przewinąć")
	}
}

func TestClickSelectsTheRowItLandsOnAfterScrolling(t *testing.T) {
	m := modelWithData(t)
	m.snap.Agents = make([]api.Agent, 60)
	for i := range m.snap.Agents {
		m.snap.Agents[i] = api.Agent{Name: fmt.Sprintf("agent-%02d", i), Role: "Observer", Location: "laptop"}
	}
	m.panels = []Panel{{Kind: PanelAgents, Cursor: 48}}
	m.focused = 0

	view := strings.Split(m.View().Content, "\n")
	g := m.geom[0]
	if g.Scroll == 0 {
		t.Fatal("panel się nie przewinął, więc test nie sprawdza tego, po co powstał")
	}

	targetY := g.Inner.Y + 3
	onScreen := view[targetY]

	updated, _ := m.Update(tea.MouseClickMsg{X: g.Inner.X + 2, Y: targetY, Button: tea.MouseLeft})
	m = updated.(*Model)

	picked := m.snap.Agents[m.panels[0].Cursor].Name
	if !strings.Contains(onScreen, picked) {
		t.Errorf("kliknięto w wiersz %q, a zaznaczony został %s", strings.TrimSpace(onScreen), picked)
	}
}

func TestClickOnHeadingSelectsNothing(t *testing.T) {
	m := modelWithData(t)
	m.snap.Agents = []api.Agent{
		{Name: "agent-aa", Role: "Observer"}, {Name: "agent-bb", Role: "Observer"},
	}
	m.panels = []Panel{{Kind: PanelAgents, Cursor: 1}}
	m.focused = 0
	_ = m.View()

	g := m.geom[0]
	if g.Preamble == 0 {
		t.Skip("panel bez preambuły — nie ma nagłówka do kliknięcia")
	}

	updated, _ := m.Update(tea.MouseClickMsg{X: g.Inner.X + 2, Y: g.Inner.Y, Button: tea.MouseLeft})
	m = updated.(*Model)

	if m.panels[0].Cursor != 1 {
		t.Errorf("klik w nagłówek przestawił zaznaczenie na %d", m.panels[0].Cursor)
	}
}

func TestClickDismissesPopupBeforeActing(t *testing.T) {
	c := api.New("http://127.0.0.1:1", "http://127.0.0.1:2")
	m := NewModel(c, api.NewStream(c))
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	m = updated.(*Model)
	m.showHelp = true
	before := m.focused

	updated, _ = m.Update(tea.MouseClickMsg{X: 5, Y: 5, Button: tea.MouseLeft})
	m = updated.(*Model)

	if m.showHelp {
		t.Error("klik nie zamknął pop-upa")
	}
	if m.focused != before {
		t.Error("klik zadziałał na panel schowany pod pop-upem")
	}
}

func TestSelectedRowStaysOnScreen(t *testing.T) {
	m := modelWithData(t)
	m.snap.Agents = make([]api.Agent, 80)
	for i := range m.snap.Agents {
		m.snap.Agents[i] = api.Agent{Name: fmt.Sprintf("agent-%02d", i), Role: "Observer"}
	}
	m.panels = []Panel{{Kind: PanelAgents}}
	m.focused = 0

	for _, cursor := range []int{0, 1, 12, 40, 78, 79} {
		m.panels[0].Cursor = cursor
		view := m.View().Content
		name := m.snap.Agents[cursor].Name

		if !strings.Contains(view, name) {
			t.Errorf("kursor na %s, a tego wiersza nie widać na ekranie", name)
		}
	}
}

func TestAgentWithoutCardIsMarkedOnlyOnceKnown(t *testing.T) {
	m := modelWithData(t)
	m.snap.Agents = []api.Agent{{Name: "observer"}, {Name: "nieznany"}}
	m.panels = []Panel{{Kind: PanelAgents}}
	m.focused = 0

	if strings.Contains(m.View().Content, "bez karty") {
		t.Error("panel twierdzi, że brak karty, zanim zapytał o listę kart")
	}

	m.snap.Checked = map[string]bool{"cards": true}
	m.snap.CardNames = map[string]bool{"OBSERVER": true}

	view := m.View().Content
	if !strings.Contains(view, "bez karty") {
		t.Error("agent bez karty nie jest oznaczony")
	}
	if strings.Count(view, "bez karty") != 1 {
		t.Errorf("oznaczono %d agentów zamiast jednego", strings.Count(view, "bez karty"))
	}
}
