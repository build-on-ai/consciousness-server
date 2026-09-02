package layout

import (
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
)

type Popup struct {
	Title  string
	Icon   string
	Footer string
	Border color.Color

	Offset int
}

func (p Popup) Area(screen Rect) Rect {
	w := screen.W * 8 / 10
	h := screen.H * 8 / 10

	if w > screen.W-4 {
		w = screen.W - 4
	}
	if h > screen.H-2 {
		h = screen.H - 2
	}
	if w < 20 {
		w = screen.W
	}
	if h < 5 {
		h = screen.H
	}

	return Rect{
		X: screen.X + (screen.W-w)/2,
		Y: screen.Y + (screen.H-h)/2,
		W: w,
		H: h,
	}
}

func (p Popup) MaxOffset(area Rect, contentLines int) int {
	visible := Box{Title: p.Title}.Inner(area).H
	if contentLines <= visible {
		return 0
	}
	return contentLines - visible
}

func (p Popup) Render(screen Rect, under []string, content []string) []string {
	area := p.Area(screen)

	panel := Box{
		Title:   p.Title,
		Icon:    p.Icon,
		Footer:  p.Footer,
		Border:  p.Border,
		Focused: true,
		Scroll:  p.Offset,
	}.Render(area, content)

	out := Fill(under, screen.W, screen.H)
	for i, line := range panel {
		y := area.Y + i
		if y < 0 || y >= len(out) {
			continue
		}
		out[y] = overlay(out[y], line, area.X, screen.W)
	}
	return out
}

func overlay(base, top string, x, width int) string {
	left := Truncate(base, x)
	if lipgloss.Width(left) < x {
		left += strings.Repeat(" ", x-lipgloss.Width(left))
	}

	right := SliceCells(base, x+lipgloss.Width(top), width)

	return Pad(left+top+right, width)
}
