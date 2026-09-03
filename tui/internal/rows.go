package internal

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"charm.land/lipgloss/v2"

	"github.com/build-on-ai/consciousness-server/tui/internal/api"
	"github.com/build-on-ai/consciousness-server/tui/internal/layout"
	"github.com/build-on-ai/consciousness-server/tui/internal/theme"
)

type Row interface {
	Render(width int, selected bool) string
	Explain() Doc
}

func renderList(width, cursor int, rows []Row) string {
	var b strings.Builder
	for i, r := range rows {
		b.WriteString(r.Render(width, i == cursor) + "\n")
	}
	return b.String()
}

func pick(text string, selected bool, normal func(string) string) string {
	if selected {
		return theme.Selected.Render(text)
	}
	return normal(text)
}

func plain(s string) string { return theme.Value.Render(s) }
func dim(s string) string   { return theme.Label.Render(s) }

type taskRow struct{ t api.Task }

const colGap = 1

const markWidth = 2

var taskStatusWidth = widest(api.TaskStatuses) + markWidth + colGap

const taskAssigneeWidth = 10 + colGap

func widest(ss []string) int {
	w := 0
	for _, s := range ss {
		if n := lipgloss.Width(s); n > w {
			w = n
		}
	}
	return w
}

func (d taskRow) Render(width int, selected bool) string {
	status := theme.StatusStyle(d.t.Status).Render(
		layout.Row(taskStatusWidth, layout.Col{
			Text:  theme.StatusMark(d.t.Status) + " " + d.t.Status,
			Width: taskStatusWidth,
		}))
	who := dim(layout.Row(taskAssigneeWidth, layout.Col{
		Text:  layout.Truncate(d.t.AssignedTo, taskAssigneeWidth-colGap),
		Width: taskAssigneeWidth,
	}))

	rest := layout.Remaining(width, status, who)
	return status + who + pick(layout.Row(rest, layout.Col{Text: d.t.Title}), selected, plain)
}

func (d taskRow) Explain() Doc {
	assigned := d.t.AssignedTo
	if assigned == "" {
		assigned = "niczyje"
	}

	sections := []Section{{
		Title: "Zadanie",
		Rows: [][2]string{
			{"tytuł", d.t.Title},
			{"stan", d.t.Status},
			{"priorytet", d.t.Priority},
			{"projekt", d.t.Project},
			{"zlecił", d.t.CreatedBy},
			{"wykonuje", assigned},
			{"id", d.t.ID},
		},
	}}

	if desc := strings.TrimSpace(d.t.Description); desc != "" {
		sections = append(sections, Section{Title: "TREŚĆ", Lines: strings.Split(desc, "\n")})
	}

	if res := strings.TrimSpace(d.t.ResultText()); res != "" {
		sections = append(sections, Section{Title: "WYNIK", Lines: strings.Split(res, "\n")})
	}

	stages := [][2]string{{"utworzone", d.t.CreatedAt}}
	for _, s := range [][2]string{
		{"przejęte", d.t.ClaimedAt},
		{"rozpoczęte", d.t.StartedAt},
		{"zakończone", d.t.CompletedAt},
	} {
		if s[1] != "" {
			stages = append(stages, s)
		}
	}
	timeline := make([][2]string, 0, len(stages))
	for _, s := range stages {
		timeline = append(timeline, [2]string{s[0], relTime(s[1])})
	}
	sections = append(sections, Section{Title: "PRZEBIEG", Rows: timeline})

	if meta := strings.TrimSpace(d.t.MetadataText()); meta != "" {
		sections = append(sections, Section{Title: "METADANE", Lines: strings.Split(meta, "\n")})
	}

	if d.t.Status == "PENDING" {
		why := []string{
			"PENDING mówi wyłącznie o zapisanym stanie. Z tego wiersza nie da",
			"się ustalić, czy zadanie czeka na przypisanego wykonawcę, leży",
			"w puli, nie zostało odebrane, czy klient wykonawczy nie działa —",
			"rdzeń nie podaje przyczyny w liście zadań.",
		}
		if assigned == "niczyje" {
			why = append(why, "",
				"Bez wykonawcy zadanie nie czeka na nikogo konkretnego: dopóki",
				"ma stan PENDING, może je przejąć dowolny agent.")
		} else {
			why = append(why, "",
				"Wpis w rejestrze nie wystarczy, żeby zadanie zostało wykonane.",
				"Sprawdź stan wykonawcy w panelu Agenci: przypisanie komuś bez",
				"otwartej sesji zostanie przyjęte i nigdy zrealizowane.")
		}
		sections = append(sections, Section{Title: "CO ZNACZY PENDING", Lines: why})
	}

	sections = append(sections, Section{
		Title: "CZEGO RDZEŃ NIE PODAJE",
		Lines: []string{
			"Czy zlecający i wykonawca istnieją w rejestrze agentów i czy wykonawca żyje.",
			"Kto zmienił stan: człowiek, agent czy inny klient API.",
		},
	})

	return Doc{TitleKey: "help.task.title", Subtitle: d.t.ID, Sections: sections}
}

