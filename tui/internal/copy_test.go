package internal

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestCopyProducesPlainText(t *testing.T) {
	m := modelWithData(t)
	m.panels = []Panel{{Kind: PanelTasks}}
	m.showHelp = true

	text := m.copyText()
	if text == "" {
		t.Fatal("nic nie zostało skopiowane")
	}
	if strings.Contains(text, "\x1b") {
		t.Error("skopiowany tekst zawiera kody sterujące — wklei się jako śmieci")
	}
	if !strings.Contains(text, "aaa-111") {
		t.Error("kopia nie zawiera treści, na którą patrzy operator")
	}
}

func TestCopyWithoutPopupTakesSelectedRow(t *testing.T) {
	m := modelWithData(t)
	m.panels = []Panel{{Kind: PanelTasks, Cursor: 1}}

	text := m.copyText()
	if !strings.Contains(text, "bbb-222") {
		t.Errorf("kopia nie dotyczy zaznaczonego wiersza: %q", text)
	}
}

func TestMouseToggleChangesReportedMode(t *testing.T) {
	m := modelWithData(t)

	if m.mouseMode() != tea.MouseModeCellMotion {
		t.Fatal("domyślnie śledzenie myszy powinno być włączone")
	}

	updated, _ := m.handleKey(keyPress("m"))
	m = updated.(*Model)

	if m.mouseMode() != tea.MouseModeNone {
		t.Error("po przełączeniu terminal nadal dostaje śledzenie, więc zaznaczanie nie wróci")
	}
	if !strings.Contains(m.flash, "terminal") {
		t.Error("przełącznik nie mówi operatorowi, co się zmieniło")
	}
}

func TestRepeatedQuestionMarkWalksOutwards(t *testing.T) {
	m := modelWithData(t)
	m.panels = []Panel{{Kind: PanelTasks}}
	m.focused = 0

	m = press(m, "?")
	if got := m.helpTarget().Explain().TitleKey; got != "help.task.title" {
		t.Fatalf("pierwsze ? dało %q zamiast opisu zadania", got)
	}

	m = press(m, "?")
	if got := m.helpTarget().Explain().TitleKey; got != "help.tasks.title" {
		t.Errorf("drugie ? dało %q zamiast legendy panelu", got)
	}
	if !m.showHelp {
		t.Fatal("drugie ? zamknęło opis zamiast wyjść poziom wyżej")
	}

	m = press(m, "?")
	if got := m.helpTarget().Explain().TitleKey; got != "help.general.title" {
		t.Errorf("trzecie ? dało %q zamiast legendy ogólnej", got)
	}

	m = press(m, "?")
	if m.showHelp {
		t.Error("czwarte ? nie zamknęło opisu — cykl się nie domyka")
	}
}

func TestArrowsStepBothWays(t *testing.T) {
	m := modelWithData(t)
	m.panels = []Panel{{Kind: PanelTasks}}

	m = press(m, "?")
	m = press(m, "left")
	if got := m.helpTarget().Explain().TitleKey; got != "help.tasks.title" {
		t.Errorf("← dało %q zamiast legendy panelu", got)
	}

	m = press(m, "right")
	if got := m.helpTarget().Explain().TitleKey; got != "help.task.title" {
		t.Errorf("→ nie wróciło do opisu zadania, dało %q", got)
	}
}
