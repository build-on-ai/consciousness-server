package theme

import (
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
)

var (
	Base    = lipgloss.Color("#001729")
	Surface = lipgloss.Color("#0b2438")
	Line    = lipgloss.Color("#1c3b55")
	Accent  = lipgloss.Color("#4a8ab8")
	Text    = lipgloss.Color("#b8ccdb")
	Muted   = lipgloss.Color("#5b7a92")

	OK      = lipgloss.Color("#6ea9c9")
	Warn    = lipgloss.Color("#9fc4d8")
	Bad     = lipgloss.Color("#c96a6a")
	Unknown = lipgloss.Color("#7b8fa3")
)

var (
	Panel = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(Line).
		Padding(0, 1)

	PanelFocused = Panel.
			BorderForeground(Accent)

	Sidebar = lipgloss.NewStyle().Padding(0, 1)

	Brand = lipgloss.NewStyle().Foreground(Accent).Bold(true)

	Section = lipgloss.NewStyle().Foreground(Muted)

	Rule = lipgloss.NewStyle().Foreground(Line)

	Title = lipgloss.NewStyle().
		Foreground(Accent).
		Bold(true)

	TitleDim = lipgloss.NewStyle().
			Foreground(Muted)

	Label = lipgloss.NewStyle().Foreground(Muted)

	Value = lipgloss.NewStyle().Foreground(Text)

	Selected = lipgloss.NewStyle().
			Foreground(Base).
			Background(Accent).
			Bold(true)

	Header = lipgloss.NewStyle().
		Foreground(Text).
		Bold(true)

	Footer = lipgloss.NewStyle().
		Foreground(Muted)

	Key = lipgloss.NewStyle().
		Foreground(Accent).
		Bold(true)
)

type severity int

const (
	sevOK severity = iota
	sevWarn
	sevBad
	sevUnknown
)

func classify(state string) severity {
	switch state {
	case "active", "ok", "healthy", "PRACUJE", "GOTOWY", "running", "up",
		"DONE":
		return sevOK
	case "warning", "WARN", "BRAK SESJI", "degraded", "stale",
		"BEZ MELDUNKU",
		"IN_PROGRESS", "PENDING":
		return sevWarn
	case "inactive", "failed", "ERROR", "OFFLINE", "down", "critical",
		"FAILED", "CANCELLED",
		"unreachable", "timeout", "misconfigured":
		return sevBad
	default:
		return sevUnknown
	}
}

func StatusStyle(state string) lipgloss.Style {
	switch classify(state) {
	case sevOK:
		return lipgloss.NewStyle().Foreground(OK)
	case sevWarn:
		return lipgloss.NewStyle().Foreground(Warn)
	case sevBad:
		return lipgloss.NewStyle().Foreground(Bad)
	default:
		return lipgloss.NewStyle().Foreground(Unknown)
	}
}

func StatusMark(state string) string {
	switch classify(state) {
	case sevOK:
		return "●"
	case sevWarn:
		return "▲"
	case sevBad:
		return "✕"
	default:
		return "?"
	}
}

func Status(state string) string {
	return StatusStyle(state).Render(StatusMark(state) + " " + state)
}

func Lamp(on bool, colour color.Color) string {
	if on {
		return lipgloss.NewStyle().Foreground(colour).Render("●")
	}
	return lipgloss.NewStyle().Foreground(Line).Render("○")
}

var Icons = map[string]string{
	"overview":  "◇",
	"agents":    "◈",
	"services":  "▣",
	"events":    "≋",
	"endpoints": "⇄",
	"tasks":     "▤",
	"graph":     "⇶",
}

func Icon(kind string, open bool) string {
	glyph, ok := Icons[kind]
	if !ok {
		glyph = "·"
	}
	if open {
		return lipgloss.NewStyle().Foreground(Accent).Render(glyph)
	}
	return lipgloss.NewStyle().Foreground(Muted).Render(glyph)
}

func SectionRule(label string, width int) string {
	head := Section.Render(label)
	used := len([]rune(label)) + 1
	if used >= width {
		return head
	}
	return head + " " + Rule.Render(strings.Repeat("─", width-used-1))
}
