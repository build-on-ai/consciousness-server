package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

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
	keyPath := flag.String("key", envOr("BOA_SIGNING_KEY", ""), "path to an OpenSSH ed25519 private key; without it the panel is read-only")
	version := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *version {
		fmt.Println("boa 0.1.0")
		return
	}

	client := api.New(*core, *machines)

	signer, err := api.LoadSigner(*name, api.ResolveKeyPath(*name, *keyPath))
	if err != nil {
		me := filepath.Base(os.Args[0])

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

	model := internal.NewModel(client, stream)

	p := tea.NewProgram(model)
	if _, err := p.Run(); err != nil {
		stream.Stop()
		fmt.Fprintf(os.Stderr, "%s: %v\n", filepath.Base(os.Args[0]), err)
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
