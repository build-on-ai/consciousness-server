package api

import "testing"

func TestWorkingAgentWithDeadPresenceIsNotOffline(t *testing.T) {
	live := Liveness{Registered: true}.WithLocalProcess(true, true)
	if got := live.Label(); got != "BEZ MELDUNKU" {
		t.Errorf("proces żyje, pulsu brak → chciałem BEZ MELDUNKU, jest %q", got)
	}
}

func TestRemoteAgentIsNotDeclaredDeadFromHere(t *testing.T) {
	live := Liveness{Registered: true}.WithLocalProcess(false, false)
	if got := live.Label(); got != "OFFLINE" {
		t.Errorf("zdalny agent bez pulsu → OFFLINE, jest %q", got)
	}
}

func TestLocalMachineWithNoProcessStaysOffline(t *testing.T) {
	live := Liveness{Registered: true}.WithLocalProcess(false, true)
	if got := live.Label(); got != "OFFLINE" {
		t.Errorf("lokalnie, procesu brak → OFFLINE, jest %q", got)
	}
}

func TestHeartbeatWins(t *testing.T) {
	live := Liveness{Registered: true, Heartbeat: true}.WithLocalProcess(true, true)
	if got := live.Label(); got != "BRAK SESJI" {
		t.Errorf("puls jest → BRAK SESJI, jest %q", got)
	}
}
