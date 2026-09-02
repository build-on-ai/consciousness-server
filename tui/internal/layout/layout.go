package layout

import (
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
)

const (
	borderCost  = 2
	paddingCost = 2
)

type Rect struct {
	X, Y, W, H int
}

func (r Rect) Empty() bool { return r.W <= 0 || r.H <= 0 }

func (r Rect) Contains(x, y int) bool {
	return x >= r.X && x < r.X+r.W && y >= r.Y && y < r.Y+r.H
}

func (r Rect) Inset(n int) Rect {
	return Rect{X: r.X + n, Y: r.Y + n, W: r.W - 2*n, H: r.H - 2*n}
}

func Rows(r Rect, heights ...int) []Rect {
	out := make([]Rect, 0, len(heights))
	y, left := r.Y, r.H
	for i, h := range heights {
		if i == len(heights)-1 {
			h = left
		}
		if h > left {
			h = left
		}
		out = append(out, Rect{X: r.X, Y: y, W: r.W, H: h})
		y += h
		left -= h
	}
	return out
}

func Columns(r Rect, widths ...int) []Rect {
	out := make([]Rect, 0, len(widths))
	x, left := r.X, r.W
	for i, w := range widths {
		if i == len(widths)-1 {
			w = left
		}
		if w > left {
			w = left
		}
		out = append(out, Rect{X: x, Y: r.Y, W: w, H: r.H})
		x += w
		left -= w
	}
	return out
}

func Grid(r Rect, cols, rows int) []Rect {
	if cols < 1 {
		cols = 1
	}
	if rows < 1 {
		rows = 1
	}

	cells := make([]Rect, 0, cols*rows)
	rowRects := make([]Rect, rows)
	h := r.H / rows
	y, leftH := r.Y, r.H
	for i := range rowRects {
		hh := h
		if i == rows-1 {
			hh = leftH
		}
		rowRects[i] = Rect{X: r.X, Y: y, W: r.W, H: hh}
		y += hh
		leftH -= hh
	}

	w := r.W / cols
	for _, rr := range rowRects {
		x, leftW := rr.X, rr.W
		for c := 0; c < cols; c++ {
			ww := w
			if c == cols-1 {
				ww = leftW
			}
			cells = append(cells, Rect{X: x, Y: rr.Y, W: ww, H: rr.H})
			x += ww
			leftW -= ww
		}
	}
	return cells
}

func Fit(r Rect, count, minW, minH int) (cols, rows int) {
	if count < 1 {
		return 1, 1
	}
	cols = r.W / max(minW, 1)
	if cols < 1 {
		cols = 1
	}
	if cols > count {
		cols = count
	}

	rows = (count + cols - 1) / cols
	if maxRows := r.H / max(minH, 1); maxRows >= 1 && rows > maxRows {
		rows = maxRows
	}
	if rows < 1 {
		rows = 1
	}
	return cols, rows
}

func Fill(lines []string, w, h int) []string {
	flat := make([]string, 0, len(lines))
	for _, l := range lines {
		if strings.ContainsRune(l, '\n') {
			flat = append(flat, strings.Split(l, "\n")...)
			continue
		}
		flat = append(flat, l)
	}

	out := make([]string, 0, h)
	for i := 0; i < h; i++ {
		var line string
		if i < len(flat) {
			line = flat[i]
		}
		out = append(out, Pad(line, w))
	}
	return out
}

func Pad(s string, w int) string {
	if w <= 0 {
		return ""
	}
	width := lipgloss.Width(s)
	switch {
	case width == w:
		return s
	case width < w:
		return s + strings.Repeat(" ", w-width)
	default:
		return Truncate(s, w)
	}
}

func Truncate(s string, w int) string {
	if lipgloss.Width(s) <= w {
		return s
	}

	var b strings.Builder
	var shown int
	var inEscape bool

	for _, r := range s {
		if r == '\x1b' {
			inEscape = true
			b.WriteRune(r)
			continue
		}
		if inEscape {
			b.WriteRune(r)
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
				inEscape = false
			}
			continue
		}

		rw := lipgloss.Width(string(r))
		if shown+rw > w {
			break
		}
		b.WriteRune(r)
		shown += rw
	}

	b.WriteString("\x1b[0m")
	return Pad(b.String(), w)
}

func SliceCells(s string, from, to int) string {
	if to <= from || to <= 0 {
		return ""
	}
	if from < 0 {
		from = 0
	}

	var b strings.Builder
	var shown int
	var inEscape bool

	for _, r := range s {
		if r == '\x1b' {
			inEscape = true
			b.WriteRune(r)
			continue
		}
		if inEscape {
			b.WriteRune(r)
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
				inEscape = false
			}
			continue
		}
		if shown >= to {
			break
		}

		rw := lipgloss.Width(string(r))
		switch {
		case shown >= from:
			if shown+rw > to {
				b.WriteString(strings.Repeat(" ", to-shown))
				shown = to
				continue
			}
			b.WriteRune(r)
		case shown+rw > from:
			b.WriteString(strings.Repeat(" ", shown+rw-from))
		}
		shown += rw
	}

	out := b.String()
	if lipgloss.Width(out) == 0 {
		return ""
	}
	return out + "\x1b[0m"
}

func Remaining(total int, pieces ...string) int {
	left := total
	for _, s := range pieces {
		left -= lipgloss.Width(s)
	}
	if left < 0 {
		return 0
	}
	return left
}

func flatten(lines []string) []string {
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		if strings.ContainsRune(l, '\n') {
			out = append(out, strings.Split(l, "\n")...)
			continue
		}
		out = append(out, l)
	}
	return out
}

func Scrollbar(body []string, offset, total, visible int, c color.Color) []string {
	if visible <= 0 || total <= visible {
		return body
	}

	thumb := visible * visible / total
	if thumb < 1 {
		thumb = 1
	}
	span := visible - thumb
	pos := 0
	if maxOff := total - visible; maxOff > 0 && span > 0 {
		pos = offset * span / maxOff
	}

	track := lipgloss.NewStyle().Foreground(c)
	for i := range body {
		mark := track.Render("│")
		if i >= pos && i < pos+thumb {
			mark = track.Render("█")
		}
		body[i] = trimRight(body[i], 1) + mark
	}
	return body
}

func trimRight(s string, n int) string {
	w := lipgloss.Width(s)
	if w <= n {
		return ""
	}
	return Truncate(s, w-n)
}
