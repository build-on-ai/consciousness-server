package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

type Client struct {
	CoreURL     string
	MachinesURL string
	KeysURL     string
	HTTP        *http.Client

	Signer *Signer

	mu       sync.RWMutex
	lastGood Snapshot
	haveGood bool
}

func New(coreURL, machinesURL string) *Client {
	return &Client{
		CoreURL:     coreURL,
		MachinesURL: machinesURL,
		HTTP:        &http.Client{Timeout: 4 * time.Second},
	}
}

func (c *Client) getJSON(ctx context.Context, url string, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if c.Signer != nil {
		if err := c.Signer.Sign(req, pathOf(url), nil); err != nil {
			return err
		}
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(into)
}

type source struct {
	Name string
	Get  func(context.Context, *Client) (func(*Snapshot), error)
}

var sources = []source{
	{"health", func(ctx context.Context, c *Client) (func(*Snapshot), error) {
		var h Health
		err := c.getJSON(ctx, c.CoreURL+"/health", &h)
		return func(s *Snapshot) { s.Health = &h }, err
	}},
	{"agents", func(ctx context.Context, c *Client) (func(*Snapshot), error) {
		var env agentsEnvelope
		err := c.getJSON(ctx, c.CoreURL+"/api/agents", &env)
		sort.Slice(env.Agents, func(i, j int) bool { return env.Agents[i].Name < env.Agents[j].Name })
		return func(s *Snapshot) { s.Agents = env.Agents }, err
	}},
	{"tasks", func(ctx context.Context, c *Client) (func(*Snapshot), error) {
		var env tasksEnvelope
		err := c.getJSON(ctx, c.CoreURL+"/api/tasks", &env)
		sort.Slice(env.Tasks, func(i, j int) bool {
			if env.Tasks[i].Status != env.Tasks[j].Status {
				return env.Tasks[i].Status < env.Tasks[j].Status
			}
			return env.Tasks[i].ID < env.Tasks[j].ID
		})
		return func(s *Snapshot) { s.Tasks = env.Tasks }, err
	}},
	{"services", func(ctx context.Context, c *Client) (func(*Snapshot), error) {
		var env servicesEnvelope
		err := c.getJSON(ctx, c.MachinesURL+"/api/services", &env)
		list := make([]Service, 0, len(env.Services))
		for name, svc := range env.Services {
			svc.Name = name
			list = append(list, svc)
		}
		sort.Slice(list, func(i, j int) bool { return list[i].Port < list[j].Port })
		return func(s *Snapshot) { s.Services = list }, err
	}},
	{"routes", func(ctx context.Context, c *Client) (func(*Snapshot), error) {
		var cat RouteCatalogue
		err := c.getJSON(ctx, c.CoreURL+"/api/_routes", &cat)
		return func(s *Snapshot) { s.Routes = &cat }, err
	}},
	{"events", func(ctx context.Context, c *Client) (func(*Snapshot), error) {
		var st EventStats
		err := c.getJSON(ctx, c.CoreURL+"/api/events/stats", &st)
		return func(s *Snapshot) { s.Stats = &st }, err
	}},
	{"ws", func(ctx context.Context, c *Client) (func(*Snapshot), error) {
		var env wsClientsEnvelope
		err := c.getJSON(ctx, c.CoreURL+"/api/ws/clients", &env)
		attached := map[string]bool{}
		for _, cl := range env.Clients {
			if cl.State == "open" {
				attached[cl.Agent] = true
			}
		}
		return func(s *Snapshot) { s.Attached = attached }, err
	}},
	{"cards", func(ctx context.Context, c *Client) (func(*Snapshot), error) {
		var out struct {
			Agents []string `json:"agents"`
		}
		err := c.getJSON(ctx, c.CoreURL+"/api/identity/claude-md", &out)
		have := make(map[string]bool, len(out.Agents))
		for _, name := range out.Agents {
			have[strings.ToUpper(name)] = true
		}
		return func(s *Snapshot) { s.CardNames = have }, err
	}},
	{"keys", func(ctx context.Context, c *Client) (func(*Snapshot), error) {
		if c.KeysURL == "" {
			return func(s *Snapshot) { s.KeyNames = nil }, nil
		}
		var out struct {
			Agents []string `json:"agents"`
		}
		err := c.getJSON(ctx, c.KeysURL+"/api/agents/identity", &out)
		have := make(map[string]bool, len(out.Agents))
		for _, name := range out.Agents {
			have[strings.ToUpper(name)] = true
		}
		return func(s *Snapshot) { s.KeyNames = have }, err
	}},
	{"graph", func(ctx context.Context, c *Client) (func(*Snapshot), error) {
		var g Graph
		err := c.getJSON(ctx, c.CoreURL+"/api/graph", &g)
		return func(s *Snapshot) { s.Graph = &g }, err
	}},
}

func SourceNames() []string {
	names := make([]string, 0, len(sources))
	for _, s := range sources {
		names = append(names, s.Name)
	}
	return names
}

func (c *Client) Fetch(ctx context.Context) Snapshot {
	now := time.Now()
	snap := Snapshot{
		At:      now,
		Errors:  map[string]string{},
		Checked: map[string]bool{},
		Fresh:   map[string]time.Time{},
	}
	var mu sync.Mutex
	var wg sync.WaitGroup

	for _, src := range sources {
		wg.Add(1)
		go func(src source) {
			defer wg.Done()
			apply, err := src.Get(ctx, c)

			mu.Lock()
			defer mu.Unlock()
			snap.Checked[src.Name] = true
			if err != nil {
				snap.Errors[src.Name] = err.Error()
				return
			}
			apply(&snap)
			snap.Fresh[src.Name] = now
		}(src)
	}

	wg.Wait()

	c.mu.Lock()
	if c.haveGood {
		if snap.Health == nil {
			snap.Health = c.lastGood.Health
		}
		if snap.Agents == nil {
			snap.Agents = c.lastGood.Agents
		}
		if snap.Tasks == nil {
			snap.Tasks = c.lastGood.Tasks
		}
		if snap.Services == nil {
			snap.Services = c.lastGood.Services
		}
		if snap.Routes == nil {
			snap.Routes = c.lastGood.Routes
		}
		if snap.Stats == nil {
			snap.Stats = c.lastGood.Stats
		}
		if snap.Graph == nil {
			snap.Graph = c.lastGood.Graph
		}
		if snap.Attached == nil {
			snap.Attached = c.lastGood.Attached
		}
		if snap.CardNames == nil {
			snap.CardNames = c.lastGood.CardNames
		}
		for name, when := range c.lastGood.Fresh {
			if _, refreshed := snap.Fresh[name]; !refreshed {
				snap.Fresh[name] = when
			}
		}
	}
	c.lastGood = snap
	c.haveGood = true
	c.mu.Unlock()

	return snap
}

func (c *Client) EventsSince(ctx context.Context, since int) (*EventPage, error) {
	var page EventPage
	url := fmt.Sprintf("%s/api/events/recent?since=%d&limit=200", c.CoreURL, since)
	if err := c.getJSON(ctx, url, &page); err != nil {
		return nil, err
	}
	return &page, nil
}

func DeriveLiveness(a Agent, attached bool, now time.Time) Liveness {
	l := Liveness{Registered: true, Attached: attached}

	if a.LastHeartbeat != "" {
		if t, err := time.Parse(time.RFC3339, a.LastHeartbeat); err == nil {
			l.Heartbeat = now.Sub(t) < 60*time.Second
		}
	}
	l.Working = l.Attached && a.CurrentTask != ""
	return l
}

func (c *Client) PostJSON(ctx context.Context, path string, payload any, into any) error {
	if c.Signer == nil {
		return fmt.Errorf("wysyłka wymaga podpisu: uruchom z --as i --key")
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.CoreURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if err := c.Signer.Sign(req, path, body); err != nil {
		return err
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	if into == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(into)
}

func (c *Client) AgentCard(ctx context.Context, agent string) (string, error) {
	var out struct {
		Agent    string `json:"agent"`
		ClaudeMD string `json:"claude_md"`
	}
	if err := c.getJSON(ctx, c.CoreURL+"/api/identity/claude-md/"+strings.ToUpper(agent), &out); err != nil {
		return "", err
	}
	return out.ClaudeMD, nil
}

func pathOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	return u.Path
}
