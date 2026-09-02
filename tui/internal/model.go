package internal

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/build-on-ai/consciousness-server/tui/internal/api"
	"github.com/build-on-ai/consciousness-server/tui/internal/layout"
	"github.com/build-on-ai/consciousness-server/tui/internal/tmux"
)

type PanelKind int

const (
	PanelOverview PanelKind = iota
	PanelAgents
	PanelServices
	PanelEvents
	PanelEndpoints
	PanelTasks
	PanelGraph

	panelKindCount
)

func (k PanelKind) Title() string    { return viewFor(k).Title() }
func (k PanelKind) IconName() string { return viewFor(k).IconName() }

type Panel struct {
	Kind   PanelKind
	Cursor int
}

type Model struct {
	client *api.Client
	stream *api.Stream

	width  int
	height int

	panels  []Panel
	focused int

	snap      api.Snapshot
	lastFetch time.Time
	fetching  bool

	streamState api.StreamState

	cards *cardStore

	geom []panelGeom

	showHelp bool

	helpOffset int

	helpLevel int

	mouseOff bool

	flash     string
	flashTime time.Time

	quitting bool
}

func NewModel(c *api.Client, s *api.Stream) *Model {
	return &Model{
		client: c,
		stream: s,
		cards:  newCardStore(),
		panels: []Panel{
			{Kind: PanelOverview},
			{Kind: PanelAgents},
		},
		focused: 0,
	}
}

type snapshotMsg api.Snapshot
type tickMsg time.Time
type eventMsg api.Event

func (m *Model) Init() tea.Cmd {
	return tea.Batch(m.fetchCmd(), tickCmd(), m.waitForEvent())
}

func (m *Model) fetchCmd() tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		return snapshotMsg(m.client.Fetch(ctx))
	}
}

func tickCmd() tea.Cmd {
	return tea.Tick(3*time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (m *Model) waitForEvent() tea.Cmd {
	return func() tea.Msg {
		ev, ok := <-m.stream.Events()
		if !ok {
			return nil
		}
		return eventMsg(ev)
	}
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.trimPanels()
		return m, nil

	case tickMsg:
		m.streamState = m.stream.State()
		if !m.fetching {
			m.fetching = true
			return m, tea.Batch(m.fetchCmd(), tickCmd())
		}
		return m, tickCmd()

	case snapshotMsg:
		m.snap = api.Snapshot(msg)
		m.snap.Host, m.snap.Running = localSessions()
		m.lastFetch = time.Now()
		m.fetching = false
		return m, nil

	case eventMsg:
		m.streamState = m.stream.State()
		return m, m.waitForEvent()

	case cardMsg:
		m.cards.set(msg.agent, msg.card)
		return m, nil

	case tea.KeyPressMsg:
		return m.handleKey(msg)

	case tea.MouseClickMsg:
		return m.handleClick(tea.Mouse(msg))

	case tea.MouseWheelMsg:
		return m.handleWheel(tea.Mouse(msg))
	}

	return m, nil
}

func (m *Model) handleKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()

	if m.showHelp {
		switch key {
		case "up", "k":
			if m.helpOffset > 0 {
				m.helpOffset--
			}
			return m, nil
		case "down", "j":
			if m.helpOffset < m.helpMaxOffset() {
				m.helpOffset++
			}
			return m, nil
		case "pgup":
			m.helpOffset -= 10
			if m.helpOffset < 0 {
				m.helpOffset = 0
			}
			return m, nil
		case "pgdown":
			m.helpOffset += 10
			if maxOff := m.helpMaxOffset(); m.helpOffset > maxOff {
				m.helpOffset = maxOff
			}
			return m, nil
		case "left", "backspace":
			if _, total := m.helpDepth(); m.helpLevel < total-1 {
				m.helpLevel++
				m.helpOffset = 0
			}
			return m, nil
		case "right":
			if m.helpLevel > 0 {
				m.helpLevel--
				m.helpOffset = 0
			}
			return m, nil
		case "g":
			m.helpOffset = 0
			return m, nil
		case "G":
			m.helpOffset = m.helpMaxOffset()
			return m, nil
		case "?":
			if _, total := m.helpDepth(); m.helpLevel < total-1 {
				m.helpLevel++
				m.helpOffset = 0
				return m, nil
			}
			m.showHelp = false
			m.helpLevel = 0
			return m, nil

		case "esc", "q", "ctrl+c", "y", "m":
		default:
			m.showHelp = false
			return m, nil
		}
	}

	switch key {

	case "y":
		if text := m.copyText(); text != "" {
			if err := copyToSystemClipboard(text); err != nil {
				m.flash = "skopiowane przez terminal (OSC 52)"
			} else {
				m.flash = "skopiowane do schowka"
			}
			m.flashTime = time.Now()
			return m, tea.SetClipboard(text)
		}
		m.flash = "nie ma czego skopiować"
		m.flashTime = time.Now()
		return m, nil

	case "m":
		m.mouseOff = !m.mouseOff
		if m.mouseOff {
			m.flash = "mysz wyłączona — zaznaczanie i prawy przycisk należą do terminala"
		} else {
			m.flash = "mysz włączona"
		}
		m.flashTime = time.Now()
		return m, nil

	case "?":
		m.showHelp = !m.showHelp
		m.helpOffset = 0
		m.helpLevel = 0
		return m, m.cardCmd()

	case "esc":
		if m.showHelp {
			m.showHelp = false
		}
		return m, nil

	case "q", "ctrl+c":
		m.quitting = true
		m.stream.Stop()
		return m, tea.Quit

	case "tab":
		if len(m.panels) > 0 {
			m.focused = (m.focused + 1) % len(m.panels)
		}
		return m, nil

	case "shift+tab":
		if len(m.panels) > 0 {
			m.focused = (m.focused - 1 + len(m.panels)) % len(m.panels)
		}
		return m, nil

	case "w":
		if len(m.panels) > 1 {
			m.panels = append(m.panels[:m.focused], m.panels[m.focused+1:]...)
			if m.focused >= len(m.panels) {
				m.focused = len(m.panels) - 1
			}
		}
		return m, nil

	case "r":
		if !m.fetching {
			m.fetching = true
			return m, m.fetchCmd()
		}
		return m, nil

	case "up", "k":
		m.moveCursor(-1)
		return m, nil

	case "down", "j":
		m.moveCursor(1)
		return m, nil

	}

	for _, v := range AllPanels {
		if v.Key() == msg.String() {
			m.openPanel(v.Kind())
			return m, nil
		}
	}

	return m, nil
}

