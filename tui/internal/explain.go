package internal

type Explainable interface {
	Explain() Doc
}

type Doc struct {
	TitleKey string
	Subtitle string
	Sections []Section
}

type Section struct {
	Title string
	Rows  [][2]string
	Lines []string
	Note  string
}

func (m *Model) helpTarget() Explainable {
	chain := m.helpChain()

	i := m.helpLevel
	if i < 0 {
		i = 0
	}
	if i >= len(chain) {
		i = len(chain) - 1
	}
	return chain[i]
}

func (m *Model) helpChain() []Explainable {
	if len(m.panels) == 0 {
		return []Explainable{generalLegend{}}
	}
	p := m.panels[m.focused]

	chain := make([]Explainable, 0, 3)
	if e := m.selectedExplainable(p); e != nil {
		chain = append(chain, e)
	}
	chain = append(chain, p.Kind, generalLegend{})
	return chain
}

func (m *Model) helpDepth() (level, total int) {
	return m.helpLevel, len(m.helpChain())
}

func (m *Model) selectedExplainable(p Panel) Explainable {
	rows := viewFor(p.Kind).Rows(m)
	if p.Cursor < 0 || p.Cursor >= len(rows) {
		return nil
	}
	return rows[p.Cursor]
}

func (k PanelKind) Explain() Doc { return viewFor(k).Explain() }
