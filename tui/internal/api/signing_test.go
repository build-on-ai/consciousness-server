package api

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSignedRequestVerifiesAgainstItsOwnKey(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "id_ed25519")

	cmd := exec.Command("ssh-keygen", "-t", "ed25519", "-N", "", "-f", keyPath, "-q")
	if err := cmd.Run(); err != nil {
		t.Skipf("brak ssh-keygen w środowisku: %v", err)
	}

	signer, err := LoadSigner("observer", keyPath)
	if err != nil {
		t.Fatalf("nie wczytano klucza: %v", err)
	}

	body := []byte(`{"from":"observer","message":"@writer sprawdź build"}`)
	req, _ := http.NewRequest(http.MethodPost, "http://example/api/chat", strings.NewReader(string(body)))
	if err := signer.Sign(req, "/api/chat", body); err != nil {
		t.Fatalf("podpisanie nie powiodło się: %v", err)
	}

	if got := req.Header.Get("X-Agent-Id"); got != "observer" {
		t.Errorf("X-Agent-Id = %q", got)
	}
	nonce := req.Header.Get("X-Nonce")
	if len(nonce) != 32 {
		t.Errorf("X-Nonce ma %d znaków, protokół wymaga 32", len(nonce))
	}
	if _, err := hex.DecodeString(nonce); err != nil {
		t.Errorf("X-Nonce nie jest szesnastkowy: %v", err)
	}
	stamp := req.Header.Get("X-Timestamp")
	if _, err := time.Parse("2006-01-02T15:04:05Z", stamp); err != nil {
		t.Errorf("X-Timestamp %q nie jest ISO 8601 UTC: %v", stamp, err)
	}

	pub, err := os.ReadFile(keyPath + ".pub")
	if err != nil {
		t.Fatalf("brak klucza publicznego: %v", err)
	}
	fields := strings.Fields(string(pub))
	if len(fields) < 2 {
		t.Fatalf("nieoczekiwany format klucza publicznego")
	}
	blob, err := base64.StdEncoding.DecodeString(fields[1])
	if err != nil {
		t.Fatalf("klucz publiczny nie jest base64: %v", err)
	}

	pubKey := ed25519.PublicKey(blob[len(blob)-32:])

	sig, err := base64.StdEncoding.DecodeString(req.Header.Get("X-Signature"))
	if err != nil {
		t.Fatalf("X-Signature nie jest base64: %v", err)
	}
	msg := canonical("POST", "/api/chat", stamp, nonce, body)
	if !ed25519.Verify(pubKey, msg, sig) {
		t.Fatal("podpis nie weryfikuje się własnym kluczem — serwer go odrzuci")
	}

	tampered := canonical("POST", "/api/chat", stamp, nonce, []byte(`{"from":"observer","message":"co innego"}`))
	if ed25519.Verify(pubKey, tampered, sig) {
		t.Fatal("podpis przechodzi dla podmienionej treści — hash ciała nie działa")
	}

	sum := sha256.Sum256(body)
	want := strings.Join([]string{"POST", "/api/chat", stamp, nonce, hex.EncodeToString(sum[:])}, "\n")
	if string(msg) != want {
		t.Errorf("kanoniczna wiadomość odbiega od protokołu:\n%q\n%q", msg, want)
	}
}

func TestUnsignedWriteIsRefusedLocally(t *testing.T) {
	c := New("http://127.0.0.1:1", "http://127.0.0.1:2")
	err := c.PostJSON(t.Context(), "/api/chat", map[string]string{"a": "b"}, nil)
	if err == nil {
		t.Fatal("wysyłka bez klucza się powiodła")
	}
	if !strings.Contains(err.Error(), "podpis") {
		t.Errorf("powód odmowy nie mówi o podpisie: %v", err)
	}
}
