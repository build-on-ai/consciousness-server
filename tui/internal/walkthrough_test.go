package internal

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/build-on-ai/consciousness-server/tui/internal/api"
)

func TestWalkthrough(t *testing.T) {
	if os.Getenv("BOA_WALK") == "" {
		t.Skip("ustaw BOA_WALK=1, żeby obejrzeć przebieg")
	}

	core := envOr("BOA_CORE", "http://127.0.0.1:3032")
	machines := envOr("BOA_MACHINES", "http://127.0.0.1:3038")

	c := api.New(core, machines)
	s := api.NewStream(c)
	go s.Run("PRZEBIEG")
	defer s.Stop()

	m := NewModel(c, s)
	m = send(m, tea.WindowSizeMsg{Width: 118, Height: 32})

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	m = send(m, snapshotMsg(c.Fetch(ctx)))
	time.Sleep(1200 * time.Millisecond)
	m = send(m, tickMsg(time.Now()))

	steps := []struct {
		what string
		do   func(*Model) *Model
	}{
		{"start — przegląd i agenci obok siebie", nil},

		{"3 — otwieram serwisy", func(m *Model) *Model { return press(m, "3") }},
		{"5 — otwieram endpointy (czwarty panel)", func(m *Model) *Model { return press(m, "5") }},

		{"tab tab — przechodzę na endpointy", func(m *Model) *Model {
			return press(press(m, "tab"), "tab")
		}},
		{"↓ ×25 — schodzę w dół listy, panel ma się przewinąć", func(m *Model) *Model {
			for i := 0; i < 25; i++ {
				m = press(m, "down")
			}
			return m
		}},

		{"? — pytam o zaznaczony endpoint", func(m *Model) *Model { return press(m, "?") }},
		{"← — wychodzę poziom wyżej, do legendy panelu", func(m *Model) *Model { return press(m, "left") }},
		{"← — jeszcze wyżej, do legendy ogólnej", func(m *Model) *Model { return press(m, "left") }},
		{"↓ ×6 — przewijam legendę", func(m *Model) *Model {
			for i := 0; i < 6; i++ {
				m = press(m, "down")
			}
			return m
		}},
		{"y — kopiuję treść", func(m *Model) *Model { return press(m, "y") }},
		{"? — zamykam", func(m *Model) *Model { return press(m, "?") }},

		{"zwężam okno do 82×24 — panele mają się dopasować", func(m *Model) *Model {
			return send(m, tea.WindowSizeMsg{Width: 82, Height: 24})
		}},
		{"rozszerzam do 150×38", func(m *Model) *Model {
			return send(m, tea.WindowSizeMsg{Width: 150, Height: 38})
		}},

		{"m — oddaję mysz terminalowi", func(m *Model) *Model { return press(m, "m") }},
	}

	for i, step := range steps {
		if step.do != nil {
			m = step.do(m)
		}
		fmt.Printf("\n\n═══ %d. %s ═══\n", i+1, step.what)
		fmt.Println(m.View().Content)

		checkShape(t, m, step.what)
	}
}

func checkShape(t *testing.T, m *Model, step string) {
	t.Helper()

	lines := strings.Split(m.View().Content, "\n")
	if len(lines) != m.height {
		t.Errorf("po kroku %q widok ma %d wierszy, terminal %d", step, len(lines), m.height)
	}
	for i, l := range lines {
		if w := lipgloss.Width(l); w > m.width {
			t.Errorf("po kroku %q wiersz %d ma %d znaków przy szerokości %d", step, i, w, m.width)
			break
		}
	}
}

func send(m *Model, msg tea.Msg) *Model {
	updated, _ := m.Update(msg)
	return updated.(*Model)
}

func press(m *Model, key string) *Model {
	return send(m, keyPress(key))
}
