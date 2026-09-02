package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"github.com/build-on-ai/consciousness-server/tui/internal/api"
	"github.com/build-on-ai/consciousness-server/tui/internal/ports"
	"github.com/build-on-ai/consciousness-server/tui/internal/tmux"
)

func main() {
	agent := flag.String("as", envOr("BOA_AGENT", ""), "agent name to report as")
	core := flag.String("core", envOr("BOA_CORE", ports.URL("consciousness-server", 3032)), "consciousness-server base URL")
	role := flag.String("role", "Observer", "role recorded at registration")
	location := flag.String("location", hostnameOr("laptop"), "machine this agent runs on")
	interval := flag.Duration("interval", 30*time.Second, "heartbeat interval (panel treats >60s as stale)")
	keyPath := flag.String("key", envOr("BOA_SIGNING_KEY", ""), "path to an OpenSSH ed25519 private key; without it registration and heartbeats go out unsigned")
	accept := flag.Bool("accept-prompts", false, "type chat messages addressed to this agent into its tmux pane")
	session := flag.String("session", envOr("BOA_SESSION", ""), "tmux session to type into; empty means find any pane running an agent")
	flag.Parse()

	if *agent == "" {
		fmt.Fprintln(os.Stderr, "presence: --as <NAZWA> is required")
		os.Exit(2)
	}

	var signer *api.Signer
	if resolved := api.ResolveKeyPath(*agent, *keyPath); resolved != "" {
		s, err := api.LoadSigner(*agent, resolved)
		if err != nil {
			fmt.Fprintf(os.Stderr, "presence: %v\n", err)
			os.Exit(1)
		}
		signer = s
		fmt.Printf("presence: podpisuje jako %s kluczem %s\n", *agent, resolved)
	} else {
		fmt.Fprintf(os.Stderr, "presence: BEZ PODPISU (--key / BOA_SIGNING_KEY nieustawione); "+
			"rdzeń odrzuci rejestrację i puls\n")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client := &http.Client{Timeout: 5 * time.Second}

	if err := register(ctx, client, signer, *core, *agent, *role, *location); err != nil {
		fmt.Fprintf(os.Stderr, "presence: registration failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("presence: %s zarejestrowany w %s\n", *agent, *core)

	if *accept {
		if !tmux.Available() {
			fmt.Fprintln(os.Stderr, "presence: --accept-prompts, ale tmux jest niedostępny — nie ma gdzie pisać")
			os.Exit(1)
		}
		names, src := tmux.AgentNames()
		fmt.Printf("presence: przyjmuje prompty i wpisuje je w sesję %s\n",
			orAny(*session))
		fmt.Printf("presence: za agenta uznaję: %s (lista: %s)\n",
			strings.Join(names, ", "), src)
	}

	go heartbeatLoop(ctx, client, signer, *core, *agent, *interval)
	go attachLoop(ctx, *core, *agent, *accept, *session)

	<-ctx.Done()

	shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := setStatus(shutdown, client, signer, *core, *agent, "OFFLINE"); err != nil {
		fmt.Fprintf(os.Stderr, "presence: could not report shutdown: %v\n", err)
	}
	fmt.Printf("\npresence: %s odłączony\n", *agent)
}

func register(ctx context.Context, c *http.Client, s *api.Signer, core, agent, role, location string) error {
	body := map[string]any{"name": agent, "role": role, "location": location}
	return post(ctx, c, s, core+"/api/agents/register", "/api/agents/register", body)
}

func setStatus(ctx context.Context, c *http.Client, s *api.Signer, core, agent, status string) error {
	path := fmt.Sprintf("/api/agents/%s/heartbeat", agent)
	return post(ctx, c, s, core+path, path,
		map[string]any{"status": status})
}

func heartbeatLoop(ctx context.Context, c *http.Client, s *api.Signer, core, agent string, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()

	for {
		if err := setStatus(ctx, c, s, core, agent, "FREE"); err != nil && ctx.Err() == nil {
			fmt.Fprintf(os.Stderr, "presence: heartbeat failed: %v\n", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func orAny(s string) string {
	if s == "" {
		return "dowolną z agentem"
	}
	return s
}

func attachLoop(ctx context.Context, core, agent string, accept bool, session string) {
	backoff := time.Second

	for ctx.Err() == nil {
		if err := attachOnce(ctx, core, agent, accept, session); err != nil && ctx.Err() == nil {
			fmt.Fprintf(os.Stderr, "presence: łącze zerwane (%v), ponawiam za %s\n", err, backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
	}
}

func attachOnce(ctx context.Context, core, agent string, accept bool, session string) error {
	wsURL, err := toWS(core, agent)
	if err != nil {
		return err
	}

	conn, _, err := websocket.DefaultDialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		return err
	}
	defer conn.Close()

	fmt.Printf("presence: %s podłączony przez WebSocket\n", agent)

	go func() {
		<-ctx.Done()
		conn.Close()
	}()

	sub := map[string]any{"type": "subscribe", "channels": []string{"chat", "tasks", "agents"}}
	if err := conn.WriteJSON(sub); err != nil {
		return err
	}

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		if !accept {
			continue
		}
		handleFrame(raw, agent, session)
	}
}

type chatFrame struct {
	Type string `json:"type"`
	Data struct {
		From     string   `json:"from"`
		Content  string   `json:"content"`
		Mentions []string `json:"mentions"`
	} `json:"data"`
}

func handleFrame(raw []byte, agent, session string) {
	var f chatFrame
	if err := json.Unmarshal(raw, &f); err != nil || f.Type != "chat_message" {
		return
	}
	me := strings.ToUpper(agent)
	if strings.ToUpper(f.Data.From) == me {
		return
	}

	addressed := false
	for _, m := range f.Data.Mentions {
		if u := strings.ToUpper(m); u == me || u == "ALL" {
			addressed = true
			break
		}
	}
	if !addressed {
		return
	}

	var pane tmux.Pane
	var ok bool
	if own := tmux.OwnPane(); own != "" {
		if tmux.HasAgent(own) {
			pane, ok = tmux.Pane{Target: own, ID: own}, true
		} else {
			fmt.Fprintf(os.Stderr,
				"presence: w moim pane (%s) nie działa żaden agent — nie wpisuję\n", own)
			return
		}
	}
	if !ok {
		pane, ok = tmux.FindAgentPane(session)
	}
	if !ok {
		fmt.Fprintf(os.Stderr,
			"presence: wiadomość od %s nie ma odbiornika — brak pane z agentem%s\n",
			f.Data.From, inSession(session))
		return
	}
	if err := tmux.SendLine(pane.Target, f.Data.Content); err != nil {
		fmt.Fprintf(os.Stderr, "presence: nie udało się wpisać do %s: %v\n", pane.Target, err)
		return
	}
	fmt.Printf("presence: wpisano wiadomość od %s do %s (%s)\n",
		f.Data.From, pane.Target, pane.Command)
}

func isAgentCmd(cmd string) bool {
	switch strings.ToLower(cmd) {
	case "claude", "codex":
		return true
	default:
		return false
	}
}

func inSession(s string) string {
	if s == "" {
		return ""
	}
	return " w sesji " + s
}

func post(ctx context.Context, c *http.Client, s *api.Signer, url, path string, body any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	if s != nil {
		if err := s.Sign(req, path, payload); err != nil {
			return fmt.Errorf("nie mogę podpisać żądania: %w", err)
		}
	}

	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

func toWS(core, agent string) (string, error) {
	u, err := url.Parse(core)
	if err != nil {
		return "", err
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = "/" + strings.TrimPrefix(agent, "/")
	return u.String(), nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func hostnameOr(fallback string) string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return fallback
}