type agentRow struct {
	a        api.Agent
	attached bool
	running  bool
	local    bool
	noCard   bool
	hasKey   bool
	card     card
}

const lampsCell = "● ● ● ●  "

func lampsWidth() int { return lipgloss.Width(lampsCell) }

func agentNameWidth(width int) int {
	w := layout.Remaining(width, lampsCell, "OFFLINE")
	if w < 8 {
		return 8
	}
	if w > 16 {
		return 16
	}
	return w
}

func (d agentRow) Render(width int, selected bool) string {
	live := api.DeriveLiveness(d.a, d.attached, time.Now()).WithLocalProcess(d.running, d.local)

	lamps := strings.Join([]string{
		theme.Lamp(live.Registered, theme.OK),
		theme.Lamp(live.Heartbeat, theme.OK),
		theme.Lamp(live.Attached, theme.OK),
		theme.Lamp(live.Working, theme.OK),
	}, " ")

	nameW := agentNameWidth(width)
	name := pick(layout.Row(nameW, layout.Col{Text: d.a.Name}), selected, plain)
	state := theme.Status(live.Label())

	if live.Label() == "BRAK SESJI" {
		state += theme.Label.Render(" [?]")
	}

	mark := ""
	if d.hasKey {
		mark += theme.StatusStyle("ok").Render(" ⚿")
	}
	if d.noCard {
		mark += theme.Label.Render(" ·bez karty")
	}
	return name + lamps + "  " + state + mark
}

func (d agentRow) Explain() Doc {
	live := api.DeriveLiveness(d.a, d.attached, time.Now()).WithLocalProcess(d.running, d.local)
	label := live.Label()

	sections := []Section{{
		Title: "Agent",
		Rows: [][2]string{
			{"nazwa", d.a.Name},
			{"rola", d.a.Role},
			{"maszyna", d.a.Location},
			{"stan", label},
			{"ostatni puls", relTime(d.a.LastHeartbeat)},
		},
	}, {
		Title: "Cztery osie tego agenta",
		Rows: [][2]string{
			{"R jest na liście", boolWord(live.Registered)},
			{"H puls < minuty", boolWord(live.Heartbeat)},
			{"W otwarty socket", boolWord(live.Attached)},
			{"P podał zadanie", boolWord(live.Working)},
		},
	}}

	if label == "BEZ MELDUNKU" {
		sections = append(sections, Section{
			Title: "BEZ MELDUNKU — co to znaczy",
			Rows: [][2]string{
				{"puls (H)", "nie przychodzi albo jest starszy niż 60 s"},
				{"proces", "sesja tej roli DZIAŁA na tej maszynie — panel ją widzi"},
			},
			Lines: []string{
				"Agent pracuje, ale nikt tego nie zgłasza. presence jest osobnym",
				"procesem i mógł paść, choć agent obok żyje — zdarzyło się to",
				"o 22:55, a panel przez sześć godzin pokazywał OFFLINE, podczas",
				"gdy w tym panelu pisał kod.",
				"",
				"Rola jest odczytana ze zmiennej HOME albo CODEX_HOME procesu",
				"(~/.cs-agents/<rola>), więc ten stan nie zależy od tego, czy",
				"presence żyje.",
				"",
				"Co zrobić: uruchomić presence dla tej roli. Agenta nie trzeba",
				"restartować — pracuje dalej, tylko nie ma go kto zgłaszać.",
			},
			Note: "Sprawdzane wyłącznie na maszynie, na której działa panel.",
		})
	}

	if label == "BRAK SESJI" {
		sections = append(sections, Section{
			Title: "BRAK SESJI — co to znaczy",
			Rows: [][2]string{
				{"puls (H)", "przychodzi, młodszy niż 60 s"},
				{"sesja (W)", "brak otwartego WebSocketa"},
			},
			Lines: []string{
				"Puls odświeżają trzy trasy rdzenia, nie tylko ta oczywista:",
				"POST /api/agents/register, POST /api/agents/:name/heartbeat",
				"oraz PATCH /api/agents/:name/status. Sesję daje wyłącznie",
				"otwarte połączenie WebSocket, widoczne w /api/ws/clients.",
			},
		}, Section{
			Title: "Skąd ten stan bierze się w praktyce",
			Rows: [][2]string{
				{"launcher bez agenta", "launcher rejestruje agenta przy starcie i nie otwiera sesji; gdy proces nie wstanie, zostaje sam wpis z pulsem"},
				{"zerwana sesja", "presence trzyma puls i połączenie w osobnych pętlach — po zerwaniu WebSocketa puls leci dalej, a ponowienie ma zwłokę do 30 s"},
				{"osierocony watcher", "skrypt nadzorujący, który przeżył agenta i melduje w jego imieniu"},
				{"testy integracyjne", "bin/test-integrations.sh rejestruje agenta i wysyła puls, sesji nie otwiera"},
				{"ręczne wywołanie", "curl na którąkolwiek z trzech tras wyżej"},
			},
			Lines: []string{
				"",
				"Rozstrzygające pytanie brzmi: czy na maszynie agenta działa jego",
				"proces. Jeśli nie — zatrzymaj to, co wysyła puls, bo stan sam nie",
				"zniknie: każde meldowanie odświeża wpis i przedłuża TTL w Redisie.",
				"Puls kilku agentów w tej samej milisekundzie zdradza jedną pętlę",
				"nadzorującą, a nie wielu agentów.",
			},
			Note: "Zadanie zlecone teraz zostanie przyjęte i nigdy wykonane.",
		})
	}

	sections = append(sections, cardSection(d.a.Name, d.card))

	return Doc{TitleKey: "help.agent.title", Subtitle: d.a.Name, Sections: sections}
}

