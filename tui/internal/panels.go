package internal

import (
	"fmt"
	"strings"
	"time"

	"github.com/build-on-ai/consciousness-server/tui/internal/api"
	"github.com/build-on-ai/consciousness-server/tui/internal/layout"
	"github.com/build-on-ai/consciousness-server/tui/internal/theme"
)

type PanelView interface {
	Kind() PanelKind
	Title() string
	IconName() string
	Key() string

	Preamble(*Model) int

	Rows(*Model) []Row

	Render(*Model, Panel, layout.Rect) string

	Footer(*Model, Panel) string

	Explain() Doc
}

var AllPanels = []PanelView{
	overviewPanel{},
	agentsPanel{},
	servicesPanel{},
	eventsPanel{},
	endpointsPanel{},
	tasksPanel{},
	graphPanel{},
}

var panelViews = func() map[PanelKind]PanelView {
	byKind := make(map[PanelKind]PanelView, len(AllPanels))
	for _, v := range AllPanels {
		if _, dup := byKind[v.Kind()]; dup {
			panic(fmt.Sprintf("panels: rodzaj %d zarejestrowany dwa razy", v.Kind()))
		}
		byKind[v.Kind()] = v
	}
	for k := PanelKind(0); k < panelKindCount; k++ {
		if _, ok := byKind[k]; !ok {
			panic(fmt.Sprintf("panels: rodzaj %d nie ma implementacji w AllPanels", k))
		}
	}
	return byKind
}()

func viewFor(k PanelKind) PanelView { return panelViews[k] }

type overviewPanel struct{}

func (overviewPanel) Kind() PanelKind     { return PanelOverview }
func (overviewPanel) Title() string       { return "Przegląd" }
func (overviewPanel) IconName() string    { return "overview" }
func (overviewPanel) Key() string         { return "1" }
func (overviewPanel) Preamble(*Model) int { return 0 }
func (overviewPanel) Rows(*Model) []Row   { return nil }

func (overviewPanel) Render(m *Model, _ Panel, in layout.Rect) string {
	return m.renderOverview(in.W, in.H)
}

func (overviewPanel) Footer(m *Model, _ Panel) string {
	if h := m.snap.Health; h != nil {
		return fmt.Sprintf("v%s │ %s", h.Version, dur(h.Uptime))
	}
	return "brak źródła"
}

func (overviewPanel) Explain() Doc {
	return Doc{
		TitleKey: "help.overview.title",
		Subtitle: "rdzeń oraz stan odczytów TUI",
		Sections: []Section{{
			Title: "ZAKRES",
			Lines: []string{
				"Z /health rdzenia: stan, wersja, czas działania oraz liczniki",
				"tego, co rdzeń trzyma w pamięci. Pod nimi stan nazwanych",
				"zależności rdzenia, jeśli je raportuje, i stan dziewięciu",
				"odczytów wykonywanych przez klienta TUI.",
			},
		}, {
			Title: "ŹRÓDŁA",
			Rows: [][2]string{
				{"health", "core /health — stan, wersja, liczniki pamięci"},
				{"agents", "core /api/agents — rejestr agentów i puls"},
				{"tasks", "core /api/tasks — lista zadań"},
				{"services", "machines-server /api/services — rejestr usług i wyniki sond"},
				{"routes", "core /api/_routes — katalog tras"},
				{"events", "core /api/events/stats — statystyki bufora; to nie jest strumień"},
				{"ws", "core /api/ws/clients — otwarte połączenia"},
				{"cards", "core /api/identity/claude-md — nazwy kart ról"},
				{"graph", "core /api/graph — graf budowany przez rdzeń"},
			},
			Lines: []string{
				"",
				"Lista pochodzi z rejestru w kliencie, więc nie może wymienić mniej",
				"źródeł, niż panel faktycznie odpytuje. Wymieniała sześć z ośmiu,",
				"a dwa pominięte nie miały gdzie zgłosić awarii.",
			},
		}, {
			Title: "ZALEŻNOŚCI RDZENIA",
			Rows: [][2]string{
				{"redis", "trwałość i szyna zdarzeń; bez niego rdzeń pamięta tylko bieżącą sesję"},
				{"semantic", "wyszukiwanie i osadzanie; wymaga też Ollamy po swojej stronie"},
			},
			Lines: []string{
				"",
				"Wiersz pojawia się tylko wtedy, gdy rdzeń zaraportował to pole.",
				"Brak wiersza znaczy: rdzeń tego nie podał — a nie, że działa.",
				"Niedostępna zależność twarda degraduje `status` rdzenia.",
			},
		}, {
			Title: "STANY ŹRÓDŁA",
			Rows: [][2]string{
				{"● ok", "odczyt się powiódł"},
				{"✕ powód", "odczyt zawiódł; przy zachowanej wartości podany jest jej wiek"},
				{"? jeszcze nie sprawdzone", "odczyt jeszcze się nie zakończył"},
			},
		}, {
			Title: "CZEGO PANEL NIE POKAZUJE",
			Lines: []string{
				"Nie jest monitorem procesów. Pozycja `services` pochodzi z osobnego",
				"machines-servera i mówi o jego sondach, nie o tym panelu.",
				"",
				"Stan żywego WebSocketa TUI jest w nagłówku okna, nie w pozycji",
				"`events` — ta pokazuje statystyki bufora pobrane przez REST.",
				"",
				"Po awarii źródła dane zostają na innych panelach. Nie wolno ich",
				"czytać bez wieku podanego przy błędzie.",
			},
			Note: "Pojedyncze martwe źródło nie gasi panelu. To był powód, dla którego umarł jego poprzednik.",
		}},
	}
}

