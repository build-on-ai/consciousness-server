package internal

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/build-on-ai/consciousness-server/tui/internal/api"
)

func TestViewAlwaysFillsExactlyTheTerminal(t *testing.T) {
	sizes := []struct{ w, h int }{
		{60, 16},
		{80, 24},
		{80, 20},
		{100, 26},
		{120, 30},
		{132, 34},
		{160, 40},
		{200, 50},
		{220, 60},
		{90, 18},
		{70, 45},
	}

	c := api.New("http://127.0.0.1:1", "http://127.0.0.1:2")

	for _, size := range sizes {
		t.Run(fmt.Sprintf("%dx%d", size.w, size.h), func(t *testing.T) {
			m := NewModel(c, api.NewStream(c))

			updated, _ := m.Update(tea.WindowSizeMsg{Width: size.w, Height: size.h})
			m = updated.(*Model)

			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			updated, _ = m.Update(snapshotMsg(c.Fetch(ctx)))
			m = updated.(*Model)

			out := m.View().Content
			lines := strings.Split(out, "\n")

			if got := len(lines); got != size.h {
				t.Errorf("wysokość %d wierszy, terminal ma %d — nadmiar przewija ekran i wypycha pasek stanu",
					got, size.h)
			}

			for i, line := range lines {
				if w := lipgloss.Width(line); w > size.w {
					t.Errorf("wiersz %d ma szerokość %d przy terminalu %d — zawinie się i rozjedzie kolumny",
						i, w, size.w)
					break
				}
			}
		})
	}
}

func TestLegendFitsTheTerminal(t *testing.T) {
	c := api.New("http://127.0.0.1:1", "http://127.0.0.1:2")

	for _, size := range []struct{ w, h int }{{80, 24}, {100, 30}, {120, 20}, {70, 18}} {
		t.Run(fmt.Sprintf("%dx%d", size.w, size.h), func(t *testing.T) {
			m := NewModel(c, api.NewStream(c))
			updated, _ := m.Update(tea.WindowSizeMsg{Width: size.w, Height: size.h})
			m = updated.(*Model)
			m.showHelp = true

			lines := strings.Split(m.View().Content, "\n")
			if got := len(lines); got != size.h {
				t.Errorf("legenda daje %d wierszy przy terminalu %d", got, size.h)
			}
			for i, line := range lines {
				if w := lipgloss.Width(line); w > size.w {
					t.Errorf("wiersz %d legendy ma szerokość %d przy terminalu %d", i, w, size.w)
					break
				}
			}
		})
	}
}
