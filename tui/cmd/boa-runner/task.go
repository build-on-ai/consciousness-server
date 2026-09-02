package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/build-on-ai/consciousness-server/tui/internal/api"
)

type Task struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

func (t *Task) prompt() string {
	if t.Description == "" {
		return t.Title
	}
	return t.Title + "\n\n" + t.Description
}

func resolveTask(ctx context.Context, client *http.Client, signer *api.Signer, core, roleUpper, explicit string) *Task {
	if explicit != "" {
		return &Task{Title: explicit}
	}
	if t := fetchAssignedTask(ctx, client, signer, core, roleUpper); t != nil {
		return t
	}
	return claimAvailableTask(ctx, client, signer, core, roleUpper)
}

func fetchAssignedTask(ctx context.Context, client *http.Client, signer *api.Signer, core, roleUpper string) *Task {
	resp, err := doSigned(ctx, client, signer, http.MethodGet, core, "/api/tasks/pending/"+roleUpper, nil)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var tasks []Task
	if err := json.NewDecoder(resp.Body).Decode(&tasks); err != nil || len(tasks) == 0 {
		return nil
	}
	return &tasks[0]
}

func claimAvailableTask(ctx context.Context, client *http.Client, signer *api.Signer, core, roleUpper string) *Task {
	resp, err := doSigned(ctx, client, signer, http.MethodGet, core, "/api/tasks/available", nil)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var tasks []Task
	if err := json.NewDecoder(resp.Body).Decode(&tasks); err != nil {
		return nil
	}

	for i := range tasks {
		t := &tasks[i]
		path := "/api/tasks/" + t.ID + "/claim"
		if resp, err := doSigned(ctx, client, signer, http.MethodPost, core, path,
			map[string]any{"agent": roleUpper}); err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return t
			}
		}
	}
	return nil
}

func patchTaskStatus(client *http.Client, signer *api.Signer, core, taskID, status, result string) {
	if taskID == "" {
		return
	}
	body := map[string]any{"status": status}
	if result != "" {
		body["result"] = result
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	resp, err := doSigned(ctx, client, signer, http.MethodPatch, core, "/api/tasks/"+taskID+"/status", body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "boa-runner: status zadania %s -> %s nie dotarł do CS: %v\n", taskID, status, err)
		return
	}
	resp.Body.Close()
}

func doSigned(ctx context.Context, client *http.Client, signer *api.Signer, method, core, path string, body any) (*http.Response, error) {
	var raw []byte
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		raw = b
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, core+path, reader)
	if err != nil {
		return nil, err
	}
	if raw != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if signer != nil {
		if err := signer.Sign(req, path, raw); err != nil {
			return nil, &signError{err}
		}
	}
	return client.Do(req)
}

type signError struct{ err error }

func (e *signError) Error() string { return "nie mogę podpisać: " + e.err.Error() }
func (e *signError) Unwrap() error { return e.err }