type agentsPanel struct{}

func (agentsPanel) Kind() PanelKind     { return PanelAgents }
func (agentsPanel) Title() string       { return "Agenci" }
func (agentsPanel) IconName() string    { return "agents" }
func (agentsPanel) Key() string         { return "2" }
func (agentsPanel) Preamble(*Model) int { return 1 }

func (agentsPanel) Rows(m *Model) []Row {
	out := make([]Row, 0, len(m.snap.Agents))
	for _, a := range m.snap.Agents {
		out = append(out, agentRow{
			a:        a,
			attached: m.snap.Attached[a.Name],
			running:  m.snap.Running[a.Name],
			local:    a.Location != "" && a.Location == m.snap.Host,
			card:     m.cards.get(a.Name),
			noCard:   m.snap.SourceState("cards") == "ok" && !m.snap.HasCard(a.Name),
			hasKey:   m.snap.SourceState("keys") == "ok" && m.snap.HasKey(a.Name),
		})
	}
	return out
}

func (v agentsPanel) renderCatalogue(m *Model, in layout.Rect) string {
	if m.snap.SourceState("cards") != "ok" {
		return theme.Label.Render("brak zarejestrowanych agentów")
	}
	names := m.snap.CardList()
	if len(names) == 0 {
		return theme.Label.Render("brak zarejestrowanych agentów i brak kart ról")
	}

	var b strings.Builder
	b.WriteString(theme.Label.Render("Nie działa żaden agent.") + "\n\n")
	b.WriteString(theme.TitleDim.Render(
		fmt.Sprintf("Role, które można uruchomić (%d)", len(names))) + "\n")
	for _, n := range names {
		b.WriteString("  " + n + "\n")
	}
	b.WriteString("\n" + theme.Label.Render("To karty ról z rdzenia, nie uruchomione procesy.") + "\n")
	return b.String()
}

func (v agentsPanel) Render(m *Model, p Panel, in layout.Rect) string {
	if len(m.snap.Agents) == 0 {
		return v.renderCatalogue(m, in)
	}

	var b strings.Builder
	b.WriteString(theme.Label.Render(layout.Row(in.W,
		layout.Col{Text: "agent", Width: agentNameWidth(in.W)},
		layout.Col{Text: "R H W P", Width: lampsWidth()},
		layout.Col{Text: "stan"},
	)) + "\n")

	b.WriteString(renderList(in.W, p.Cursor, v.Rows(m)))

	if p.Cursor < len(m.snap.Agents) {
		a := m.snap.Agents[p.Cursor]
		b.WriteString("\n" + theme.TitleDim.Render("Szczegóły") + "\n")
		b.WriteString(kv("rola", a.Role))
		b.WriteString(kv("maszyna", a.Location))
		b.WriteString(kv("puls", relTime(a.LastHeartbeat)))
		if a.Context != nil && a.Context.TokensUsed > 0 {
			b.WriteString(kv("kontekst", fmt.Sprintf("%d/%d", a.Context.TokensUsed, a.Context.TokensLimit)))
		} else {
			b.WriteString(theme.Label.Render(" kontekst  ") + theme.StatusStyle("unknown").Render("brak pisarza") + "\n")
		}
	}
	return b.String()
}

