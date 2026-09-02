package internal

import (
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/build-on-ai/consciousness-server/tui/internal/layout"
	"github.com/build-on-ai/consciousness-server/tui/internal/theme"
)

type generalLegend struct{}

func (generalLegend) Explain() Doc {
	return Doc{
		TitleKey: "help.general.title",
		Subtitle: "oznaczenia, źródła danych i sterowanie",
		Sections: []Section{
			{
				Title: "ZASADA",
				Lines: []string{
					"Brak wiedzy jest rysowany, nie ukrywany. Pole, którego nikt nie",
					"zapisuje, nie pokazuje zera; źródło, którego nie sprawdzono, nie",
					"świeci na zielono; węzeł spoza rejestru zostaje na ekranie ze",
					"znakiem zapytania, zamiast zniknąć.",
				},
			},
			{
				Title: "OZNACZENIA",
				Rows: [][2]string{
					{"●", "stan sklasyfikowany jako prawidłowy; znak nie mówi, co zmierzono"},
					{"▲", "ostrzeżenie albo stan zdegradowany"},
					{"✕", "stan błędny albo nieaktywny"},
					{"?", "stan nieznany lub słowo, którego paleta nie klasyfikuje"},
					{"○", "wygaszona oś lampki; w nagłówku także trwające łączenie"},
					{"n/n", "domyślna stopka listy: pozycja kursora i liczba wierszy"},
				},
				Lines: []string{
					"",
					"Stopka n/n pojawia się tylko wtedy, gdy panel nie ma własnej.",
				},
			},
			{
				Title: "SŁOWA STANU",
				Rows: [][2]string{
					{"brak pisarza", "pola nie zapisuje nikt; zero czytałoby się jako pomiar"},
					{"niemy kanał", "kanał zadeklarowany, przez który nigdy nic nie przeszło"},
					{"UNBOUND", "zdarzenie dotarło, ale żaden panel nie deklaruje jego typu"},
					{"⚠ luka", "bufor przewinął się w czasie rozłączenia; ciąg jest niepełny"},
				},
				Lines: []string{
					"",
					"Wszystkie cztery nazywają brak wiedzy, nie awarię. Każde z nich",
					"powstało zamiast zera, które czytałoby się jako pomiar.",
				},
			},
			{
				Title: "STAN ŹRÓDŁA",
				Rows: [][2]string{
					{"● ok", "ostatnie żądanie dało odpowiedź poniżej 400 i dało się zdekodować"},
					{"✕ powód", "ostatnia próba zawiodła; wcześniejsze dane zostają wraz z wiekiem"},
					{"? jeszcze nie sprawdzone", "żadna próba dla tego źródła się nie zakończyła"},
					{"⚠ nieświeże", "co najmniej jedno źródło pokazuje dane starsze niż próg"},
				},
				Lines: []string{
					"",
					"Źródła odpytywane są niezależnie: awaria jednego nie kasuje",
					"pozostałych. `ok` mówi, że serwis odpowiedział TUI — nie, że jego",
					"własne zależności działają.",
				},
			},
			{
				Title: "KLAWISZE",
				Rows: [][2]string{
					{"1-7", "otwórz panel albo ustaw na nim fokus; przy limicie zastępuje aktywny"},
					{"tab / shift+tab", "następny albo poprzedni otwarty panel"},
					{"w", "zamknij aktywny panel; ostatni zostaje otwarty"},
					{"↑ ↓ / k j", "kursor listy; w pomocy przewijanie o wiersz"},
					{"r", "ponów odczyty REST; nie wymusza ponownego łączenia WebSocketa"},
					{"?", "pomoc wiersza pod kursorem; kolejne ? — panel, ogólna, zamknięcie"},
					{"← / backspace", "poziom ogólniejszy pomocy"},
					{"→", "poziom szczegółowszy pomocy"},
					{"pgup / pgdn", "przewiń pomoc o dziesięć wierszy"},
					{"g / G", "początek albo koniec pomocy"},
					{"esc", "zamknij pomoc"},
					{"y", "w pomocy kopiuje dokument; bez pomocy pola Rows wybranego wiersza"},
					{"m", "przełącz śledzenie myszy; po wyłączeniu zaznacza terminal"},
					{"q / ctrl+c", "zakończ program"},
				},
			},
			{
				Title: "MYSZ",
				Rows: [][2]string{
					{"lewy", "fokus panelu, a przy trafieniu w wiersz także kursor"},
					{"prawy", "wiersz i jego pomoc; w otwartej pomocy poziom wyżej"},
					{"kółko", "kursor panelu pod wskaźnikiem; w pomocy przewijanie"},
				},
			},
			{
				Title: "OGRANICZENIA",
				Lines: []string{
					"Kolor i znak oznaczają klasę stanu, nie dowód, że proces działa.",
					"`ok` źródła potwierdza odpowiedź dla TUI, nie zdrowie zależności",
					"tego serwisu.",
					"",
					"`y` bez otwartej pomocy nie kopiuje wyrenderowanego wiersza ani",
					"sekcji opisowych — kopiuje pary z sekcji Rows dokumentu wiersza.",
				},
				Note: "Każdy panel i każdy wiersz opisuje się sam: naciśnij ? stojąc na nim.",
			},
		},
	}
}

