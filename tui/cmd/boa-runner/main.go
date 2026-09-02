package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/coreos/go-systemd/v22/daemon"
	"github.com/creack/pty"

	"github.com/build-on-ai/consciousness-server/tui/internal/api"
	"github.com/build-on-ai/consciousness-server/tui/internal/ports"
)

const heartbeatStaleAfter = 60 * time.Second

func main() {
	role := flag.String("role", envOr("BOA_ROLE", ""), "agent role (lowercase; matches %i in boa-agent@.service)")
	core := flag.String("core", envOr("BOA_CORE", ports.URL("consciousness-server", 3032)), "consciousness-server base URL")
	claudeBin := flag.String("claude-bin", envOr("CLAUDE_BIN", "claude"), "CLI this runner puts under PTY")
	presenceBin := flag.String("presence-bin", "", "path to the presence binary (default: found next to this binary, or tui/presence, or $PATH)")
	agentHome := flag.String("home", "", "HOME given to the supervised CLI (default: $HOME/.cs-agents/<role>)")
	keyPath := flag.String("key", envOr("BOA_SIGNING_KEY", ""), "signing key path; see presence --key")
	selftest := flag.Bool("selftest", false, "skip claude; prove the cgroup teardown property instead (see tui/test/cgroup_teardown_test.sh)")
	task := flag.String("task", "", "text to write into the PTY once at start, in place of fetching a task from CS (mainly for running boa-runner by hand)")
	flag.Parse()

	if strings.TrimSpace(*role) == "" {
		fmt.Fprintln(os.Stderr, "boa-runner: --role is required")
		os.Exit(2)
	}
	roleUpper := strings.ToUpper(*role)

	if *agentHome == "" {
	}
	resolvedPresenceBin, err := resolvePresenceBin(*presenceBin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "boa-runner: %v\n", err)
		os.Exit(1)
	}

	var signer *api.Signer
	if resolved := api.ResolveKeyPath(roleUpper, *keyPath); resolved != "" {
		s, err := api.LoadSigner(roleUpper, resolved)
		if err != nil {
			fmt.Fprintf(os.Stderr, "boa-runner: %v\n", err)
			os.Exit(1)
		}
		signer = s
		fmt.Printf("boa-runner: podpisuje jako %s kluczem %s\n", roleUpper, resolved)
	} else {
		fmt.Fprintf(os.Stderr, "boa-runner: BEZ PODPISU (--key / BOA_SIGNING_KEY nieustawione); "+
			"logi dyspozycji pójdą niepodpisane\n")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	httpClient := &http.Client{Timeout: 5 * time.Second}

	presenceCmd, err := startPresence(resolvedPresenceBin, roleUpper, *role, *core)
	if err != nil {
		fmt.Fprintf(os.Stderr, "boa-runner: presence nie wystartowało: %v\n", err)
		os.Exit(1)
	}
	_ = presenceCmd

	if *selftest {
		runSelftest(ctx, roleUpper)
		return
	}

	exitCode := runAgent(ctx, httpClient, signer, *core, roleUpper, *claudeBin, *agentHome, *task)
	os.Exit(exitCode)
}

func startPresence(bin, roleUpper, role, core string) (*exec.Cmd, error) {
	cmd := exec.Command(bin, "--as", roleUpper, "--role", role, "--core", core)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("uruchomienie %s: %w", bin, err)
	}
	return cmd, nil
}

func resolvePresenceBin(explicit string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		if p := filepath.Join(dir, "presence"); fileExists(p) {
			return p, nil
		}
		if p := filepath.Join(dir, "..", "presence"); fileExists(p) {
			return p, nil
		}
	}
	if p, err := exec.LookPath("presence"); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("nie znaleziono presence (--presence-bin, albo zbuduj: cd tui && go build -o bin/presence ./cmd/presence)")
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func runAgent(ctx context.Context, httpClient *http.Client, signer *api.Signer, core, roleUpper, claudeBin, agentHome, explicitTask string) int {
	task := resolveTask(ctx, httpClient, signer, core, roleUpper, explicitTask)

	cmd := exec.Command(claudeBin)
	cmd.Env = append(os.Environ(), "HOME="+agentHome)

	ptmx, err := pty.Start(cmd)
	if err != nil {
		fmt.Fprintf(os.Stderr, "boa-runner: PTY/%s nie wystartowały: %v\n", claudeBin, err)
		return 1
	}
	defer ptmx.Close()

	go io.Copy(os.Stdout, ptmx)

	var taskDeliverErr error
	if task != nil {
		fmt.Printf("boa-runner: zadanie: %s\n", task.Title)
		if _, err := io.WriteString(ptmx, task.prompt()+"\n"); err != nil {
			taskDeliverErr = err
			fmt.Fprintf(os.Stderr, "boa-runner: nie mogę wpisać zadania do PTY: %v\n", err)
		} else {
			patchTaskStatus(httpClient, signer, core, task.ID, "IN_PROGRESS", "")
		}
	} else {
		fmt.Println("boa-runner: brak zadania dla tej roli — claude odpala się bez promptu")
	}

	notifyReady(roleUpper)
	go watchdogLoop(ctx, httpClient, core, roleUpper)

	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()

	select {
	case err := <-waitCh:
		if ctx.Err() != nil {
			postLog(httpClient, signer, core, roleUpper, "INFO", "stopped by operator")
			return 0
		}
		code, finished, message := classify(err, cmd.ProcessState)
		level := "INFO"
		if !finished {
			level = "ERROR"
		}
		postLog(httpClient, signer, core, roleUpper, level, message)
		if task != nil {
			status, result := taskOutcome(taskDeliverErr, finished, message)
			patchTaskStatus(httpClient, signer, core, task.ID, status, result)
		}
		return code
	case <-ctx.Done():
		postLog(httpClient, signer, core, roleUpper, "INFO", "stopped by operator")
		return 0
	}
}