func (agentsPanel) Footer(m *Model, p Panel) string {
	sessionless := 0
	now := time.Now()
	for _, a := range m.snap.Agents {
		if l := api.DeriveLiveness(a, m.snap.Attached[a.Name], now); l.Label() == "BRAK SESJI" {
			sessionless++
		}
	}
	pos := fmt.Sprintf("%d/%d", p.Cursor+1, len(m.snap.Agents))
	if sessionless > 0 {
		return pos + " │ " + theme.StatusStyle("warning").Render(
			fmt.Sprintf("bez sesji %d", sessionless))
	}
	return pos
}

func (agentsPanel) Explain() Doc {
	return Doc{
		TitleKey: "help.agents.title",
		Subtitle: "rejestr, puls, sesja i identyfikator zadania",
		Sections: []Section{{
			Title: "ZAKRES",
			Lines: []string{
				"Jeden wiersz na wpis z /api/agents: nazwa, cztery lampki R H W P,",
				"stan wyprowadzony z lampek i znacznik braku karty roli. Pod",
				"kursorem: rola i maszyna zgłoszone przez agenta, wiek pulsu oraz",
				"licznik kontekstu, jeśli ktokolwiek go zapisuje.",
			},
		}, {
			Title: "ŹRÓDŁA",
			Rows: [][2]string{
				{"R, nazwa, rola, maszyna, puls, zadanie", "core /api/agents"},
				{"W", "core /api/ws/clients — liczą się wpisy ze state=open"},
				{"obecność karty", "core /api/identity/claude-md"},
				{"treść karty", "core /api/identity/claude-md/:agent, z plików AGENTS_DIR"},
			},
		}, {
			Title: "LAMPKI · co znaczą i czego NIE znaczą",
			Rows: [][2]string{
				{"R zarejestrowany", "jest w odpowiedzi /api/agents; dla każdego widocznego wiersza zawsze zapalona. Nie znaczy, że proces działa"},
				{"H puls", "last_heartbeat da się odczytać i ma mniej niż 60 s. Nie znaczy, że wysłał go proces agenta"},
				{"W sesja", "otwarty WebSocket o tej nazwie. Nazwa pochodzi ze ścieżki połączenia i nie jest uwierzytelniana"},
				{"P zadanie", "W zapalone ORAZ current_task niepuste. Nie znaczy, że zadanie istnieje ani że jest wykonywane"},
			},
			Lines: []string{
				"",
				"Puls ustawia wyłącznie POST /api/agents/:name/heartbeat. Rejestracja",
				"i zmiana statusu zapisują updated_at, nie puls — wcześniej robiły",
				"jedno i drugie, więc świeżo zarejestrowany agent bez procesu przez",
				"minutę wyglądał na żywego.",
			},
			Note: "Lampka mówi tyle, ile mierzy. Więcej wyczytać z niej nie wolno.",
		}, {
			Title: "STANY · wyprowadzane z lampek, nigdy wpisywane",
			Rows: [][2]string{
				{"● PRACUJE", "H + W + P"},
				{"● GOTOWY", "H + W, bez P"},
				{"▲ BRAK SESJI [?]", "H zapalone, W zgaszone; [?] prowadzi do pomocy tego wiersza"},
				{"✕ OFFLINE", "brak świeżego H; także przy nietypowym W bez H"},
				{"? NIEZNANY", "nieosiągalny dla wierszy tego panelu: każdy ma R"},
			},
			Lines: []string{
				"",
				"BRAK SESJI znaczy dokładnie tyle: puls jest, otwartego połączenia",
				"nie ma. Sesja to wpis state=open w /api/ws/clients — nie proces,",
				"nie tmux, nie sesja uwierzytelniona.",
			},
		}, {
			Title: "POZOSTAŁE OZNACZENIA",
			Rows: [][2]string{
				{"● / ○ w lampce", "warunek osi spełniony albo nie"},
				{"⚿", "key-server ma klucz publiczny tej tożsamości — agent potrafi się podpisać"},
				{"·bez karty", "katalog kart odczytano i nie ma w nim tej nazwy"},
				{"brak pisarza", "kontekstu nikt nie zapisuje; zero czytałoby się jako pomiar"},
			},
			Lines: []string{
				"",
				"Oba znaczniki pojawiają się dopiero po udanym odczycie swojego",
				"źródła: nieprzeczytane i puste to dwie różne ciszy. Gdy wdrożenie",
				"nie ma key-servera, ⚿ nie pojawia się nigdzie — bo nikt nie",
				"podpisuje, a nie dlatego, że akurat ten agent nie potrafi.",
				"",
				"⚿ jest zapowiedzią: agent bez klucza",
				"przestanie się w ogóle odzywać, a rejestr do końca będzie",
				"wyglądał tak samo.",
			},
		}, {
			Title: "PUSTY REJESTR",
			Lines: []string{
				"Gdy /api/agents nie zwraca nic, panel pokazuje katalog ról z",
				"/api/identity/claude-md — to, co MOŻNA uruchomić, nie to, co działa.",
				"Gdy katalogu nie udało się odczytać, mówi tylko, że rejestr jest pusty.",
			},
		}, {
			Title: "CZEGO PANEL NIE POKAZUJE",
			Lines: []string{
				"Nie używa pola FSM agent.status do wyprowadzenia stanu. Pole jest",
				"pobierane, ale etykieta powstaje wyłącznie z czterech lampek.",
				"",
				"Nie potwierdza procesu systemowego, sesji tmux ani procesu modelu.",
				"Nie sprawdza current_task wobec /api/tasks.",
				"",
				"Nie pokazuje rozjazdu progów: TUI uznaje puls za świeży przez 60 s,",
				"rdzeń przestawia własne pole FSM na OFFLINE dopiero po 120 s. Przez",
				"minutę wiersz może więc mieć zgaszone H przy rdzeniowym statusie",
				"innym niż OFFLINE.",
				"",
				"Nie oznacza osobno nieświeżych lampek. Gdy źródło agents albo ws",
				"padnie po wcześniejszym sukcesie, ostatnie wartości zostają —",
				"awarię i wiek widać w Przeglądzie oraz w nagłówku.",
			},
			Note: "Lampki są czterema pomiarami wejściowymi, nie dowodem pracy ani diagnozą przyczyny.",
		}},
	}
}

