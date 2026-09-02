package internal

import (
	"strings"
	"testing"

	"github.com/build-on-ai/consciousness-server/tui/internal/api"
)

func TestTaskRowKeepsStatusWhole(t *testing.T) {
	for _, status := range api.TaskStatuses {
		row := taskRow{t: api.Task{
			Status:     status,
			AssignedTo: "REVIEWER",
			Title:      "tytuł zadania",
		}}

		out := stripANSI(row.Render(80, false))

		if !strings.Contains(out, status) {
			t.Errorf("status %q was cut: %q", status, out)
		}

		if !strings.Contains(out, status+" ") {
			t.Errorf("no gap after status %q, columns collide: %q", status, out)
		}
		if !strings.Contains(out, "REVIEWER") {
			t.Errorf("assignee missing for status %q: %q", status, out)
		}
	}
}

func TestTaskRowKeepsGapAfterLongAssignee(t *testing.T) {
	row := taskRow{t: api.Task{
		Status:     "PENDING",
		AssignedTo: strings.Repeat("A", 40),
		Title:      "tytuł",
	}}

	out := stripANSI(row.Render(80, false))

	if !strings.Contains(out, " tytuł") {
		t.Errorf("title touches the assignee: %q", out)
	}
}

func TestTaskCardShowsTheTaskNotAnApologyForMissingIt(t *testing.T) {
	row := taskRow{t: api.Task{
		ID:          "abc",
		Title:       "Napraw kolumnę statusu",
		Status:      "DONE",
		Description: "Kolumna miała dziesięć znaków, a CANCELLED potrzebuje jedenastu.",
		Result:      []byte(`"zrobione, test dodany"`),
		CreatedAt:   "2026-08-10T10:00:00.000Z",
		StartedAt:   "2026-08-10T10:05:00.000Z",
		CompletedAt: "2026-08-10T10:30:00.000Z",
	}}

	doc := row.Explain()
	titles := map[string]bool{}
	var text strings.Builder
	for _, s := range doc.Sections {
		titles[s.Title] = true
		for _, l := range s.Lines {
			text.WriteString(l + " ")
		}
		for _, r := range s.Rows {
			text.WriteString(r[0] + " " + r[1] + " ")
		}
	}

	if !titles["TREŚĆ"] {
		t.Error("karta nie ma sekcji z treścią zadania")
	}
	if !titles["WYNIK"] {
		t.Error("zadanie skończone, a karta nie pokazuje wyniku")
	}
	if !titles["PRZEBIEG"] {
		t.Error("karta nie pokazuje osi czasu")
	}
	if !strings.Contains(text.String(), "CANCELLED potrzebuje jedenastu") {
		t.Error("opis zadania nie trafił na kartę")
	}
	if !strings.Contains(text.String(), "zrobione, test dodany") {
		t.Error("wynik zadania nie trafił na kartę")
	}

	if titles["CZEGO TEN WIERSZ NIE POKAZUJE"] {
		t.Error("wrócił wywód o brakujących polach zamiast samych pól")
	}
}

func TestTaskResultReadsBothShapesAgentsWrite(t *testing.T) {
	sentence := api.Task{Result: []byte(`"po prostu zdanie"`)}
	if got := sentence.ResultText(); got != "po prostu zdanie" {
		t.Errorf("zdanie: chciałem %q, jest %q", "po prostu zdanie", got)
	}

	object := api.Task{Result: []byte(`{"summary":"gotowe","files":3}`)}
	got := object.ResultText()
	if !strings.Contains(got, "summary: gotowe") || !strings.Contains(got, "files: 3") {
		t.Errorf("obiekt nie został rozpakowany: %q", got)
	}

	for _, empty := range []api.Task{{}, {Result: []byte(`null`)}, {Result: []byte(` `)}} {
		if got := empty.ResultText(); got != "" {
			t.Errorf("puste powinno zostać puste, jest %q", got)
		}
	}
}

func TestTimelineOmitsStagesThatNeverHappened(t *testing.T) {
	row := taskRow{t: api.Task{Status: "PENDING", CreatedAt: "2026-08-10T10:00:00.000Z"}}

	for _, s := range row.Explain().Sections {
		if s.Title != "PRZEBIEG" {
			continue
		}
		if len(s.Rows) != 1 {
			t.Fatalf("zadanie tylko utworzone ma mieć jeden etap, ma %d: %v", len(s.Rows), s.Rows)
		}
		if s.Rows[0][0] != "utworzone" {
			t.Errorf("jedyny etap to %q, spodziewałem się 'utworzone'", s.Rows[0][0])
		}
		return
	}
	t.Fatal("brak sekcji PRZEBIEG")
}

func TestLongLineWrapsInsteadOfLeavingThePopup(t *testing.T) {
	long := strings.Repeat("słowo ", 40)
	lines := wrapText(strings.TrimSpace(long), 60)

	if len(lines) < 2 {
		t.Fatalf("długa linia nie została zawinięta: %d linii", len(lines))
	}
	for i, l := range lines {
		if w := len([]rune(l)); w > 60 {
			t.Errorf("linia %d ma %d znaków, limit to 60: %q", i, w, l)
		}
	}
}