func wrapText(s string, width int) []string {
	if width <= 0 || lipgloss.Width(s) <= width {
		return []string{s}
	}

	var out []string
	line := ""
	for _, word := range strings.Fields(s) {
		switch {
		case line == "":
			line = word
		case lipgloss.Width(line)+1+lipgloss.Width(word) <= width:
			line += " " + word
		default:
			out = append(out, line)
			line = word
		}
	}
	if line != "" {
		out = append(out, line)
	}
	if len(out) == 0 {
		return []string{s}
	}
	return out
}

func renderDoc(d Doc, width int) []string {
	var b strings.Builder

	if d.Subtitle != "" {
		b.WriteString(theme.Label.Render(d.Subtitle) + "\n\n")
	}

	for i, s := range d.Sections {
		if i > 0 {
			b.WriteString("\n")
		}
		if s.Title != "" {
			b.WriteString(theme.SectionRule(s.Title, width) + "\n")
		}

		labelW := 0
		for _, r := range s.Rows {
			if n := lipgloss.Width(r[0]); n > labelW {
				labelW = n
			}
		}
		for _, r := range s.Rows {
			b.WriteString("  " + theme.Value.Render(layout.Pad(r[0], labelW)) +
				"  " + theme.Label.Render(r[1]) + "\n")
		}

		for _, line := range s.Lines {
			if line == "" {
				b.WriteString("\n")
				continue
			}
			for _, part := range wrapText(line, width-2) {
				b.WriteString("  " + theme.Label.Render(part) + "\n")
			}
		}

		if s.Note != "" {
			b.WriteString("\n  " + theme.StatusStyle("warning").Render(s.Note) + "\n")
		}
	}

	return strings.Split(b.String(), "\n")
}

func (m *Model) helpOverlay() string {
	screen := layout.Rect{W: m.width, H: m.height}
	doc := m.helpTarget().Explain()

	level, total := m.helpDepth()
	footer := "? zamyka · ↑↓ przewija · y kopiuje"
	if total > 1 {
		if level < total-1 {
			footer = fmt.Sprintf("%d/%d · ? ogólniej · ↑↓ przewija · y kopiuje · esc zamyka",
				level+1, total)
		} else {
			footer = fmt.Sprintf("%d/%d · ? zamyka · → konkretniej · y kopiuje", level+1, total)
		}
	}

	pop := layout.Popup{
		Title:  theme.Title.Render(helpTitle(doc)),
		Footer: footer,
		Border: theme.Accent,
		Offset: m.helpOffset,
	}

	area := pop.Area(screen)
	inner := layout.Box{Title: pop.Title}.Inner(area)

	return strings.Join(pop.Render(screen, m.compose(), renderDoc(doc, inner.W)), "\n")
}

func (m *Model) helpMaxOffset() int {
	screen := layout.Rect{W: m.width, H: m.height}
	doc := m.helpTarget().Explain()

	pop := layout.Popup{Title: "x"}
	area := pop.Area(screen)
	inner := layout.Box{Title: "x"}.Inner(area)

	return pop.MaxOffset(area, len(renderDoc(doc, inner.W)))
}

func helpTitle(d Doc) string {
	switch d.TitleKey {
	case "help.task.title":
		return "Zadanie"
	case "help.agent.title":
		return "Agent"
	case "help.service.title":
		return "Serwis"
	case "help.route.title":
		return "Endpoint"
	case "help.edge.title":
		return "Zależność"
	case "help.event.title":
		return "Zdarzenie"
	case "help.tasks.title":
		return "Zadania"
	case "help.services.title":
		return "Serwisy"
	case "help.events.title":
		return "Zdarzenia"
	case "help.endpoints.title":
		return "Endpointy"
	case "help.graph.title":
		return "Zależności"
	case "help.overview.title":
		return "Przegląd"
	case "help.agents.title":
		return "Agenci"
	default:
		return "Legenda"
	}
}
