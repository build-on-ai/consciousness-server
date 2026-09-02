package tmux

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

type Pane struct {
	Target  string
	ID      string
	PID     string
	Command string
	Session string
}

func Available() bool {
	if _, err := exec.LookPath("tmux"); err != nil {
		return false
	}
	return exec.Command("tmux", "has-session").Run() == nil ||
		exec.Command("tmux", "list-panes", "-a").Run() == nil
}

func Panes() ([]Pane, error) {
	out, err := exec.Command("tmux", "list-panes", "-a", "-F",
		"#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}\t#{session_name}\t#{pane_id}\t#{pane_pid}",
	).Output()
	if err != nil {
		return nil, fmt.Errorf("tmux list-panes: %w", err)
	}

	var panes []Pane
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) < 5 {
			continue
		}
		panes = append(panes, Pane{Target: f[0], Command: f[1], Session: f[2], ID: f[3], PID: f[4]})
	}
	return panes, nil
}

func OwnPane() string {
	return strings.TrimSpace(os.Getenv("TMUX_PANE"))
}

func CommandIn(target string) string {
	panes, err := Panes()
	if err != nil {
		return ""
	}
	for _, p := range panes {
		if p.Target == target || p.ID == target {
			return p.Command
		}
	}
	return ""
}

func HasAgent(target string) bool {
	panes, err := Panes()
	if err != nil {
		return false
	}
	var pid string
	for _, p := range panes {
		if p.Target == target || p.ID == target {
			pid = p.PID
			break
		}
	}
	if pid == "" {
		return false
	}
	return treeHasAgent(pid, 0)
}

func treeHasAgent(pid string, depth int) bool {
	if depth > 6 {
		return false
	}
	out, err := exec.Command("ps", "-o", "pid=,comm=", "--ppid", pid).Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		if isAgentCommand(f[1]) {
			return true
		}
		if treeHasAgent(f[0], depth+1) {
			return true
		}
	}
	return false
}

func FindAgentPane(session string) (Pane, bool) {
	panes, err := Panes()
	if err != nil {
		return Pane{}, false
	}
	return pickAgent(panes, session)
}

func pickAgent(panes []Pane, session string) (Pane, bool) {
	var fallback Pane
	var haveFallback bool

	for _, p := range panes {
		if !isAgentCommand(p.Command) {
			continue
		}
		if session != "" && p.Session == session {
			return p, true
		}
		if !haveFallback {
			fallback, haveFallback = p, true
		}
	}
	if session != "" {
		return Pane{}, false
	}
	return fallback, haveFallback
}

var (
	agentsOnce sync.Once
	agentNames = []string{"claude", "codex"}
)

func agentListPath() string {
	if p := os.Getenv("BOA_AGENT_LIST"); p != "" {
		return p
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	dir := filepath.Dir(exe)
	for i := 0; i < 4; i++ {
		candidate := filepath.Join(dir, "runtime", "cli.txt")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		dir = filepath.Dir(dir)
	}
	return ""
}

func loadAgentNames() {
	path := agentListPath()
	if path == "" {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}

	var names []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		names = append(names, strings.ToLower(line))
	}
	if len(names) > 0 {
		agentNames = names
	}
}

func isAgentCommand(cmd string) bool {
	agentsOnce.Do(loadAgentNames)
	cmd = strings.ToLower(cmd)
	for _, name := range agentNames {
		if cmd == name {
			return true
		}
	}
	return false
}

func LocalAgents() map[string]bool {
	found := map[string]bool{}
	panes, err := Panes()
	if err != nil {
		return found
	}
	for _, p := range panes {
		for _, pid := range treeAgentPIDs(p.PID, 0) {
			if role := roleFromEnviron(pid); role != "" {
				found[strings.ToUpper(role)] = true
			}
		}
	}
	return found
}

func treeAgentPIDs(root string, depth int) []string {
	if root == "" || depth > 6 {
		return nil
	}
	out := exec.Command("ps", "-o", "pid=,comm=", "--ppid", root)
	data, err := out.Output()
	if err != nil {
		return nil
	}

	var pids []string
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		pid, comm := fields[0], fields[1]
		if isAgentCommand(comm) {
			pids = append(pids, pid)
			continue
		}
		pids = append(pids, treeAgentPIDs(pid, depth+1)...)
	}
	return pids
}

func roleFromEnviron(pid string) string {
	data, err := os.ReadFile("/proc/" + pid + "/environ")
	if err != nil {
		return ""
	}
	const marker = "/.cs-agents/"
	for _, entry := range strings.Split(string(data), "\x00") {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || (key != "HOME" && key != "CODEX_HOME") {
			continue
		}
		idx := strings.Index(value, marker)
		if idx < 0 {
			continue
		}
		rest := value[idx+len(marker):]
		if cut := strings.IndexByte(rest, '/'); cut >= 0 {
			rest = rest[:cut]
		}
		if rest != "" {
			return rest
		}
	}
	return ""
}

func AgentNames() ([]string, string) {
	agentsOnce.Do(loadAgentNames)
	src := agentListPath()
	if src == "" {
		src = "wbudowana"
	}
	out := make([]string, len(agentNames))
	copy(out, agentNames)
	return out, src
}

func SendLine(target, text string) error {
	if strings.TrimSpace(target) == "" {
		return fmt.Errorf("brak celu (pane)")
	}
	if err := exec.Command("tmux", "send-keys", "-t", target, "-l", text).Run(); err != nil {
		return fmt.Errorf("tmux send-keys: %w", err)
	}
	if err := exec.Command("tmux", "send-keys", "-t", target, "Enter").Run(); err != nil {
		return fmt.Errorf("tmux send-keys Enter: %w", err)
	}
	return nil
}
