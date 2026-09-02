package api

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

type Signer struct {
	AgentID string
	key     ed25519.PrivateKey
}

func ResolveKeyPath(agentID, explicit string) string {
	if p := strings.TrimSpace(explicit); p != "" {
		return p
	}
	if strings.TrimSpace(agentID) == "" {
		return ""
	}

	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		for i := 0; i < 4 && dir != "/" && dir != "."; i++ {
			candidate := filepath.Join(dir, "deploy", "keys", agentID)
			if _, err := os.Stat(candidate); err == nil {
				return candidate
			}
			dir = filepath.Dir(dir)
		}
	}

	if home, err := os.UserHomeDir(); err == nil {
		legacy := filepath.Join(home, ".ssh", "ecosystem-"+agentID)
		if _, err := os.Stat(legacy); err == nil {
			return legacy
		}
	}
	return ""
}

func LoadSigner(agentID, keyPath string) (*Signer, error) {
	if strings.TrimSpace(keyPath) == "" {
		return nil, fmt.Errorf("nie wskazano klucza")
	}
	if strings.TrimSpace(agentID) == "" {
		return nil, fmt.Errorf("nie wskazano tożsamości (--as)")
	}

	pem, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("nie mogę odczytać klucza %s: %w", keyPath, err)
	}

	parsed, err := ssh.ParseRawPrivateKey(pem)
	if err != nil {
		return nil, fmt.Errorf("klucz %s nie daje się wczytać (zaszyfrowany hasłem?): %w", keyPath, err)
	}

	key, ok := parsed.(*ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("klucz %s nie jest ed25519 — protokół nie dopuszcza innych", keyPath)
	}
	return &Signer{AgentID: agentID, key: *key}, nil
}

func canonical(method, path, timestamp, nonce string, body []byte) []byte {
	sum := sha256.Sum256(body)
	msg := strings.Join([]string{
		strings.ToUpper(method),
		path,
		timestamp,
		nonce,
		hex.EncodeToString(sum[:]),
	}, "\n")
	return []byte(msg)
}

func (s *Signer) Sign(req *http.Request, path string, body []byte) error {
	if s == nil {
		return fmt.Errorf("brak tożsamości do podpisania")
	}

	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil {
		return fmt.Errorf("nie mogę wylosować nonce: %w", err)
	}
	nonce := hex.EncodeToString(nonceBytes)
	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")

	sig := ed25519.Sign(s.key, canonical(req.Method, path, timestamp, nonce, body))

	req.Header.Set("X-Agent-Id", s.AgentID)
	req.Header.Set("X-Timestamp", timestamp)
	req.Header.Set("X-Nonce", nonce)
	req.Header.Set("X-Signature", base64.StdEncoding.EncodeToString(sig))
	return nil
}