type servicesPanel struct{}

func (servicesPanel) Kind() PanelKind     { return PanelServices }
func (servicesPanel) Title() string       { return "Serwisy" }
func (servicesPanel) IconName() string    { return "services" }
func (servicesPanel) Key() string         { return "3" }
func (servicesPanel) Preamble(*Model) int { return 0 }

func (servicesPanel) Rows(m *Model) []Row {
	out := make([]Row, 0, len(m.snap.Services))
	for _, s := range m.snap.Services {
		out = append(out, serviceRow{s: s})
	}
	return out
}

func (v servicesPanel) Render(m *Model, p Panel, in layout.Rect) string {
	if len(m.snap.Services) == 0 {
		if reason, bad := m.snap.Errors["services"]; bad {
			return theme.StatusStyle("down").Render("brak źródła: " +
				layout.Truncate(reason, layout.Remaining(in.W, "brak źródła: ")))
		}
		return theme.Label.Render("rejestr pusty")
	}
	return renderList(in.W, p.Cursor, v.Rows(m))
}

func (servicesPanel) Footer(m *Model, _ Panel) string {
	up := 0
	for _, s := range m.snap.Services {
		if s.Status == "active" {
			up++
		}
	}
	return fmt.Sprintf("%d/%d działa", up, len(m.snap.Services))
}

func (servicesPanel) Explain() Doc {
	return Doc{
		TitleKey: "help.services.title",
		Subtitle: "wyniki sond z machines-server",
		Sections: []Section{{
			Title: "ZAKRES I ŹRÓDŁO",
			Lines: []string{
				"Wpisy z machines-server /api/services, posortowane po porcie.",
				"Rejestr pochodzi z services.yaml, a stan każdej pozycji jest",
				"liczony na nowo przy każdym żądaniu — pole status w pliku nie",
				"jest tym, co widać na ekranie.",
			},
		}, {
			Title: "STANY",
			Rows: [][2]string{
				{"●", "sonda HTTP dostała kod poniżej 500, a przy path: null udało się otworzyć połączenie TCP"},
				{"✕", "błąd połączenia, DNS albo przekroczony czas; także HTTP 500 i wyżej"},
				{"brak źródła", "odczyt /api/services zawiódł i nie ma wcześniejszej listy"},
				{"rejestr pusty", "lista dotarła i nie ma w niej pozycji"},
			},
			Lines: []string{
				"",
				"Wpis z path: null nie mówi po HTTP — sprawdza go zwykłe połączenie",
				"TCP. Pytanie Redisa o /health mogło dać wyłącznie wynik martwy.",
			},
		}, {
			Title: "CZEGO PANEL NIE POKAZUJE",
			Lines: []string{
				"● znaczy osiągalność według tej jednej sondy, nie poprawność",
				"działania usługi. Odpowiedzi 400-499 też liczą się jako aktywne,",
				"więc usługa zwracająca 404 na każdej trasie będzie tu zielona.",
				"",
				"Wiersz nie niesie hosta, kodu HTTP, treści odpowiedzi ani czasu",
				"sondy — typ przekazywany do panelu ma tylko nazwę, port, ścieżkę,",
				"opis i stan.",
				"",
				"Nieczytelny services.yaml machines-server zamienia na pustą listę",
				"i odpowiada 200. Panel pokaże wtedy pusty rejestr, nie błąd pliku.",
				"",
				"Adresy sond opisują widok Z WNĘTRZA sieci kontenerów. Sonda",
				"sprawdzająca localhost pytała samą siebie i raportowała jedną",
				"usługę żywą z ośmiu.",
			},
			Note: "To sonda osiągalności, nie healthcheck.",
		}},
	}
}

