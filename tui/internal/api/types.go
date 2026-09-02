package api

import (
	"encoding/json"
	"sort"
	"strings"
	"time"
)

type Agent struct {
	Name          string   `json:"name"`
	Location      string   `json:"location"`
	Role          string   `json:"role"`
	Status        string   `json:"status"`
	Capabilities  []string `json:"capabilities"`
	RegisteredAt  string   `json:"registered_at"`
	LastHeartbeat string   `json:"last_heartbeat"`
	CurrentTask   string   `json:"current_task"`
	Context       *struct {
		TokensUsed  int `json:"tokens_used"`
		TokensLimit int `json:"tokens_limit"`
	} `json:"context"`
}

type agentsEnvelope struct {
	Total  int     `json:"total"`
	Agents []Agent `json:"agents"`
}

type Task struct {
	ID         string `json:"id"`
	Project    string `json:"project"`
	Title      string `json:"title"`
	Status     string `json:"status"`
	Priority   string `json:"priority"`
	AssignedTo string `json:"assigned_to"`
	CreatedBy  string `json:"created_by"`
	CreatedAt  string `json:"created_at"`

	Description string `json:"description"`

	Result   json.RawMessage `json:"result"`
	Metadata json.RawMessage `json:"metadata"`

	ClaimedAt   string `json:"claimed_at"`
	StartedAt   string `json:"started_at"`
	CompletedAt string `json:"completed_at"`
}

func (t Task) ResultText() string { return rawText(t.Result) }

func (t Task) MetadataText() string { return rawText(t.Metadata) }

func rawText(raw json.RawMessage) string {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return ""
	}

	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		return str
	}

	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err == nil {
		keys := make([]string, 0, len(obj))
		for k := range obj {
			keys = append(keys, k)
		}
		sort.Strings(keys)

		parts := make([]string, 0, len(keys))
		for _, k := range keys {
			v := obj[k]
			if s, ok := v.(string); ok {
				parts = append(parts, k+": "+s)
				continue
			}
			b, _ := json.Marshal(v)
			parts = append(parts, k+": "+string(b))
		}
		return strings.Join(parts, "\n")
	}

	return s
}

var TaskStatuses = []string{"PENDING", "IN_PROGRESS", "DONE", "FAILED", "CANCELLED"}

type tasksEnvelope struct {
	Total int    `json:"total"`
	Tasks []Task `json:"tasks"`
}

type Service struct {
	Name        string `json:"-"`
	Port        int    `json:"port"`
	Path        string `json:"path"`
	Description string `json:"description"`
	Status      string `json:"status"`
}

type servicesEnvelope struct {
	CheckedAt string             `json:"checked_at"`
	Services  map[string]Service `json:"services"`
}

type Event struct {
	Seq       int            `json:"seq"`
	Channel   string         `json:"channel"`
	Type      string         `json:"type"`
	Timestamp string         `json:"timestamp"`
	Data      map[string]any `json:"data"`
}

type EventPage struct {
	Events         []Event `json:"events"`
	Total          int     `json:"total"`
	LatestSeq      int     `json:"latest_seq"`
	BufferStart    int     `json:"buffer_start"`
	BufferSize     int     `json:"buffer_size"`
	BufferCapacity int     `json:"buffer_capacity"`
	Gapped         bool    `json:"gapped"`
}

type EventStats struct {
	Channels          []string       `json:"channels"`
	BufferedByType    map[string]int `json:"buffered_by_type"`
	BufferedByChan    map[string]int `json:"buffered_by_channel"`
	SubscribersByChan map[string]int `json:"subscribers_by_channel"`
	WSClients         int            `json:"ws_clients"`
	TotalEmitted      int            `json:"total_emitted"`
}

type Route struct {
	Path          string   `json:"path"`
	Methods       []string `json:"methods"`
	Parameterised bool     `json:"parameterised"`
}