type serviceRow struct{ s api.Service }

func (d serviceRow) Render(width int, selected bool) string {
	const portW = 6

	mark := theme.StatusStyle(d.s.Status).Render(theme.StatusMark(d.s.Status))
	port := dim(layout.Row(portW, layout.Col{Text: fmt.Sprint(d.s.Port), Width: portW}))

	rest := layout.Remaining(width, mark, " ", port)
	return mark + " " + port + pick(layout.Row(rest, layout.Col{Text: d.s.Name}), selected, plain)
}

func (d serviceRow) Explain() Doc {
	probe := d.s.Path
	if probe == "" {
		probe = "brak ścieżki — sprawdzane połączeniem TCP"
	}

	return Doc{
		TitleKey: "help.service.title",
		Subtitle: d.s.Name,
		Sections: []Section{{
			Title: "Serwis",
			Rows: [][2]string{
				{"nazwa", d.s.Name},
				{"port", fmt.Sprint(d.s.Port)},
				{"sonda", probe},
				{"stan", d.s.Status},
				{"opis", d.s.Description},
			},
		}, {
			Title: "CO ZNACZY TEN STAN",
			Rows: [][2]string{
				{"active", "HTTP odpowiedział kodem poniżej 500, albo dla wpisu bez ścieżki udało się połączenie TCP"},
				{"inactive", "kod 500 lub wyższy, albo sonda zakończyła się błędem: połączenie, DNS, przekroczony czas"},
			},
			Lines: []string{
				"",
				"Kody 400-499 liczą się jako active. Usługa odpowiadająca 404 na",
				"każdej trasie będzie tu oznaczona jako działająca — sonda mierzy",
				"osiągalność, nie poprawność.",
			},
		}, {
			Title: "CZEGO TEN WIERSZ NIE POKAZUJE",
			Lines: []string{
				"Hosta, którego użyła sonda. Wybiera go machines-server: najpierw",
				"SERVICES_HOST, potem pole host z rejestru, na końcu localhost.",
				"",
				"Kodu HTTP, czasu odpowiedzi, treści błędu ani momentu sondy.",
				"Stan jest liczony na nowo przy każdym żądaniu, więc pole status",
				"wpisane w rejestrze nie ma z tym wynikiem nic wspólnego.",
			},
		}},
	}
}