type eventsPanel struct{}

func (eventsPanel) Kind() PanelKind     { return PanelEvents }
func (eventsPanel) Title() string       { return "Zdarzenia" }
func (eventsPanel) IconName() string    { return "events" }
func (eventsPanel) Key() string         { return "4" }
func (eventsPanel) Preamble(*Model) int { return 0 }

func (eventsPanel) Rows(m *Model) []Row {
	events := m.stream.Recent(200)
	out := make([]Row, 0, len(events))
	for i := len(events) - 1; i >= 0; i-- {
		out = append(out, eventRow{e: events[i]})
	}
	return out
}

func (v eventsPanel) Render(m *Model, p Panel, in layout.Rect) string {
	rows := v.Rows(m)
	if len(rows) == 0 {
		return theme.Label.Render("cisza na kanałach")
	}
	return renderList(in.W, p.Cursor, rows)
}

func (eventsPanel) Footer(m *Model, _ Panel) string {
	return fmt.Sprintf("%d w buforze │ %.0f/min", len(m.stream.Recent(200)), m.streamState.PerMinute)
}

var channelDocs = [][2]string{
	{"chat", "chat_message — wiadomości między agentami, @nazwa adresuje"},
	{"tasks", "task_created, task_available, task_updated"},
	{"agents", "agent_status_changed — tylko zmiana statusu, sam puls nie"},
	{"logs", "log_added"},
	{"system", "zapis rozmów i podsumowań, dane treningowe, ostrzeżenia o kontekście i dysku"},
	{"notes", "nikt nie nadaje — kanał zadeklarowany, notatki idą samym HTTP"},
	{"machines", "nikt nie nadaje — telemetria maszyn nie trafia na magistralę"},
}

func (eventsPanel) Explain() Doc {
	return Doc{
		TitleKey: "help.events.title",
		Subtitle: "ostatnie ramki strumienia rdzenia",
		Sections: []Section{{
			Title: "ZAKRES I ŹRÓDŁO",
			Lines: []string{
				"Do 200 zdarzeń w buforze klienta, od najnowszego. Ramki przychodzą",
				"WebSocketem z rdzenia; po połączeniu i po każdym ponownym połączeniu",
				"klient dobiera zachowaną historię przez /api/events/recent.",
			},
		}, {
			Title: "KANAŁY I CO NIMI PŁYNIE",
			Rows: [][2]string{
				{"chat", "chat_message"},
				{"tasks", "task_created, task_available, task_claimed, task_updated"},
				{"agents", "agent_status_changed; sam puls bez zmiany stanu nie emituje nic"},
				{"logs", "log_added"},
				{"system", "zapisy rozmów, dane treningowe, podsumowania, ostrzeżenia o kontekście i dysku"},
				{"notes", "zadeklarowany, w rdzeniu nie ma ani jednego nadawcy"},
				{"machines", "zadeklarowany, w rdzeniu nie ma ani jednego nadawcy"},
			},
		}, {
			Title: "OZNACZENIA",
			Rows: [][2]string{
				{"cisza na kanałach", "bufor klienta jest pusty; nie rozstrzyga, czy rdzeń jest połączony"},
				{"UNBOUND", "ramka bez pól channel i type; surowy JSON trafia do data.raw"},
				{"⚠ luka w strumieniu", "rdzeń stwierdził, że żądany numer jest starszy niż bufor; fragment historii przepadł"},
				{"n w buforze", "ile zdarzeń trzyma klient, najwyżej 200"},
				{"x/min", "ile zapisano w ostatnich 60 s"},
			},
		}, {
			Title: "TRZY RÓŻNE CISZE",
			Lines: []string{
				"Kanał bez nadawcy — zadeklarowany, ale nikt w rdzeniu nic w niego",
				"nie wysyła. Pusty panel — bufor klienta jest pusty, co może znaczyć",
				"brak ruchu, brak połączenia albo nieodtworzoną historię. Kanał bez",
				"subskrybenta — trzecia rzecz, widoczna w /api/events/stats, której",
				"ten panel nie pokazuje.",
			},
		}, {
			Title: "CZEGO PANEL NIE POKAZUJE",
			Lines: []string{
				"UNBOUND nie znaczy nieobsługiwany typ. Klient nie ma rejestru",
				"znanych typów i zapisuje każdą ramkę z channel albo type bez",
				"sprawdzania.",
				"",
				"Rdzeń nie dokłada numeru ani czasu do ramki nadawanej na żywo —",
				"robi to tylko w buforze. Dlatego zdarzenie odebrane na żywo ma",
				"numer 0 i czas lokalny, a to samo zdarzenie z odtworzenia ma numer",
				"i czas serwera. Numer rośnie tylko dla niezerowych, więc po",
				"ponownym połączeniu część zdarzeń może pojawić się drugi raz.",
				"",
				"Klient nie subskrybuje kanału notes, choć rdzeń go deklaruje.",
				"",
				"Panel nie potwierdza dostarczenia do konkretnego odbiorcy ani",
				"żadnego skutku zdarzenia.",
			},
			Note: "⚠ luka oznacza fragment utracony bezpowrotnie, nie chwilowe opóźnienie.",
		}},
	}
}

