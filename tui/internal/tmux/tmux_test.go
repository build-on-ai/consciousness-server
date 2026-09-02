package tmux

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestAgentPaneIsChosenByCommandNotIndex(t *testing.T) {

	panes := []Pane{
		{Target: "demo:0.0", Command: "bash", Session: "demo"},
		{Target: "demo:0.1", Command: "claude", Session: "demo"},
	}

	got, ok := pickAgent(panes, "demo")
	if !ok {
		t.Fatal("nie znaleziono pane agenta, choć jeden działa claude")
	}
	if got.Command != "claude" {
		t.Errorf("wybrano %q (%s) zamiast pane z agentem", got.Command, got.Target)
	}
}

func TestShellOnlySessionHasNoReceiver(t *testing.T) {
	panes := []Pane{{Target: "demo:0.0", Command: "bash", Session: "demo"}}
	if _, ok := pickAgent(panes, "demo"); ok {
		t.Error("sesja bez agenta nie może zwracać odbiorcy — to znaczyłoby pisanie do cudzej powłoki")
	}
}

func TestOtherSessionIsNotASubstitute(t *testing.T) {
	panes := []Pane{{Target: "inna:0.0", Command: "claude", Session: "inna"}}
	if _, ok := pickAgent(panes, "demo"); ok {
		t.Error("pytano o sesję demo — agent w innej sesji nie jest zastępstwem")
	}
}

func TestThirdAgentNeedsNoRecompile(t *testing.T) {
	dir := t.TempDir()
	list := filepath.Join(dir, "cli.txt")
	if err := os.WriteFile(list, []byte("# komentarz\n\nclaude\ncodex\ngemma-cli\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BOA_AGENT_LIST", list)

	agentsOnce = sync.Once{}
	agentNames = []string{"claude", "codex"}

	for _, name := range []string{"claude", "codex", "gemma-cli", "GEMMA-CLI"} {
		if !isAgentCommand(name) {
			t.Errorf("%q miało zostać rozpoznane jako agent", name)
		}
	}
	for _, name := range []string{"bash", "zsh", "vim", ""} {
		if isAgentCommand(name) {
			t.Errorf("%q NIE jest agentem, a zostało rozpoznane — presence pisałby do cudzego okna", name)
		}
	}
}

func TestEmptyListDoesNotDisarmEveryone(t *testing.T) {
	dir := t.TempDir()
	list := filepath.Join(dir, "cli.txt")
	if err := os.WriteFile(list, []byte("# same komentarze\n\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BOA_AGENT_LIST", list)

	agentsOnce = sync.Once{}
	agentNames = []string{"claude", "codex"}

	if !isAgentCommand("claude") {
		t.Error("pusty plik wyłączył wbudowaną listę — prompty przestałyby dochodzić")
	}
}