type RouteCatalogue struct {
	Service       string  `json:"service"`
	Version       string  `json:"version"`
	Total         int     `json:"total"`
	Parameterised int     `json:"parameterised"`
	Routes        []Route `json:"routes"`
}

type GraphNode struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Label   string `json:"label"`
	Unknown bool   `json:"unknown"`
	Count   int    `json:"count"`
}

type GraphEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
	Kind string `json:"kind"`
}

type Graph struct {
	Nodes        []GraphNode `json:"nodes"`
	Edges        []GraphEdge `json:"edges"`
	TotalNodes   int         `json:"total_nodes"`
	TotalEdges   int         `json:"total_edges"`
	UnknownNodes int         `json:"unknown_nodes"`
}

type WSClient struct {
	Agent       string   `json:"agent"`
	ConnectedAt string   `json:"connected_at"`
	Channels    []string `json:"channels"`
	State       string   `json:"state"`
}

type wsClientsEnvelope struct {
	Clients []WSClient `json:"clients"`
	Total   int        `json:"total"`
}

type Health struct {
	Status           string `json:"status"`
	Uptime           int    `json:"uptime"`
	Version          string `json:"version"`
	Redis            string `json:"redis"`
	SemanticSearch   string `json:"semantic_search"`
	RedisDownSeconds int    `json:"redis_down_seconds"`
	Memory           struct {
		Tasks        int `json:"tasks"`
		Logs         int `json:"logs"`
		Agents       int `json:"agents"`
		Notes        int `json:"notes"`
		ChatMessages int `json:"chat_messages"`
	} `json:"memory"`
}

type Liveness struct {
	Registered bool
	Heartbeat  bool
	Attached   bool
	Working    bool

	Process bool
	Local   bool
}

func (l Liveness) Label() string {
	switch {
	case l.Heartbeat && l.Attached && l.Working:
		return "PRACUJE"
	case l.Heartbeat && l.Attached:
		return "GOTOWY"
	case l.Heartbeat:
		return "BRAK SESJI"
	case l.Local && l.Process:
		return "BEZ MELDUNKU"
	case l.Registered:
		return "OFFLINE"
	default:
		return "NIEZNANY"
	}
}

func (l Liveness) WithLocalProcess(running, local bool) Liveness {
	l.Local = local
	l.Process = running
	return l
}

type Snapshot struct {
	At       time.Time
	Health   *Health
	Agents   []Agent
	Tasks    []Task
	Services []Service
	Routes   *RouteCatalogue
	Stats    *EventStats
	Graph    *Graph
	Attached map[string]bool

	Running   map[string]bool
	Host      string
	Errors    map[string]string
	Checked   map[string]bool
	Fresh     map[string]time.Time
	CardNames map[string]bool
	KeyNames  map[string]bool
}

func (s Snapshot) HasKey(agent string) bool {
	return s.KeyNames[strings.ToUpper(agent)]
}

func (s Snapshot) HasCard(agent string) bool {
	return s.CardNames[strings.ToUpper(agent)]
}

func (s Snapshot) CardList() []string {
	out := make([]string, 0, len(s.CardNames))
	for name := range s.CardNames {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func (s Snapshot) AgeOf(source string, now time.Time) (age time.Duration, known bool) {
	when, ok := s.Fresh[source]
	if !ok || when.IsZero() {
		return 0, false
	}
	return now.Sub(when), true
}

func (s Snapshot) Stale(now time.Time, threshold time.Duration) (count int, oldest time.Duration) {
	for name := range s.Fresh {
		if age, ok := s.AgeOf(name, now); ok && age > threshold {
			count++
			if age > oldest {
				oldest = age
			}
		}
	}
	return count, oldest
}

func (s Snapshot) SourceState(name string) string {
	if _, bad := s.Errors[name]; bad {
		return "down"
	}
	if s.Checked[name] {
		return "ok"
	}
	return "pending"
}