type endpointsPanel struct{}

func (endpointsPanel) Kind() PanelKind     { return PanelEndpoints }
func (endpointsPanel) Title() string       { return "Endpointy" }
func (endpointsPanel) IconName() string    { return "endpoints" }
func (endpointsPanel) Key() string         { return "5" }
func (endpointsPanel) Preamble(*Model) int { return 2 }

func (endpointsPanel) Rows(m *Model) []Row {
	if m.snap.Routes == nil {
		return nil
	}
	out := make([]Row, 0, len(m.snap.Routes.Routes))
	for _, r := range m.snap.Routes.Routes {
		out = append(out, routeRow{r: r})
	}
	return out
}

func (v endpointsPanel) Render(m *Model, p Panel, in layout.Rect) string {
	if m.snap.Routes == nil {
		return theme.StatusStyle("unknown").Render("katalog niedostępny")
	}
	return theme.Label.Render(fmt.Sprintf("%d tras, %d z parametrem",
		m.snap.Routes.Total, m.snap.Routes.Parameterised)) + "\n\n" +
		renderList(in.W, p.Cursor, v.Rows(m))
}

func (endpointsPanel) Footer(m *Model, p Panel) string {
	if m.snap.Routes == nil {
		return ""
	}
	return fmt.Sprintf("%d/%d │ %d z param.",
		p.Cursor+1, len(m.snap.Routes.Routes), m.snap.Routes.Parameterised)
}

func (endpointsPanel) Explain() Doc {
	return Doc{
		TitleKey: "help.endpoints.title",
		Subtitle: "katalog tras rdzenia",
		Sections: []Section{{
			Title: "ZAKRES I ŹRÓDŁO",
			Lines: []string{
				"Ścieżki i metody z /api/_routes. Rdzeń buduje ten katalog ze swojego",
				"routera, więc lista nie może rozjechać się z tym, co serwer naprawdę",
				"obsługuje — nie jest to osobno utrzymywany dokument.",
			},
		}, {
			Title: "OZNACZENIA",
			Rows: [][2]string{
				{"jasna ścieżka", "bez parametru; da się wywołać wprost"},
				{"przygaszona ścieżka", "wymaga podstawienia parametru, np. :id"},
				{"katalog niedostępny", "źródło nie odpowiedziało przed pierwszym sukcesem"},
				{"n tras, p z parametrem", "liczniki podane przez rdzeń"},
			},
			Lines: []string{
				"",
				"Przygaszenie opisuje składnię ścieżki, nie wynik pomiaru.",
			},
		}, {
			Title: "CZEGO PANEL NIE POKAZUJE",
			Lines: []string{
				"Panel nie wywołuje tych tras. Jasny wiersz nie znaczy, że endpoint",
				"sprawdzono ani że odpowie poprawnie — obecność w routerze dowodzi",
				"rejestracji, nie działania.",
				"",
				"Katalog nie niesie opisu, schematu żądania i odpowiedzi, wymagań",
				"uwierzytelnienia ani kodów błędów. To jest znany brak: dokumentacja",
				"operacji ma pochodzić z kontraktu OpenAPI zestawianego z routerem,",
				"a nie z drugiej listy pisanej ręcznie obok.",
				"",
				"Jedna ścieżka z kilkoma metodami jest tu jednym wierszem, choć GET",
				"i POST na tym samym adresie to różne operacje o różnych skutkach.",
			},
		}},
	}
}