type eventRow struct{ e api.Event }

func (d eventRow) Render(width int, selected bool) string {
	const chanW = 9

	ch := dim(layout.Row(chanW, layout.Col{Text: d.e.Channel, Width: chanW}))
	text := d.e.Type
	if d.e.Type == "unbound" {
		text = "UNBOUND " + d.e.Type
	}

	rest := layout.Remaining(width, ch)
	cell := layout.Row(rest, layout.Col{Text: text})

	if !selected && d.e.Type == "unbound" {
		return ch + theme.StatusStyle("unknown").Render(cell)
	}
	return ch + pick(cell, selected, plain)
}

func (d eventRow) Explain() Doc {
	sections := []Section{{
		Title: "Zdarzenie",
		Rows: [][2]string{
			{"kanał", d.e.Channel},
			{"typ", d.e.Type},
			{"numer", fmt.Sprint(d.e.Seq)},
			{"czas", relTime(d.e.Timestamp)},
		},
	}}

	if len(d.e.Data) > 0 {
		keys := make([]string, 0, len(d.e.Data))
		for k := range d.e.Data {
			keys = append(keys, k)
		}
		sort.Strings(keys)

		rows := make([][2]string, 0, len(keys))
		for _, k := range keys {
			rows = append(rows, [2]string{k, fmt.Sprintf("%v", d.e.Data[k])})
		}
		sections = append(sections, Section{Title: "Treść", Rows: rows})
	} else {
		sections = append(sections, Section{
			Title: "Treść",
			Lines: []string{"Zdarzenie przyszło bez danych."},
		})
	}

	if d.e.Type == "unbound" {
		sections = append(sections, Section{
			Title: "UNBOUND",
			Lines: []string{
				"Ramka dotarła bez pól kanału i typu, więc nie dało się jej",
				"przypisać do niczego. Surowa treść jest zachowana pod kluczem",
				"raw. Rysujemy ją zamiast pominąć, bo taka ramka to sygnał",
				"rozjazdu nadawcy z odbiorcą.",
				"",
				"UNBOUND nie znaczy nieznany typ: klient nie ma listy typów,",
				"które rozumie, i przyjmuje każdą ramkę z kanałem albo typem.",
			},
		})
	}

	sections = append(sections, Section{
		Title: "NUMER I CZAS",
		Lines: []string{
			"Numer 0 znaczy, że zdarzenie odebrano na żywo: rdzeń nadaje numer",
			"i czas tylko przy zapisie do bufora, a do nadawania na bieżąco",
			"przekazuje sam typ i treść. Czas jest wtedy lokalny.",
			"",
			"Zdarzenie z odtworzenia historii ma numer i czas serwera. Ponieważ",
			"licznik przesuwa się tylko dla numerowanych, po ponownym połączeniu",
			"to samo zdarzenie może pojawić się drugi raz.",
		},
	})

	return Doc{TitleKey: "help.event.title", Subtitle: d.e.Channel + " · " + d.e.Type, Sections: sections}
}

type routeRow struct{ r api.Route }

func (d routeRow) Render(width int, selected bool) string {
	const methodW = 11

	method := dim(layout.Row(methodW, layout.Col{Text: strings.Join(d.r.Methods, ","), Width: methodW}))
	rest := layout.Remaining(width, method)
	cell := layout.Row(rest, layout.Col{Text: d.r.Path})

	if !selected && d.r.Parameterised {
		return method + dim(cell)
	}
	return method + pick(cell, selected, plain)
}

func (d routeRow) Explain() Doc {
	sections := []Section{{
		Title: "Endpoint",
		Rows: [][2]string{
			{"ścieżka", d.r.Path},
			{"metody", strings.Join(d.r.Methods, ", ")},
		},
	}}
	if d.r.Parameterised {
		sections = append(sections, Section{
			Title: "Z PARAMETREM",
			Lines: []string{
				"Ścieżka wymaga podstawienia wartości, więc prober jej nie",
				"wywołuje: bez prawdziwego identyfikatora wynik nie mówiłby nic",
				"o endpoincie.",
			},
		})
	}

	sections = append(sections, Section{
		Title: "CZEGO TEN WIERSZ NIE POKAZUJE",
		Lines: []string{
			"Obecność w katalogu dowodzi, że trasa jest zarejestrowana —",
			"nie że działa. Handler może odmówić na walidacji, uwierzytelnieniu",
			"albo z powodu martwej zależności.",
			"",
			"Nie ma tu opisu operacji, kształtu żądania i odpowiedzi, wymagań",
			"podpisu ani kodów błędów. To znany brak: te dane mają pochodzić",
			"z kontraktu zestawianego z routerem, żeby nie powstał drugi katalog",
			"pisany ręcznie obok.",
			"",
			"Kilka metod na jednej ścieżce jest tu jednym wierszem, choć odczyt",
			"i zapis pod tym samym adresem to różne operacje o różnych skutkach.",
		},
	})

	return Doc{TitleKey: "help.route.title", Subtitle: d.r.Path, Sections: sections}
}