func (m *Model) openPanel(kind PanelKind) {
	for i, p := range m.panels {
		if p.Kind == kind {
			m.focused = i
			return
		}
	}
	if len(m.panels) >= m.maxPanels() {
		m.panels[m.focused] = Panel{Kind: kind}
		return
	}
	m.panels = append(m.panels, Panel{Kind: kind})
	m.focused = len(m.panels) - 1
}

func (m *Model) trimPanels() {
	max := m.maxPanels()
	if len(m.panels) <= max {
		return
	}
	keep := []Panel{m.panels[m.focused]}
	for i, p := range m.panels {
		if len(keep) >= max {
			break
		}
		if i != m.focused {
			keep = append(keep, p)
		}
	}
	m.panels = keep
	m.focused = 0
}

func (m *Model) maxPanels() int {
	usable := m.width - sidebarWidth
	switch {
	case usable >= 160:
		return 4
	case usable >= 110:
		return 3
	case usable >= 70:
		return 2
	default:
		return 1
	}
}

func (m *Model) moveCursor(delta int) {
	if len(m.panels) == 0 {
		return
	}
	p := &m.panels[m.focused]
	n := m.rowCount(p.Kind)
	if n == 0 {
		p.Cursor = 0
		return
	}
	p.Cursor += delta
	if p.Cursor < 0 {
		p.Cursor = 0
	}
	if p.Cursor >= n {
		p.Cursor = n - 1
	}
}

func (m *Model) rowCount(kind PanelKind) int {
	return len(viewFor(kind).Rows(m))
}

type panelGeom struct {
	Outer    layout.Rect
	Inner    layout.Rect
	Scroll   int
	Preamble int
}

func (m *Model) panelAt(x, y int) int {
	for i, g := range m.geom {
		if g.Outer.Contains(x, y) {
			return i
		}
	}
	return -1
}

func (m *Model) rowAt(panel int, y int) int {
	if panel < 0 || panel >= len(m.geom) {
		return -1
	}
	g := m.geom[panel]

	line := y - g.Inner.Y
	if line < 0 || line >= g.Inner.H {
		return -1
	}

	row := line + g.Scroll - g.Preamble
	if row < 0 {
		return -1
	}
	return row
}

