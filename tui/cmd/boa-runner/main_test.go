package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestTaskOutcome(t *testing.T) {
	cases := []struct {
		name             string
		deliverErr       error
		finished         bool
		wantStatus       string
		wantResultSubstr string
	}{
		{"delivered, clean exit -> DONE", nil, true, "DONE", "session ended ok"},
		{"delivered, crash -> FAILED", nil, false, "FAILED", "claude exited 7"},
		{
			"never delivered but exited 0 anyway -> FAILED, not DONE",
			errors.New("write /dev/ptmx: input/output error"), true,
			"FAILED", "never delivered to PTY",
		},
		{
			"never delivered and crashed -> still reports non-delivery, not the crash",
			errors.New("write /dev/ptmx: input/output error"), false,
			"FAILED", "never delivered to PTY",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			message := "session ended ok"
			if !tc.finished {
				message = "claude exited 7"
			}
			status, result := taskOutcome(tc.deliverErr, tc.finished, message)
			if status != tc.wantStatus {
				t.Errorf("status = %q, want %q", status, tc.wantStatus)
			}
			if !strings.Contains(result, tc.wantResultSubstr) {
				t.Errorf("result %q does not contain %q", result, tc.wantResultSubstr)
			}
		})
	}
}

func TestClassify(t *testing.T) {
	cases := []struct {
		name         string
		shell        string
		wantCode     int
		wantFinished bool
		wantContains string
	}{
		{"clean exit is finished", "exit 0", 0, true, "session ended ok"},
		{"nonzero exit is not finished", "exit 7", 7, false, "claude exited 7"},
		{"killed by signal is not finished", "kill -TERM $$", 128 + 15, false, "signal"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cmd := exec.Command("sh", "-c", tc.shell)
			waitErr := cmd.Run()
			code, finished, msg := classify(waitErr, cmd.ProcessState)
			if code != tc.wantCode {
				t.Errorf("exitCode = %d, want %d", code, tc.wantCode)
			}
			if finished != tc.wantFinished {
				t.Errorf("finished = %v, want %v", finished, tc.wantFinished)
			}
			if !strings.Contains(msg, tc.wantContains) {
				t.Errorf("message %q does not contain %q", msg, tc.wantContains)
			}
		})
	}
}

func TestPresenceBeating(t *testing.T) {
	serve := func(t *testing.T, status int, body any) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/agents/SELFTEST" {
				t.Errorf("unexpected path %s", r.URL.Path)
			}
			w.WriteHeader(status)
			if body != nil {
				json.NewEncoder(w).Encode(body)
			}
		}))
	}

	t.Run("recent heartbeat beats", func(t *testing.T) {
		srv := serve(t, http.StatusOK, map[string]any{"last_heartbeat": time.Now().UTC()})
		defer srv.Close()
		if !presenceBeating(t.Context(), srv.Client(), srv.URL, "SELFTEST") {
			t.Error("want true for a fresh heartbeat")
		}
	})

	t.Run("stale heartbeat does not beat", func(t *testing.T) {
		stale := time.Now().Add(-2 * heartbeatStaleAfter).UTC()
		srv := serve(t, http.StatusOK, map[string]any{"last_heartbeat": stale})
		defer srv.Close()
		if presenceBeating(t.Context(), srv.Client(), srv.URL, "SELFTEST") {
			t.Error("want false for a stale heartbeat — this is the exact 'wedged' case the watchdog exists to catch")
		}
	})

	t.Run("agent not found does not beat", func(t *testing.T) {
		srv := serve(t, http.StatusNotFound, nil)
		defer srv.Close()
		if presenceBeating(t.Context(), srv.Client(), srv.URL, "SELFTEST") {
			t.Error("want false on 404")
		}
	})

	t.Run("unreachable core fails closed", func(t *testing.T) {
		srv := serve(t, http.StatusOK, map[string]any{"last_heartbeat": time.Now().UTC()})
		srv.Close()
		if presenceBeating(t.Context(), srv.Client(), srv.URL, "SELFTEST") {
			t.Error("want false when CS is unreachable — no pulse must not be manufactured")
		}
	})
}
