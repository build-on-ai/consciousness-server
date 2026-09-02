package internal

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/build-on-ai/consciousness-server/tui/internal/api"
)

func modelWithData(t *testing.T) *Model {
	t.Helper()

	c := api.New("http://127.0.0.1:1", "http://127.0.0.1:2")
	m := NewModel(c, api.NewStream(c))
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	m = updated.(*Model)

	m.snap = api.Snapshot{
		Tasks: []api.Task{
			{ID: "aaa-111", Title: "Pierwsze zadanie", Status: "PENDING", AssignedTo: "agent-1", CreatedBy: "agent-2"},
			{ID: "bbb-222", Title: "Drugie zadanie", Status: "DONE", AssignedTo: "agent-3"},
		},
		Agents: []api.Agent{
			{Name: "agent-1", Role: "Observer", Location: "laptop"},
		},
		Attached: map[string]bool{},
	}
	return m
}

func TestHelpAnswersAboutWhateverIsUnderTheCursor(t *testing.T) {
	m := modelWithData(t)
	m.panels = []Panel{{Kind: PanelTasks}}
	m.focused = 0

	first := m.helpTarget().Explain()
	if !strings.Contains(strings.Join(flatten(first), " "), "aaa-111") {
		t.Errorf("kursor na zadaniu, a pomoc nie mówi o tym zadaniu: %q", first.TitleKey)
	}

	m.panels[0].Cursor = 1
	second := m.helpTarget().Explain()
	joined := strings.Join(flatten(second), " ")
	if !strings.Contains(joined, "bbb-222") {
		t.Error("pomoc nie podąża za kursorem na drugie zadanie")
	}
	if strings.Contains(joined, "aaa-111") {
		t.Error("pomoc dalej opisuje poprzednie zadanie")
	}

	m.panels[0].Cursor = 99
	if got := m.helpTarget().Explain().TitleKey; got != "help.tasks.title" {
		t.Errorf("bez zaznaczonego wiersza pomoc powinna opisać panel, dostałem %q", got)
	}
}

func TestPendingTaskExplainsWhyItWaits(t *testing.T) {
	m := modelWithData(t)
	m.panels = []Panel{{Kind: PanelTasks}}

	text := strings.Join(flatten(m.helpTarget().Explain()), " ")
	if !strings.Contains(text, "czeka") {
		t.Error("opis zadania PENDING nie tłumaczy, dlaczego ono czeka")
	}
}

func TestEveryPanelKindExplainsItself(t *testing.T) {
	if len(AllPanels) != int(panelKindCount) {
		t.Fatalf("rejestr ma %d paneli, a rodzajów jest %d", len(AllPanels), panelKindCount)
	}

	seen := map[string]PanelKind{}
	for _, v := range AllPanels {
		k := v.Kind()
		doc := k.Explain()

		if !hasContent(doc) {
			t.Errorf("panel %q ma pomoc bez treści — same puste sekcje", k.Title())
		}
		if strings.TrimSpace(doc.Subtitle) == "" {
			t.Errorf("panel %q nie ma podtytułu, więc pop-up nie mówi, czego dotyczy", k.Title())
		}
		if doc.TitleKey == "" {
			t.Errorf("panel %q nie ma klucza tytułu — bez niego nie da się go przetłumaczyć", k.Title())
		}
		if prev, clash := seen[doc.TitleKey]; clash {
			t.Errorf("panele %q i %q dzielą klucz %q — jeden pokazuje cudzą legendę",
				prev.Title(), k.Title(), doc.TitleKey)
		}
		seen[doc.TitleKey] = k

		if got := helpTitle(doc); got == "Legenda" && doc.TitleKey != "help.general.title" {
			t.Errorf("panel %q ma klucz %q, którego helpTitle nie zna — pop-up nazwie się „Legenda”",
				k.Title(), doc.TitleKey)
		}
	}

	if _, clash := seen["help.general.title"]; clash {
		t.Error("panel używa klucza legendy ogólnej, więc dwa poziomy pomocy są identyczne")
	}
}

func TestEveryPanelHasItsOwnKey(t *testing.T) {
	seen := map[string]string{}
	for _, v := range AllPanels {
		if v.Key() == "" {
			t.Errorf("panel %q nie ma klawisza", v.Title())
			continue
		}
		if prev, clash := seen[v.Key()]; clash {
			t.Errorf("panele %q i %q dzielą klawisz %q", prev, v.Title(), v.Key())
		}
		seen[v.Key()] = v.Title()
	}
}

