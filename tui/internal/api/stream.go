package api

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type StreamState struct {
	Connected   bool
	Since       time.Time
	LastEventAt time.Time
	LatestSeq   int
	Gapped      bool
	LastError   string
	Received    int
	PerMinute   float64
}

type Stream struct {
	client *Client

	mu     sync.RWMutex
	state  StreamState
	recent []Event

	events chan Event
	stop   chan struct{}
	once   sync.Once

	seenSeq int
	counts  []time.Time
}

const recentEventLimit = 200

func NewStream(c *Client) *Stream {
	return &Stream{
		client: c,
		events: make(chan Event, 256),
		stop:   make(chan struct{}),
	}
}

func (s *Stream) Events() <-chan Event { return s.events }

func (s *Stream) State() StreamState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.state
}

func (s *Stream) Recent(n int) []Event {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if n > len(s.recent) {
		n = len(s.recent)
	}
	out := make([]Event, n)
	copy(out, s.recent[len(s.recent)-n:])
	return out
}

func (s *Stream) Seed(events ...Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recent = append(s.recent, events...)
	if len(s.recent) > recentEventLimit {
		s.recent = s.recent[len(s.recent)-recentEventLimit:]
	}
}

func (s *Stream) Stop() {
	s.once.Do(func() { close(s.stop) })
}

func (s *Stream) Run(agentName string) {
	backoff := time.Second
	for {
		select {
		case <-s.stop:
			return
		default:
		}

		if err := s.connectOnce(agentName); err != nil {
			s.setError(err.Error())
			select {
			case <-s.stop:
				return
			case <-time.After(backoff):
			}
			if backoff < 15*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
	}
}

func (s *Stream) connectOnce(agentName string) error {
	wsURL, err := coreToWS(s.client.CoreURL, agentName)
	if err != nil {
		return err
	}

	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return err
	}
	defer conn.Close()

	s.mu.Lock()
	s.state.Connected = true
	s.state.Since = time.Now()
	s.state.LastError = ""
	s.mu.Unlock()

	sub := map[string]any{"type": "subscribe", "channels": []string{"tasks", "agents", "logs", "system", "chat", "machines"}}
	if err := conn.WriteJSON(sub); err != nil {
		s.markDisconnected(err.Error())
		return err
	}

	go s.replayGap()

	go func() {
		<-s.stop
		conn.Close()
	}()

	for {
		var raw map[string]any
		if err := conn.ReadJSON(&raw); err != nil {
			s.markDisconnected(err.Error())
			return err
		}
		s.ingest(raw)
	}
}

func (s *Stream) replayGap() {
	s.mu.RLock()
	since := s.seenSeq
	s.mu.RUnlock()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	page, err := s.client.EventsSince(ctx, since)
	if err != nil || page == nil {
		return
	}
	for _, e := range page.Events {
		s.record(e)
	}
	s.mu.Lock()
	s.state.Gapped = page.Gapped
	s.mu.Unlock()
}

func (s *Stream) ingest(raw map[string]any) {
	if t, _ := raw["type"].(string); t == "connected" {
		if seq, ok := raw["latest_seq"].(float64); ok {
			s.mu.Lock()
			s.state.LatestSeq = int(seq)
			s.mu.Unlock()
		}
		return
	}
	if t, _ := raw["type"].(string); t == "subscribed" || t == "unsubscribed" || t == "pong" {
		return
	}

	ev := Event{}
	if ch, ok := raw["channel"].(string); ok {
		ev.Channel = ch
	}
	if ty, ok := raw["type"].(string); ok {
		ev.Type = ty
	}
	if d, ok := raw["data"].(map[string]any); ok {
		ev.Data = d
	}
	if seq, ok := raw["seq"].(float64); ok {
		ev.Seq = int(seq)
	}
	ev.Timestamp = time.Now().Format(time.RFC3339)

	if ev.Channel == "" && ev.Type == "" {
		if b, err := json.Marshal(raw); err == nil {
			ev.Channel = "system"
			ev.Type = "unbound"
			ev.Data = map[string]any{"raw": string(b)}
		}
	}
	s.record(ev)
}

func (s *Stream) record(ev Event) {
	now := time.Now()

	s.mu.Lock()
	s.recent = append(s.recent, ev)
	if len(s.recent) > recentEventLimit {
		s.recent = s.recent[len(s.recent)-recentEventLimit:]
	}
	if ev.Seq > s.seenSeq {
		s.seenSeq = ev.Seq
		s.state.LatestSeq = ev.Seq
	}
	s.state.LastEventAt = now
	s.state.Received++

	s.counts = append(s.counts, now)
	cutoff := now.Add(-time.Minute)
	keep := s.counts[:0]
	for _, t := range s.counts {
		if t.After(cutoff) {
			keep = append(keep, t)
		}
	}
	s.counts = keep
	s.state.PerMinute = float64(len(s.counts))
	s.mu.Unlock()

	select {
	case s.events <- ev:
	default:
	}
}

func (s *Stream) markDisconnected(reason string) {
	s.mu.Lock()
	s.state.Connected = false
	s.state.LastError = reason
	s.mu.Unlock()
}

func (s *Stream) setError(reason string) {
	s.mu.Lock()
	s.state.Connected = false
	s.state.LastError = reason
	s.mu.Unlock()
}

func coreToWS(coreURL, agentName string) (string, error) {
	u, err := url.Parse(coreURL)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	default:
		u.Scheme = "ws"
	}
	u.Path = "/" + strings.TrimPrefix(agentName, "/")
	return u.String(), nil
}