type tasksPanel struct{}

func (tasksPanel) Kind() PanelKind     { return PanelTasks }
func (tasksPanel) Title() string       { return "Zadania" }
func (tasksPanel) IconName() string    { return "tasks" }
func (tasksPanel) Key() string         { return "6" }
func (tasksPanel) Preamble(*Model) int { return 0 }

func (tasksPanel) Rows(m *Model) []Row {
	out := make([]Row, 0, len(m.snap.Tasks))
	for _, t := range m.snap.Tasks {
		out = append(out, taskRow{t: t})
	}
	return out
}

func (v tasksPanel) Render(m *Model, p Panel, in layout.Rect) string {
	if len(m.snap.Tasks) == 0 {
		return theme.Label.Render("brak zadań")
	}
	return renderList(in.W, p.Cursor, v.Rows(m))
}

func (tasksPanel) Footer(*Model, Panel) string { return "" }

func (tasksPanel) Explain() Doc {
	return Doc{
		TitleKey: "help.tasks.title",
		Subtitle: "zadania przechowywane przez rdzeń",
		Sections: []Section{{
			Title: "ZAKRES I ŹRÓDŁO",
			Lines: []string{
				"Wszystkie pozycje z /api/tasks, w kolejności podanej przez serwer —",
				"bez sortowania i filtrowania po stronie panelu. Wiersz niesie stan,",
				"wykonawcę i tytuł.",
			},
		}, {
			Title: "STANY I CO RDZEŃ PRZY NICH ZAPISUJE",
			Rows: [][2]string{
				{"PENDING", "stan początkowy; zadanie bywa przypisane albo leży w puli bez wykonawcy"},
				{"IN_PROGRESS", "rdzeń zapisuje czas rozpoczęcia, a jeśli brakowało — także czas przejęcia"},
				{"DONE", "rdzeń zapisuje czas zakończenia i opcjonalny wynik"},
				{"FAILED", "jak wyżej: czas zakończenia i opcjonalny wynik"},
				{"CANCELLED", "stan dozwolony, ale obecny handler nie zapisuje przy nim czasu zakończenia"},
			},
		}, {
			Title: "OZNACZENIA",
			Rows: [][2]string{
				{"pusty wykonawca", "brak przypisania; w pomocy wiersza pokazywane jako niczyje"},
				{"brak zadań", "lista jest pusta"},
			},
			Lines: []string{
				"",
				"Panel sam nie odróżnia poprawnej pustej odpowiedzi od pierwszego",
				"nieudanego odczytu — stan źródła widać w Przeglądzie.",
			},
		}, {
			Title: "CZEGO PANEL NIE POKAZUJE",
			Lines: []string{
				"Nie pokazuje opisu, metadanych, wyniku ani czasów przejęcia,",
				"rozpoczęcia i zakończenia. Rdzeń je trzyma, typ panelu nie.",
				"",
				"Nie sprawdza, czy przypisany agent istnieje, ma puls albo sesję.",
				"Zadanie przypisane wpisowi bez procesu zostanie przyjęte i nigdy",
				"wykonane.",
				"",
				"PENDING nie mówi, dlaczego zadanie czeka: może być nieprzypisane",
				"i leżeć w puli, albo przypisane komuś, kto go nie tknął.",
				"",
				"To widok odczytu. Nie dowodzi, że zadanie zostanie podjęte.",
			},
			Note: "Stan zadania jest wartością zapisaną przez rdzeń, nie pomiarem pracy.",
		}},
	}
}

type graphPanel struct{}

func (graphPanel) Kind() PanelKind  { return PanelGraph }
func (graphPanel) Title() string    { return "Zależności" }
func (graphPanel) IconName() string { return "graph" }
func (graphPanel) Key() string      { return "7" }

