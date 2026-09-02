package internal

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/build-on-ai/consciousness-server/tui/internal/api"
	"github.com/build-on-ai/consciousness-server/tui/internal/layout"
	"github.com/build-on-ai/consciousness-server/tui/internal/theme"
)

const (
	sidebarWidth = 22
	headerHeight = 1
	statusHeight = 1
	footerHeight = 1
)

func (m *Model) View() tea.View {
	if m.quitting {
		return tea.NewView("")
	}
	if m.width < 60 || m.height < 16 {
		v := tea.NewView(theme.Label.Render("Okno za małe. Potrzeba co najmniej 60x16."))
		v.AltScreen = true
		return v
	}

	if m.showHelp {
		v := tea.NewView(m.helpOverlay())
		v.AltScreen = true
		v.MouseMode = m.mouseMode()
		v.BackgroundColor = theme.Base
		return v
	}

	out := strings.Join(m.compose(), "\n")

	v := tea.NewView(out)
	v.AltScreen = true
	v.MouseMode = m.mouseMode()
	v.BackgroundColor = theme.Base
	return v
}

func (m *Model) compose() []string {
	screen := layout.Rect{W: m.width, H: m.height}

	bands := layout.Rows(screen, headerHeight, screen.H-headerHeight-statusHeight-footerHeight, statusHeight, footerHeight)
	header, body, status, footer := bands[0], bands[1], bands[2], bands[3]

	cols := layout.Columns(body, sidebarWidth, body.W-sidebarWidth)
	sidebar, panels := cols[0], cols[1]

	out := make([]string, 0, m.height)
	out = append(out, layout.Fill([]string{m.renderHeader()}, header.W, header.H)...)

	left := layout.Fill(m.renderSidebar(sidebar), sidebar.W, sidebar.H)
	right := m.renderPanels(panels)
	for i := 0; i < body.H; i++ {
		out = append(out, left[i]+right[i])
	}

	out = append(out, layout.Fill([]string{m.renderStatusBar()}, status.W, status.H)...)
	out = append(out, layout.Fill([]string{m.renderFooter()}, footer.W, footer.H)...)

	return layout.Fill(out, m.width, m.height)
}

func (m *Model) renderHeader() string {
	st := m.streamState
	var link string
	switch {
	case st.Connected:
		link = theme.StatusStyle("ok").Render("● połączony")
	case st.Since.IsZero():
		link = theme.StatusStyle("unknown").Render("○ łączenie")
	default:
		link = theme.StatusStyle("down").Render(fmt.Sprintf("✕ rozłączony od %s", age(st.Since)))
	}

	rate := theme.Label.Render(fmt.Sprintf("%.0f zdarz/min", st.PerMinute))
	seq := theme.Label.Render(fmt.Sprintf("seq %d", st.LatestSeq))

	parts := []string{link, rate, seq}
	if st.Gapped {
		parts = append(parts, theme.StatusStyle("warning").Render("⚠ luka w strumieniu"))
	}
	if !m.lastFetch.IsZero() {
		if n, oldest := m.snap.Stale(time.Now(), staleAfter); n > 0 {
			parts = append(parts, theme.StatusStyle("warning").Render(
				fmt.Sprintf("⚠ %d źr. nieświeże, do %s", n, dur(int(oldest.Seconds())))))
		} else {
			parts = append(parts, theme.Label.Render("dane "+age(m.lastFetch)))
		}
	}

	line := strings.Join(parts, theme.Label.Render(" · "))
	return lipgloss.NewStyle().Width(m.width).Render(line)
}

func (m *Model) renderSidebar(r layout.Rect) []string {
	open := map[PanelKind]bool{}
	for _, p := range m.panels {
		open[p.Kind] = true
	}

	inner := r.Inset(1).W

	var b strings.Builder
	b.WriteString(theme.Brand.Render("▍BuildOnAI") + "\n")
	rev, stamp := buildStamp()
	b.WriteString(theme.Label.Render(" "+layout.Truncate(rev, inner)) + "\n")
	if stamp != "" {
		b.WriteString(theme.Label.Render(" "+layout.Truncate(stamp, inner)) + "\n")
	}
	b.WriteString("\n")

	for _, v := range AllPanels {
		isOpen := open[v.Kind()]
		label := v.Title()
		if isOpen {
			label = theme.Value.Render(label)
		} else {
			label = theme.Label.Render(label)
		}
		b.WriteString(fmt.Sprintf("%s %s %s\n",
			theme.Icon(v.IconName(), isOpen), theme.Key.Render(v.Key()), label))
	}

	b.WriteString("\n" + theme.SectionRule("Pokrycie", inner) + "\n")
	if m.snap.Routes != nil {
		b.WriteString(sideStat("endpointy", fmt.Sprint(m.snap.Routes.Total), inner))
		b.WriteString(sideStat("z param.", fmt.Sprint(m.snap.Routes.Parameterised), inner))
	} else {
		b.WriteString(theme.Label.Render("endpointy ") + theme.StatusStyle("unknown").Render("brak") + "\n")
	}
	if m.snap.Graph != nil {
		b.WriteString(sideStat("węzły", fmt.Sprint(m.snap.Graph.TotalNodes), inner))
	}

	b.WriteString("\n" + theme.SectionRule("Strumień", inner) + "\n")
	if m.snap.Stats != nil {
		b.WriteString(sideStat("kanały", fmt.Sprint(len(m.snap.Stats.Channels)), inner))
		b.WriteString(sideStat("wysłane", fmt.Sprint(m.snap.Stats.TotalEmitted), inner))
		b.WriteString(sideStat("klienci", fmt.Sprint(m.snap.Stats.WSClients), inner))
	} else {
		b.WriteString(theme.Label.Render("kanały ") + theme.StatusStyle("unknown").Render("brak") + "\n")
	}

	lines := strings.Split(b.String(), "\n")
	for i, l := range lines {
		lines[i] = " " + l
	}
	return layout.Fill(lines, r.W, r.H)
}

