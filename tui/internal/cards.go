package internal

import (
	"context"
	"strings"
	"sync"
	"time"
)

type cardState int

const (
	cardUnknown cardState = iota
	cardLoading
	cardReady
	cardMissing
	cardFailed
)

type card struct {
	state cardState
	text  string
	err   string
	at    time.Time
}

type cardStore struct {
	mu sync.RWMutex
	by map[string]card
}

func newCardStore() *cardStore { return &cardStore{by: map[string]card{}} }

func (s *cardStore) get(agent string) card {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.by[strings.ToUpper(agent)]
}

func (s *cardStore) set(agent string, c card) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c.at = time.Now()
	s.by[strings.ToUpper(agent)] = c
}

func (m *Model) want(agent string) bool {
	if agent == "" {
		return false
	}
	if c := m.cards.get(agent); c.state != cardUnknown {
		return false
	}
	m.cards.set(agent, card{state: cardLoading})
	return true
}

func (m *Model) fetchCard(agent string) func() any {
	return func() any {
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()

		text, err := m.client.AgentCard(ctx, agent)
		if err != nil {
			if strings.Contains(err.Error(), "HTTP 404") {
				return cardMsg{agent: agent, card: card{state: cardMissing}}
			}
			return cardMsg{agent: agent, card: card{state: cardFailed, err: err.Error()}}
		}
		return cardMsg{agent: agent, card: card{state: cardReady, text: text}}
	}
}

type cardMsg struct {
	agent string
	card  card
}

func cardSection(agent string, c card) Section {
	switch c.state {
	case cardReady:
		return Section{Title: "Rola według karty", Lines: cardLines(c.text)}
	case cardLoading:
		return Section{Title: "Rola według karty", Lines: []string{"czytam z rdzenia…"}}
	case cardMissing:
		return Section{
			Title: "Rola według karty",
			Lines: []string{"Rdzeń nie ma karty dla tego agenta."},
			Note:  "Karta to plik agents/" + strings.ToLower(agent) + ".md po stronie rdzenia.",
		}
	case cardFailed:
		return Section{
			Title: "Rola według karty",
			Lines: []string{"Nie udało się zapytać rdzenia:", c.err},
		}
	default:
		return Section{Title: "Rola według karty", Lines: []string{"jeszcze nie pytaliśmy"}}
	}
}

func cardLines(md string) []string {
	const maxLines = 24

	out := make([]string, 0, maxLines)
	for _, raw := range strings.Split(md, "\n") {
		line := strings.TrimSpace(raw)
		switch {
		case line == "":
			if len(out) > 0 && out[len(out)-1] != "" {
				out = append(out, "")
			}
			continue
		case strings.HasPrefix(line, "```"):
			continue
		case strings.HasPrefix(line, "#"):
			line = strings.TrimSpace(strings.TrimLeft(line, "#"))
		}
		line = strings.ReplaceAll(line, "**", "")

		out = append(out, line)
		if len(out) >= maxLines {
			out = append(out, "", "… dalszy ciąg karty po stronie rdzenia")
			break
		}
	}
	if len(out) == 0 {
		return []string{"Karta jest pusta."}
	}
	return out
}