func (graphPanel) Preamble(m *Model) int {
	if m.snap.Graph != nil && m.snap.Graph.UnknownNodes > 0 {
		return 3
	}
	return 2
}

func (graphPanel) Rows(m *Model) []Row {
	g := m.snap.Graph
	if g == nil {
		return nil
	}
	unknown := make(map[string]bool, len(g.Nodes))
	for _, n := range g.Nodes {
		if n.Unknown {
			unknown[n.ID] = true
		}
	}

	out := make([]Row, 0, len(g.Edges))
	for _, e := range g.Edges {
		out = append(out, edgeRow{e: e, fromUnknown: unknown[e.From], toUnknown: unknown[e.To]})
	}
	return out
}

func (v graphPanel) Render(m *Model, p Panel, in layout.Rect) string {
	g := m.snap.Graph
	if g == nil {
		return theme.StatusStyle("unknown").Render("graf niedostępny")
	}

	var b strings.Builder
	b.WriteString(theme.Label.Render(fmt.Sprintf("%d węzłów · %d krawędzi", g.TotalNodes, g.TotalEdges)) + "\n")
	if g.UnknownNodes > 0 {
		b.WriteString(theme.StatusStyle("warning").Render(fmt.Sprintf("%d nieznanych uczestników", g.UnknownNodes)) + "\n")
	}
	b.WriteString("\n")
	b.WriteString(renderList(in.W, p.Cursor, v.Rows(m)))
	return b.String()
}

func (graphPanel) Footer(m *Model, _ Panel) string {
	g := m.snap.Graph
	if g == nil {
		return ""
	}
	if g.UnknownNodes > 0 {
		return fmt.Sprintf("%d krawędzi │ ", len(g.Edges)) +
			theme.StatusStyle("warning").Render(fmt.Sprintf("%d nieznanych", g.UnknownNodes))
	}
	return fmt.Sprintf("%d krawędzi", len(g.Edges))
}

func (graphPanel) Explain() Doc {
	return Doc{
		TitleKey: "help.graph.title",
		Subtitle: "graf logiczny budowany przez rdzeń",
		Sections: []Section{{
			Title: "ZAKRES I ŹRÓDŁO",
			Lines: []string{
				"Skierowane krawędzie z /api/graph wraz z liczbą węzłów, krawędzi",
				"i węzłów nieznanych. Panel niczego nie wylicza — rysuje to, co",
				"rdzeń zbudował ze swoich rejestrów.",
			},
		}, {
			Title: "CO JEST WĘZŁEM",
			Lines: []string{
				"Agenci, maszyny podane w polu location, zadania, kanały zdarzeń,",
				"otwarte połączenia i grupy tras. To graf bytów, o których rdzeń",
				"wie z rejestrów.",
			},
		}, {
			Title: "RODZAJE KRAWĘDZI",
			Rows: [][2]string{
				{"runs_on", "agent → maszyna, z pola location w rejestrze; nie jest to sonda maszyny"},
				{"assigns", "zlecający → wykonawca zadania, gdy oba są podane i różne"},
				{"emits", "rdzeń → kanał, dla każdego zadeklarowanego kanału, także takiego bez ruchu"},
				{"subscribes", "otwarty klient → kanał, który subskrybuje"},
				{"serves", "rdzeń → grupa tras; grupa to pierwszy segment po /api/"},
			},
		}, {
			Title: "OZNACZENIA",
			Rows: [][2]string{
				{"?", "węzeł wskazany przez coś, ale nieobecny w żadnym rejestrze"},
				{"graf niedostępny", "brak odpowiedzi z /api/graph"},
			},
			Lines: []string{
				"",
				"Nieznany węzeł zostaje na ekranie ze znakiem zapytania, zamiast",
				"zniknąć. Poprzednia wersja rysowała jedną krawędź, bo brakujących",
				"uczestników po prostu pomijała.",
			},
		}, {
			Title: "CZEGO PANEL NIE POKAZUJE",
			Lines: []string{
				"To NIE jest graf zależności wdrożeniowych. Nie ma tu Redisa,",
				"Ollamy, Postgresa, semantic-search, machines-servera, key-servera",
				"ani memory-servera — czyli niczego, co",
				"odpowiada na pytanie, co przestanie działać po awarii usługi.",
				"",
				"Zależności wykonawcze wynikają z compose i z wywołań między",
				"blokami; obecne źródło ich nie zawiera i wymagają osobnego widoku.",
			},
			Note: "Graf pokazuje, kto o kim wie, nie kto bez kogo nie zadziała.",
		}},
	}
}
