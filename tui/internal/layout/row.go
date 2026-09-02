package layout

import (
	"strings"

	"charm.land/lipgloss/v2"
)

type Col struct {
	Text  string
	Width int
	Right bool
}

func Row(width int, cols ...Col) string {
	if width <= 0 || len(cols) == 0 {
		return ""
	}

	fixed, flexible := 0, -1
	for i, c := range cols {
		if c.Width > 0 {
			fixed += c.Width
			continue
		}
		if flexible < 0 {
			flexible = i
		}
	}

	rest := width - fixed
	if rest < 0 {
		rest = 0
	}

	var b strings.Builder
	for i, c := range cols {
		w := c.Width
		if i == flexible {
			w = rest
		} else if c.Width == 0 {
			w = 0
		}
		if w <= 0 {
			continue
		}

		if c.Right {
			b.WriteString(padLeft(c.Text, w))
			continue
		}
		b.WriteString(Pad(Truncate(c.Text, w), w))
	}

	return Pad(b.String(), width)
}

func padLeft(s string, w int) string {
	t := Truncate(s, w)
	gap := w - lipgloss.Width(t)
	if gap <= 0 {
		return t
	}
	return strings.Repeat(" ", gap) + t
}