func runSelftest(ctx context.Context, roleUpper string) {
	notifyReady(roleUpper)

	grandchild := exec.Command("setsid", "-f", "sleep", "infinity")
	grandchild.Stdout = os.Stdout
	grandchild.Stderr = os.Stderr
	if err := grandchild.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "boa-runner: selftest nie mógł odpalić wnuka: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("boa-runner: selftest — wnuk (setsid sleep infinity) odpalony, czekam na stop")

	<-ctx.Done()
	fmt.Println("boa-runner: selftest — SIGTERM, kończę (cgroup teardown robi resztę)")
}

func notifyReady(roleUpper string) {
	if ok, err := daemon.SdNotify(false, daemon.SdNotifyReady); err != nil {
		fmt.Fprintf(os.Stderr, "boa-runner: sd_notify READY nie powiodło się: %v\n", err)
	} else if !ok {
		fmt.Printf("boa-runner: %s gotowy (bez systemd notify-socket)\n", roleUpper)
	}
}

func watchdogLoop(ctx context.Context, client *http.Client, core, roleUpper string) {
	interval, err := daemon.SdWatchdogEnabled(false)
	if err != nil || interval == 0 {
		return
	}
	ticker := time.NewTicker(interval / 2)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if presenceBeating(ctx, client, core, roleUpper) {
				if _, err := daemon.SdNotify(false, daemon.SdNotifyWatchdog); err != nil {
					fmt.Fprintf(os.Stderr, "boa-runner: sd_notify WATCHDOG nie powiodło się: %v\n", err)
				}
			}
		}
	}
}

func presenceBeating(ctx context.Context, client *http.Client, core, roleUpper string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, core+"/api/agents/"+roleUpper, nil)
	if err != nil {
		return false
	}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var agent struct {
		LastHeartbeat time.Time `json:"last_heartbeat"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&agent); err != nil {
		return false
	}
	return time.Since(agent.LastHeartbeat) < heartbeatStaleAfter
}

func classify(waitErr error, ps *os.ProcessState) (exitCode int, finished bool, message string) {
	if waitErr == nil {
		return 0, true, "session ended ok"
	}
	if ps != nil {
		if ws, ok := ps.Sys().(syscall.WaitStatus); ok {
			if ws.Signaled() {
				sig := ws.Signal()
				return 128 + int(sig), false, fmt.Sprintf("claude killed by signal %s", sig)
			}
			if ws.Exited() {
				code := ws.ExitStatus()
				if code == 0 {
					return 0, true, "session ended ok"
				}
				return code, false, fmt.Sprintf("claude exited %d", code)
			}
		}
	}
	return 1, false, waitErr.Error()
}

func taskOutcome(deliverErr error, finished bool, message string) (status, result string) {
	if deliverErr != nil {
		return "FAILED", "task never delivered to PTY: " + deliverErr.Error()
	}
	if finished {
		return "DONE", message
	}
	return "FAILED", message
}

func postLog(client *http.Client, signer *api.Signer, core, roleUpper, level, message string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	resp, err := doSigned(ctx, client, signer, http.MethodPost, core, "/api/logs/append", map[string]any{
		"project": "boa-runner",
		"agent":   roleUpper,
		"level":   level,
		"message": message,
	})
	if err != nil {
		var se *signError
		if errors.As(err, &se) {
			fmt.Fprintf(os.Stderr, "boa-runner: nie mogę podpisać logu: %v\n", se.Unwrap())
		} else {
			fmt.Fprintf(os.Stderr, "boa-runner: log do CS nie dotarł: %v\n", err)
		}
		return
	}
	resp.Body.Close()
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
