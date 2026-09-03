package main

import (
	"flag"
	"fmt"
	"os"

	tea "charm.land/bubbletea/v2"

	"github.com/build-on-ai/consciousness-server/tui/internal"
	"github.com/build-on-ai/consciousness-server/tui/internal/api"
	"github.com/build-on-ai/consciousness-server/tui/internal/ports"
)

const (
	fallbackCore     = 3032
	fallbackMachines = 3038
	fallbackKeys     = 3040
)

func main() {
	core := flag.String("core", envOr("BOA_CORE", ports.URL("consciousness-server", fallbackCore)), "consciousness-server base URL")
	machines := flag.String("machines", envOr("BOA_MACHINES", ports.URL("machines-server", fallbackMachines)), "machines-server base URL")
	keys := flag.String("keys", envOr("BOA_KEYS", ports.URL("key-server", fallbackKeys)), "key-server base URL; empty means this deployment has none")
	name := flag.String("as", envOr("BOA_AGENT", "TUI"), "identity used on the WebSocket and when signing")
	keyPath := flag.String("key", envOr("BOA_SIGNING_KEY", ""), "path to an OpenSSH ed25519 private key; the panel does not start without one")
	refresh := flag.Duration("refresh", internal.DefaultRefresh,
		"how often the fast sources are refreshed; the slow ones ride every fifth tick")
	version := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	// Odrzucane, nie milczaco podnoszone: operator, ktory prosi o 1s, ma
	// wiedziec, ze rdzen odmowi po kilkunastu sekundach, zamiast zobaczyc
	// zamrozony panel i uznac to za awarie serwera.
	if *refresh < internal.MinRefresh {
		fmt.Fprintf(os.Stderr,
			"%s: --refresh %s is below the %s floor.\n\n"+
				"Every request is signed and counted against a per-identity budget of\n"+
				"%d a minute in the core. Refreshing faster spends it on repetition and\n"+
				"the panel starts showing refusals instead of data.\n",
			os.Args[0], *refresh, internal.MinRefresh, internal.CoreRequestBudget)
		os.Exit(2)
	}

	if *version {
		fmt.Println("boa 0.1.0")
		return
	}

	client := api.New(*core, *machines)

	signer, err := api.LoadSigner(*name, api.ResolveKeyPath(*name, *keyPath))
	if err != nil {
		// Bez Base, zeby komunikat dalo sie wkleic: binarka lezy w tui/, wiec ./boa.
		me := os.Args[0]

		hint := ""
		if *keyPath != "" {
			if found := api.ResolveKeyPath(*name, ""); found != "" {
				hint = fmt.Sprintf(`
Wskazana ścieżka nie istnieje, ale klucz tożsamości %s leży tutaj:

  %s

Użyj go tak (albo wyczyść BOA_SIGNING_KEY, jeśli to stąd pochodzi):

  unset BOA_SIGNING_KEY && %s --as %s
`, *name, found, me, *name)
			}
		}

		fmt.Fprintf(os.Stderr, `%s: panel nie wystartuje bez klucza do podpisywania.

%v
%s
Każde żądanie — także odczyt — jest podpisywane kluczem ed25519, żeby dało się
powiedzieć, kto pytał i kto pisał. Klucz wskazuje się jawnie:

  %s --as NAZWA --key ~/.ssh/id_ed25519
  BOA_SIGNING_KEY=~/.ssh/id_ed25519 %s --as NAZWA

Bez jawnej ścieżki panel szuka klucza NAZWANEJ tożsamości (--as) w deploy/keys
i w ~/.ssh/ecosystem-NAZWA. Nie wybiera tożsamości za Ciebie — to zostaje
decyzją operatora.
`, me, err, hint, me, me)
		os.Exit(1)
	}
	client.KeysURL = *keys
	client.Signer = signer
	stream := api.NewStream(client)
	go stream.Run(*name)

	model := internal.NewModelWithRefresh(client, stream, *refresh)

	p := tea.NewProgram(model)
	if _, err := p.Run(); err != nil {
		stream.Stop()
		fmt.Fprintf(os.Stderr, "%s: %v\n", os.Args[0], err)
		os.Exit(1)
	}
	stream.Stop()
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
