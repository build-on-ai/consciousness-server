package layout

import (
	"fmt"
	"strings"
	"testing"

	"charm.land/lipgloss/v2"
)

func TestFillIsExactRegardlessOfContent(t *testing.T) {
	cases := []struct {
		name  string
		lines []string
	}{
		{"pusto", nil},
		{"krócej niż miejsce", []string{"a", "b"}},
		{"dokładnie", []string{"a", "b", "c", "d", "e"}},
		{"dłużej niż miejsce", []string{"a", "b", "c", "d", "e", "f", "g", "h"}},
		{"za szerokie", []string{strings.Repeat("x", 40)}},
		{"kolorowe", []string{lipgloss.NewStyle().Foreground(lipgloss.Color("#ff0000")).Render("czerwone")}},
	}

	const w, h = 20, 5
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out := Fill(c.lines, w, h)
			if len(out) != h {
				t.Fatalf("%d wierszy zamiast %d", len(out), h)
			}
			for i, line := range out {
				if got := lipgloss.Width(line); got != w {
					t.Errorf("wiersz %d ma szerokość %d zamiast %d", i, got, w)
				}
			}
		})
	}
}

func TestTruncateClosesStyling(t *testing.T) {
	styled := lipgloss.NewStyle().Foreground(lipgloss.Color("#00ff00")).Render(strings.Repeat("z", 50))
	out := Pad(styled, 10)

	if got := lipgloss.Width(out); got != 10 {
		t.Errorf("szerokość %d zamiast 10", got)
	}
	if !strings.Contains(out, "\x1b[0m") {
		t.Error("obcięty tekst nie zamyka stylu — kolor przeciekłby dalej")
	}
}

func TestBoxOutputIsExact(t *testing.T) {
	long := make([]string, 40)
	for i := range long {
		long[i] = fmt.Sprintf("wiersz %d z treścią, która nie ma prawa rozepchać ramki", i)
	}

	for _, r := range []Rect{
		{W: 40, H: 10}, {W: 20, H: 5}, {W: 80, H: 24},
		{W: 6, H: 3}, {W: 3, H: 2},
	} {
		t.Run(fmt.Sprintf("%dx%d", r.W, r.H), func(t *testing.T) {
			b := Box{Title: "Tytuł", Icon: "◈", Footer: "stopka w krawędzi", Border: lipgloss.Color("#444444")}
			out := b.Render(r, long)

			if len(out) != r.H {
				t.Fatalf("%d wierszy zamiast %d", len(out), r.H)
			}
			for i, line := range out {
				if got := lipgloss.Width(line); got != r.W {
					t.Errorf("wiersz %d ma szerokość %d zamiast %d", i, got, r.W)
				}
			}
		})
	}
}

func TestPopupKeepsBackgroundOnBothSides(t *testing.T) {
	screen := Rect{W: 100, H: 30}
	under := make([]string, screen.H)
	for i := range under {
		under[i] = strings.Repeat("░", screen.W)
	}

	p := Popup{Title: "Legenda", Border: lipgloss.Color("#444444")}
	out := p.Render(screen, under, []string{"treść"})

	if len(out) != screen.H {
		t.Fatalf("%d wierszy zamiast %d", len(out), screen.H)
	}
	for i, line := range out {
		if got := lipgloss.Width(line); got != screen.W {
			t.Fatalf("wiersz %d ma szerokość %d zamiast %d", i, got, screen.W)
		}
	}

	area := p.Area(screen)
	middle := out[area.Y+area.H/2]

	if left := SliceCells(middle, 0, area.X); !strings.Contains(left, "░") {
		t.Errorf("lewy margines stracił tło: %q", left)
	}
	if right := SliceCells(middle, area.X+area.W, screen.W); !strings.Contains(right, "░") {
		t.Errorf("prawy margines stracił tło: %q", right)
	}
}

func TestSliceCellsCountsCellsNotBytes(t *testing.T) {
	plain := "abcdefghij"
	if got := SliceCells(plain, 3, 6); lipgloss.Width(got) != 3 {
		t.Errorf("szerokość %d zamiast 3 dla %q", lipgloss.Width(got), got)
	}

	styled := lipgloss.NewStyle().Foreground(lipgloss.Color("#00ff00")).Render("zielone") + "reszta"
	tail := SliceCells(styled, 7, 13)
	if lipgloss.Width(tail) != 6 {
		t.Errorf("szerokość ogona %d zamiast 6", lipgloss.Width(tail))
	}
	if strings.Contains(tail, "zielone") {
		t.Errorf("ogon zawiera treść sprzed cięcia: %q", tail)
	}

	if got := SliceCells(plain, 20, 30); got != "" {
		t.Errorf("poza końcem linii zwrócono %q zamiast pustki", got)
	}
}

func TestGridCoversWholeArea(t *testing.T) {
	r := Rect{X: 0, Y: 0, W: 101, H: 37}

	for _, dims := range [][2]int{{1, 1}, {2, 2}, {3, 3}, {1, 2}, {4, 1}} {
		cells := Grid(r, dims[0], dims[1])
		if len(cells) != dims[0]*dims[1] {
			t.Fatalf("%dx%d dało %d komórek", dims[0], dims[1], len(cells))
		}

		var area int
		for _, c := range cells {
			area += c.W * c.H
		}
		if area != r.W*r.H {
			t.Errorf("%dx%d pokrywa %d z %d komórek ekranu", dims[0], dims[1], area, r.W*r.H)
		}
	}
}

func TestFitNeverGoesBelowReadable(t *testing.T) {
	const minW, minH = 40, 8

	for _, tc := range []struct{ w, h, count int }{
		{200, 50, 9}, {120, 30, 9}, {80, 24, 4}, {60, 16, 4}, {50, 10, 2},
	} {
		cols, rows := Fit(Rect{W: tc.w, H: tc.h}, tc.count, minW, minH)
		cells := Grid(Rect{W: tc.w, H: tc.h}, cols, rows)

		for _, c := range cells {
			if c.W < minW && cols > 1 {
				t.Errorf("przy %dx%d dla %d kafli wyszła komórka %d szeroka, poniżej progu %d",
					tc.w, tc.h, tc.count, c.W, minW)
				break
			}
		}
	}
}

func TestEveryCellBelongsToExactlyOnePanel(t *testing.T) {
	r := Rect{X: 0, Y: 0, W: 61, H: 17}
	cells := Grid(r, 3, 2)

	for y := r.Y; y < r.Y+r.H; y++ {
		for x := r.X; x < r.X+r.W; x++ {
			var owners int
			for _, c := range cells {
				if c.Contains(x, y) {
					owners++
				}
			}
			if owners != 1 {
				t.Fatalf("komórka (%d,%d) należy do %d paneli, powinna do jednego", x, y, owners)
			}
		}
	}
}