func sideStat(label, value string, width int) string {
	return theme.Label.Render(layout.Row(width-len(value),
		layout.Col{Text: label})) + theme.Value.Render(value) + "\n"
}

func (m *Model) renderPanels(r layout.Rect) []string {
	if len(m.panels) == 0 {
		return layout.Fill(nil, r.W, r.H)
	}

	widths := make([]int, len(m.panels))
	each := r.W / len(m.panels)
	for i := range widths {
		widths[i] = each
	}
	cells := layout.Columns(r, widths...)

	m.geom = make([]panelGeom, len(m.panels))

	blocks := make([][]string, len(m.panels))
	for i, p := range m.panels {
		blocks[i], m.geom[i] = m.renderPanel(p, i == m.focused, cells[i])
	}

	out := make([]string, r.H)
	for row := 0; row < r.H; row++ {
		var line strings.Builder
		for _, b := range blocks {
			line.WriteString(b[row])
		}
		out[row] = line.String()
	}
	return out
}

func (m *Model) renderPanel(p Panel, focused bool, r layout.Rect) ([]string, panelGeom) {
	border := theme.Line
	if focused {
		border = theme.Accent
	}

	box := layout.Box{
		Title:   p.Kind.Title(),
		Icon:    theme.Icon(p.Kind.IconName(), focused),
		Footer:  m.panelFooter(p),
		Border:  border,
		Focused: focused,
	}
	view := viewFor(p.Kind)
	pre := view.Preamble(m)
	box.Scroll = scrollFor(p.Cursor+pre, box.Inner(r).H, m.rowCount(p.Kind)+pre)
	if focused {
		box.Title = theme.Title.Render(box.Title)
	} else {
		box.Title = theme.TitleDim.Render(box.Title)
	}

	inner := box.Inner(r)
	content := view.Render(m, p, inner)

	return box.Render(r, strings.Split(content, "\n")),
		panelGeom{Outer: r, Inner: inner, Scroll: box.Scroll, Preamble: pre}
}

func (m *Model) panelFooter(p Panel) string {
	if f := viewFor(p.Kind).Footer(m, p); f != "" {
		return f
	}
	if n := m.rowCount(p.Kind); n > 0 {
		return fmt.Sprintf("%d/%d", p.Cursor+1, n)
	}
	return ""
}

func (m *Model) renderOverview(width, rows int) string {
	var b strings.Builder

	if h := m.snap.Health; h != nil {
		b.WriteString(theme.Label.Render(" rdzeń     ") +
			theme.Status(h.Status) +
			theme.Label.Render(" v"+h.Version) + "\n")
		b.WriteString(kv("działa", dur(h.Uptime)) + "\n")

		for _, dep := range []struct{ name, state string }{
			{"redis", h.Redis},
			{"semantic", h.SemanticSearch},
		} {
			if dep.state == "" {
				continue
			}
			line := theme.Label.Render(" "+layout.Pad(dep.name, 10)) + theme.Status(dep.state)
			if dep.name == "redis" && h.RedisDownSeconds > 0 {
				line += theme.Label.Render(" od " + dur(h.RedisDownSeconds))
			}
			b.WriteString(line + "\n")
		}
		b.WriteString("\n")

		b.WriteString(kv("agenci", fmt.Sprint(h.Memory.Agents)))
		b.WriteString(kv("zadania", fmt.Sprint(h.Memory.Tasks)))
		b.WriteString(kv("logi", fmt.Sprint(h.Memory.Logs)))
		b.WriteString(kv("notatki", fmt.Sprint(h.Memory.Notes)))
		b.WriteString(kv("czat", fmt.Sprint(h.Memory.ChatMessages)))
	} else {
		b.WriteString(theme.StatusStyle("unknown").Render("rdzeń: brak źródła") + "\n")
	}

	b.WriteString("\n" + theme.TitleDim.Render("Źródła") + "\n")
	for _, s := range api.SourceNames() {
		label := theme.Label.Render(" " + layout.Pad(s, 9))

		switch m.snap.SourceState(s) {
		case "down":
			reason := m.snap.Errors[s]
			if a, known := m.snap.AgeOf(s, time.Now()); known {
				reason = "dane sprzed " + dur(int(a.Seconds())) + " · " + reason
			}
			prefix := " " + layout.Pad(s, 9) + theme.StatusMark("down") + " "
			b.WriteString(label + theme.StatusStyle("down").Render(theme.StatusMark("down")+" "+
				layout.Truncate(reason, layout.Remaining(width, prefix))) + "\n")
		case "pending":
			b.WriteString(label + theme.StatusStyle("unknown").Render(
				theme.StatusMark("unknown")+" jeszcze nie sprawdzone") + "\n")
		default:
			b.WriteString(label + theme.Status("ok") + "\n")
		}
	}
	return b.String()
}

