package layout

import (
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
)

type Box struct {
	Title  string
	Icon   string
	Footer string

	Border  color.Color
	Focused bool

	Scroll int
}

func (b Box) Inner(r Rect) Rect {
	in := Rect{
		X: r.X + borderCost/2 + paddingCost/2,
		Y: r.Y + borderCost/2,
		W: r.W - borderCost - paddingCost,
		H: r.H - borderCost,
	}
	if b.Title != "" {
		in.Y += 2
		in.H -= 2
	}
	if in.W < 0 {
		in.W = 0
	}
	if in.H < 0 {
		in.H = 0
	}
	return in
}

func (b Box) Render(r Rect, content []string) []string {
	if r.Empty() {
		return nil
	}
	if r.W < 4 || r.H < 3 {
		return Fill(content, r.W, r.H)
	}

	inner := b.Inner(r)

	content = Fill(content, inner.W, max(len(flatten(content)), inner.H))

	offset := b.Scroll
	if maxOff := len(content) - inner.H; offset > maxOff {
		offset = maxOff
	}
	if offset < 0 {
		offset = 0
	}

	visible := content
	if offset < len(content) {
		visible = content[offset:]
	}

	view := Fill(visible, inner.W, inner.H)
	if len(content) > inner.H {
		view = Scrollbar(view, offset, len(content), inner.H, b.Border)
	}

	body := make([]string, 0, r.H-borderCost)
	if b.Title != "" {
		head := b.Title
		if b.Icon != "" {
			head = b.Icon + " " + b.Title
		}
		body = append(body, head, "")
	}
	body = append(body, view...)
	body = Fill(body, inner.W, r.H-borderCost)

	stroke := lipgloss.NewStyle().Foreground(b.Border)
	horizontal := strings.Repeat("─", r.W-2)

	out := make([]string, 0, r.H)
	out = append(out, stroke.Render("╭"+horizontal+"╮"))

	for _, line := range body {
		out = append(out,
			stroke.Render("│")+" "+Pad(line, r.W-4)+" "+stroke.Render("│"))
	}

	out = append(out, b.bottom(r.W, horizontal, stroke))
	return Fill(out, r.W, r.H)
}

func (b Box) bottom(w int, horizontal string, stroke lipgloss.Style) string {
	if b.Footer == "" {
		return stroke.Render("╰" + horizontal + "╯")
	}

	label := " " + b.Footer + " "
	labelWidth := lipgloss.Width(label)
	if labelWidth+4 > w {
		return stroke.Render("╰" + horizontal + "╯")
	}

	tail := w - labelWidth - 3
	if tail < 0 {
		tail = 0
	}
	return stroke.Render("╰─") + label + stroke.Render(strings.Repeat("─", tail)+"╯")
}
