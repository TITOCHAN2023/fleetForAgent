package main

import (
	"strings"
	"testing"
)

func TestInputVerdictOffAndAskAndAllow(t *testing.T) {
	a := &Agent{enabled: true, permit: PermitOff}
	v, msg := a.inputVerdict()
	if v != permitRefuse || !strings.Contains(msg, "permit=off") {
		t.Fatalf("off: v=%v msg=%q", v, msg)
	}

	a.permit = PermitAllow
	v, msg = a.inputVerdict()
	if v != permitProceed || msg != "" {
		t.Fatalf("allow: v=%v msg=%q", v, msg)
	}

	a.permit = PermitAsk
	v, msg = a.inputVerdict()
	if v != permitAsk || msg != "" {
		t.Fatalf("ask empty: v=%v msg=%q", v, msg)
	}
	a.pending = &Pending{Kind: pendingKindRun, Command: "ls"}
	v, msg = a.inputVerdict()
	if v != permitRefuse || !strings.Contains(msg, "waiting for consent") {
		t.Fatalf("ask busy: v=%v msg=%q", v, msg)
	}

	a.enabled = false
	a.permit = PermitAllow
	a.pending = nil
	v, msg = a.inputVerdict()
	if v != permitRefuse {
		t.Fatalf("disabled allow should refuse, v=%v msg=%q", v, msg)
	}
}

func TestTypeConsentText(t *testing.T) {
	if got := typeConsentText("", "Enter"); got != "type Enter" {
		t.Fatalf("named key: %q", got)
	}
	if got := typeConsentText("pwd\n", ""); !strings.HasPrefix(got, "type ") {
		t.Fatalf("keys: %q", got)
	}
}

func TestHubTokenPublicHidesSecret(t *testing.T) {
	if hubTokenPublic("") != "" {
		t.Fatal("empty")
	}
	if hubTokenPublic("not-a-token") != "set" {
		t.Fatalf("opaque: %q", hubTokenPublic("not-a-token"))
	}
	if hubTokenPublic("flt_"+strings.Repeat("ab", 32)) != "set" {
		t.Fatal("legacy must not echo")
	}
}

func TestPublicSnapshotRedactsToken(t *testing.T) {
	a := &Agent{hubToken: "flt_not_a_real_secret_value"}
	s := a.publicSnapshot()
	if s.HubToken == a.hubToken {
		t.Fatal("public snapshot leaked hub token")
	}
	if s.HubToken != "set" {
		t.Fatalf("prefix=%q", s.HubToken)
	}
}