type edgeRow struct {
	e                      api.GraphEdge
	fromUnknown, toUnknown bool
}

func (d edgeRow) Render(width int, selected bool) string {
	const kindW, nodeW = 10, 14

	kind := dim(layout.Row(kindW, layout.Col{Text: d.e.Kind, Width: kindW}))

	from := layout.Row(nodeW, layout.Col{Text: shortNode(d.e.From), Width: nodeW})
	switch {
	case d.fromUnknown:
		from = theme.StatusStyle("warning").Render(
			layout.Row(nodeW, layout.Col{Text: shortNode(d.e.From) + "?", Width: nodeW}))
	default:
		from = pick(from, selected, plain)
	}

	arrow := dim(" → ")
	rest := layout.Remaining(width, kind, from, arrow)
	to := layout.Row(rest, layout.Col{Text: shortNode(d.e.To)})
	if d.toUnknown {
		to = theme.StatusStyle("warning").Render(
			layout.Row(rest, layout.Col{Text: shortNode(d.e.To) + "?"}))
	} else {
		to = plain(to)
	}

	return kind + from + arrow + to
}

func (d edgeRow) Explain() Doc {
	sections := []Section{{
		Title: "Zależność",
		Rows: [][2]string{
			{"od", d.e.From},
			{"do", d.e.To},
			{"rodzaj", d.e.Kind},
		},
	}}

	sections = append(sections, Section{
		Title: "CO ZNACZY TEN RODZAJ",
		Rows: [][2]string{
			{"runs_on", "agent działa na maszynie z jego pola location; to deklaracja z rejestru, nie sonda maszyny"},
			{"assigns", "zlecający wskazał wykonawcę zadania; obie strony musiały być podane i różne"},
			{"emits", "rdzeń deklaruje ten kanał; krawędź powstaje także dla kanału, którym nigdy nic nie poszło"},
			{"subscribes", "otwarty klient zapisał się na ten kanał"},
			{"serves", "rdzeń obsługuje tę grupę tras; grupa to pierwszy segment po /api/"},
		},
	})

	if d.fromUnknown || d.toUnknown {
		sections = append(sections, Section{
			Title: "NIEZNANY UCZESTNIK",
			Lines: []string{
				"Jeden z końców tej krawędzi nie istnieje w żadnym rejestrze:",
				"coś odwołuje się do nazwy, której nikt nie zarejestrował.",
				"",
				"Węzeł zostaje narysowany ze znakiem zapytania zamiast zniknąć.",
				"Poprzednia wersja grafu pomijała takich uczestników i dlatego",
				"potrafiła narysować jedną krawędź dla całego systemu.",
			},
			Note: "To jest znalezisko, nie szum — dlatego węzeł jest rysowany.",
		})
	}

	sections = append(sections, Section{
		Title: "CZEGO TA KRAWĘDŹ NIE MÓWI",
		Lines: []string{
			"To nie jest zależność wdrożeniowa. Krawędź mówi, że jeden byt wie",
			"o drugim albo go wskazał — nie, że bez niego nie zadziała.",
			"",
			"Kolejność usług przy starcie i to, co przestaje działać po awarii",
			"konkretnego bloku, wynika z compose i z wywołań między blokami.",
			"Tego źródła tu nie ma.",
		},
	})

	return Doc{TitleKey: "help.edge.title", Subtitle: d.e.Kind, Sections: sections}
}

func shortNode(id string) string {
	if i := strings.Index(id, ":"); i >= 0 && i < len(id)-1 {
		return id[i+1:]
	}
	return id
}

func boolWord(b bool) string {
	if b {
		return "tak"
	}
	return "nie"
}