func TestSessionlessAgentExplainsWhichLampIsMissing(t *testing.T) {
	m := modelWithData(t)
	m.snap.Agents[0].LastHeartbeat = timeNowRFC3339()
	m.snap.Attached = map[string]bool{}
	m.panels = []Panel{{Kind: PanelAgents}}

	text := strings.Join(flatten(m.helpTarget().Explain()), " ")
	if !strings.Contains(text, "BRAK SESJI") {
		t.Fatalf("agent z pulsem bez połączenia nie jest opisany jako BRAK SESJI: %s", text)
	}

	if !strings.Contains(text, "sesja") && !strings.Contains(text, "WebSocket") {
		t.Errorf("opis stanu BRAK SESJI nie mówi, której osi brakuje: %s", text)
	}
}

func timeNowRFC3339() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func flatten(d Doc) []string {
	out := []string{d.TitleKey, d.Subtitle}
	for _, s := range d.Sections {
		out = append(out, s.Title, s.Note)
		for _, r := range s.Rows {
			out = append(out, r[0], r[1])
		}
		out = append(out, s.Lines...)
	}
	return out
}

func TestHelpDescribesTheEventUnderTheCursor(t *testing.T) {
	m := modelWithData(t)
	m.stream.Seed(
		api.Event{Seq: 1, Channel: "tasks", Type: "task_created", Data: map[string]any{"id": "aaa-111"}},
		api.Event{Seq: 2, Channel: "agents", Type: "agent_updated", Data: map[string]any{"name": "agent-1"}},
	)
	m.panels = []Panel{{Kind: PanelEvents}}
	m.focused = 0

	newest := m.helpTarget().Explain()
	if got := newest.TitleKey; got != "help.event.title" {
		t.Fatalf("kursor na zdarzeniu, a pomoc mówi %q", got)
	}
	if !strings.Contains(strings.Join(flatten(newest), " "), "agent_updated") {
		t.Errorf("pomoc nie opisuje najnowszego zdarzenia: %+v", newest.Sections)
	}

	m.panels[0].Cursor = 1
	older := strings.Join(flatten(m.helpTarget().Explain()), " ")
	if !strings.Contains(older, "task_created") {
		t.Errorf("pomoc nie podąża za kursorem na starsze zdarzenie: %q", older)
	}
}

func hasContent(d Doc) bool {
	for _, s := range d.Sections {
		for _, row := range s.Rows {
			if strings.TrimSpace(row[0]) != "" || strings.TrimSpace(row[1]) != "" {
				return true
			}
		}
		for _, line := range s.Lines {
			if strings.TrimSpace(line) != "" {
				return true
			}
		}
		if strings.TrimSpace(s.Note) != "" {
			return true
		}
	}
	return false
}

func TestAgentHelpShowsRoleCardOrSaysWhyNot(t *testing.T) {
	m := modelWithData(t)
	m.panels = []Panel{{Kind: PanelAgents}}
	m.focused = 0

	if !strings.Contains(strings.Join(flatten(m.helpTarget().Explain()), " "), "Rola według karty") {
		t.Fatal("pomoc agenta nie ma sekcji o roli")
	}

	m.cards.set("agent-1", card{state: cardReady, text: "# Observer\n\nPilnuje, nie ingeruje."})
	ready := strings.Join(flatten(m.helpTarget().Explain()), " ")
	if !strings.Contains(ready, "Pilnuje, nie ingeruje.") {
		t.Errorf("pomoc nie pokazuje treści karty: %q", ready)
	}
	if strings.Contains(ready, "#") {
		t.Error("markdown przeciekł do legendy")
	}

	m.cards.set("agent-1", card{state: cardMissing})
	missing := strings.Join(flatten(m.helpTarget().Explain()), " ")
	m.cards.set("agent-1", card{state: cardFailed, err: "connection refused"})
	failed := strings.Join(flatten(m.helpTarget().Explain()), " ")

	if missing == failed {
		t.Error("brak karty i brak łączności wyglądają tak samo")
	}
	if !strings.Contains(failed, "connection refused") {
		t.Error("nieudane zapytanie nie podaje powodu")
	}
}