func (m *Model) mouseMode() tea.MouseMode {
	if m.mouseOff {
		return tea.MouseModeNone
	}
	return tea.MouseModeCellMotion
}

func (m *Model) renderStatusBar() string {
	var parts []string

	if m.flash != "" && time.Since(m.flashTime) < 4*time.Second {
		parts = append(parts, theme.StatusStyle("ok").Render(m.flash))
	}
	if m.mouseOff && !strings.Contains(m.flash, "mysz") {
		parts = append(parts, theme.StatusStyle("warning").Render("mysz wyłączona"))
	}

	if m.fetching {
		parts = append(parts, theme.Label.Render("odświeżanie…"))
	} else if !m.lastFetch.IsZero() {
		parts = append(parts, theme.Label.Render("odczyt "+age(m.lastFetch)))
	}

	if m.snap.Stats != nil {
		parts = append(parts, theme.Label.Render(fmt.Sprintf("klienci WS %d", m.snap.Stats.WSClients)))
		var silent []string
		for _, ch := range m.snap.Stats.Channels {
			if m.snap.Stats.BufferedByChan[ch] == 0 {
				silent = append(silent, ch)
			}
		}
		if len(silent) > 0 {
			parts = append(parts, theme.StatusStyle("warning").Render("nieme kanały: "+strings.Join(silent, ",")))
		}
	}

	if n := len(m.snap.Errors); n > 0 {
		parts = append(parts, theme.StatusStyle("down").Render(fmt.Sprintf("źródła bez odpowiedzi: %d", n)))
	}

	line := " " + strings.Join(parts, theme.Label.Render(" · "))
	return lipgloss.NewStyle().Width(m.width).Render(line)
}

func (m *Model) renderFooter() string {
	keys := []struct{ k, d string }{
		{"tab", "panel"}, {"1-7", "otwórz"}, {"w", "zamknij"},
		{"↑↓", "wybór"}, {"r", "odśwież"}, {"q", "wyjście"},
	}
	var parts []string
	for _, k := range keys {
		parts = append(parts, theme.Key.Render(k.k)+theme.Footer.Render(" "+k.d))
	}
	return lipgloss.NewStyle().Width(m.width).Render(" " + strings.Join(parts, theme.Footer.Render(" · ")))
}

func kv(k, v string) string {
	return theme.Label.Render(" "+layout.Pad(k, 10)) + theme.Value.Render(v) + "\n"
}

const staleAfter = 15 * time.Second

func age(t time.Time) string {
	if t.IsZero() {
		return "nigdy"
	}
	d := time.Since(t)
	switch {
	case d < 2*time.Second:
		return "teraz"
	case d < time.Minute:
		return fmt.Sprintf("%ds temu", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dmin temu", int(d.Minutes()))
	default:
		return fmt.Sprintf("%dh temu", int(d.Hours()))
	}
}

func relTime(iso string) string {
	if iso == "" {
		return "brak"
	}
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return iso
	}
	return age(t)
}

func dur(seconds int) string {
	d := time.Duration(seconds) * time.Second
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", seconds)
	case d < time.Hour:
		return fmt.Sprintf("%dmin", int(d.Minutes()))
	default:
		return fmt.Sprintf("%dh%dmin", int(d.Hours()), int(d.Minutes())%60)
	}
}

func scrollFor(cursor, visible, total int) int {
	if visible <= 0 || total <= visible {
		return 0
	}
	if cursor < visible-2 {
		return 0
	}
	off := cursor - visible + 3
	if maxOff := total - visible; off > maxOff {
		off = maxOff
	}
	if off < 0 {
		off = 0
	}
	return off
}