func (m *Model) handleClick(e tea.Mouse) (tea.Model, tea.Cmd) {
	if m.showHelp {
		if e.Button == tea.MouseRight {
			if _, total := m.helpDepth(); m.helpLevel < total-1 {
				m.helpLevel++
				m.helpOffset = 0
				return m, nil
			}
		}
		m.showHelp = false
		m.helpLevel = 0
		return m, nil
	}

	idx := m.panelAt(e.X, e.Y)
	if idx < 0 {
		return m, nil
	}
	m.focused = idx

	switch e.Button {
	case tea.MouseLeft:
		if row := m.rowAt(idx, e.Y); row >= 0 {
			if n := m.rowCount(m.panels[idx].Kind); n > 0 && row < n {
				m.panels[idx].Cursor = row
			}
		}

	case tea.MouseRight:
		if row := m.rowAt(idx, e.Y); row >= 0 {
			if n := m.rowCount(m.panels[idx].Kind); n > 0 && row < n {
				m.panels[idx].Cursor = row
			}
		}
		m.showHelp = true
		m.helpOffset = 0
		m.helpLevel = 0
		return m, m.cardCmd()
	}

	return m, nil
}

func (m *Model) cardCmd() tea.Cmd {
	if !m.showHelp || len(m.panels) == 0 {
		return nil
	}
	row, ok := m.selectedExplainable(m.panels[m.focused]).(agentRow)
	if !ok || !m.want(row.a.Name) {
		return nil
	}
	name := row.a.Name
	return func() tea.Msg { return m.fetchCard(name)() }
}

func (m *Model) handleWheel(e tea.Mouse) (tea.Model, tea.Cmd) {
	if m.showHelp {
		switch e.Button {
		case tea.MouseWheelUp:
			if m.helpOffset > 0 {
				m.helpOffset--
			}
		case tea.MouseWheelDown:
			if m.helpOffset < m.helpMaxOffset() {
				m.helpOffset++
			}
		}
		return m, nil
	}

	idx := m.panelAt(e.X, e.Y)
	if idx < 0 {
		return m, nil
	}

	n := m.rowCount(m.panels[idx].Kind)
	if n == 0 {
		return m, nil
	}

	switch e.Button {
	case tea.MouseWheelUp:
		if m.panels[idx].Cursor > 0 {
			m.panels[idx].Cursor--
		}
	case tea.MouseWheelDown:
		if m.panels[idx].Cursor < n-1 {
			m.panels[idx].Cursor++
		}
	}
	return m, nil
}

const clipboardWidth = 76

func (m *Model) copyText() string {
	if m.showHelp {
		doc := m.helpTarget().Explain()
		lines := renderDoc(doc, clipboardWidth)
		out := make([]string, 0, len(lines)+1)
		out = append(out, helpTitle(doc))
		for _, l := range lines {
			out = append(out, stripANSI(l))
		}
		return strings.Join(out, "\n")
	}

	if len(m.panels) == 0 {
		return ""
	}
	if e := m.selectedExplainable(m.panels[m.focused]); e != nil {
		doc := e.Explain()
		var b strings.Builder
		b.WriteString(helpTitle(doc) + "\n")
		for _, s := range doc.Sections {
			for _, r := range s.Rows {
				b.WriteString(r[0] + ": " + r[1] + "\n")
			}
		}
		return b.String()
	}
	return ""
}

func stripANSI(s string) string {
	var b strings.Builder
	var inEscape bool
	for _, r := range s {
		switch {
		case r == 0x1b:
			inEscape = true
		case inEscape:
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
				inEscape = false
			}
		default:
			b.WriteRune(r)
		}
	}
	return strings.TrimRight(b.String(), " ")
}

func copyToSystemClipboard(text string) error {
	candidates := [][]string{
		{"wl-copy"},
		{"xclip", "-selection", "clipboard"},
		{"xsel", "--clipboard", "--input"},
		{"pbcopy"},
	}

	for _, argv := range candidates {
		path, err := exec.LookPath(argv[0])
		if err != nil {
			continue
		}
		cmd := exec.Command(path, argv[1:]...)
		cmd.Stdin = strings.NewReader(text)
		if err := cmd.Run(); err == nil {
			return nil
		}
	}
	return errNoClipboardTool
}

var errNoClipboardTool = errors.New("brak narzędzia schowka")

func localSessions() (string, map[string]bool) {
	host, err := os.Hostname()
	if err != nil {
		host = ""
	}
	if !tmux.Available() {
		return host, nil
	}
	return host, tmux.LocalAgents()
}
