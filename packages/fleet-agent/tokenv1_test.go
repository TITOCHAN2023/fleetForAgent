package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"strings"
	"testing"
)

func TestHubOrigin(t *testing.T) {
	if got := hubOrigin("wss://Fleet.Ginfo.CC/v1/device"); got != "https://fleet.ginfo.cc" {
		t.Fatalf("got %q", got)
	}
	if got := hubOrigin("fleet.ginfo.cc"); got != "https://fleet.ginfo.cc" {
		t.Fatalf("got %q", got)
	}
}

func TestLegacyFlt(t *testing.T) {
	if !isLegacyFlt("flt_" + strings.Repeat("ab", 32)) {
		t.Fatal("expected legacy")
	}
	if isTokenV1("flt_" + strings.Repeat("ab", 32)) {
		t.Fatal("legacy is not v1")
	}
	if !isTokenV1("flt_1.aaa.bbb") {
		t.Fatal("expected v1")
	}
}

func TestVerifyTokenV1AndWrap(t *testing.T) {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pubDER, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	pubB64 := b64urlEncode(pubDER)
	claims := tokenV1Claims{
		V:   1,
		Aud: "https://fleet.ginfo.cc",
		Kid: "11111111-2222-4333-8444-555555555555",
		Pub: pubB64,
		Iat: 1,
		Sec: strings.Repeat("ab", 32),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(payload)
	sig, err := rsa.SignPSS(rand.Reader, priv, crypto.SHA256, sum[:], &rsa.PSSOptions{SaltLength: pssSaltLen})
	if err != nil {
		t.Fatal(err)
	}
	raw := tokenV1Prefix + b64urlEncode(payload) + "." + b64urlEncode(sig)
	got, err := verifyTokenV1(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.Kid != claims.Kid || got.Sec != claims.Sec || got.Aud != claims.Aud {
		t.Fatalf("claims %+v", got)
	}
	if isLegacyFlt(raw) {
		t.Fatal("v1 token must not be legacy")
	}

	wrap, err := wrapAuth(&priv.PublicKey, claims.Sec, strings.Repeat("cc", 32))
	if err != nil {
		t.Fatal(err)
	}
	ct, err := b64urlDecode(wrap)
	if err != nil {
		t.Fatal(err)
	}
	pt, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, priv, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	var opened wrapBody
	if err := json.Unmarshal(pt, &opened); err != nil {
		t.Fatal(err)
	}
	if opened.Sec != claims.Sec || opened.Nonce != strings.Repeat("cc", 32) {
		t.Fatalf("opened %+v", opened)
	}

	msg := []byte("v1|" + claims.Aud + "|" + claims.Kid + "|nonce")
	chSum := sha256.Sum256(msg)
	chSig, err := rsa.SignPSS(rand.Reader, priv, crypto.SHA256, chSum[:], &rsa.PSSOptions{SaltLength: pssSaltLen})
	if err != nil {
		t.Fatal(err)
	}
	if !verifyChallenge(&priv.PublicKey, claims.Aud, claims.Kid, "nonce", b64urlEncode(chSig)) {
		t.Fatal("challenge sig should verify")
	}
	if verifyChallenge(&priv.PublicKey, "https://evil.example", claims.Kid, "nonce", b64urlEncode(chSig)) {
		t.Fatal("wrong aud must fail")
	}
}

func TestLegacyTokenMessage(t *testing.T) {
	if !strings.HasPrefix(highSecUpgrade, "HIGH_SEC:") {
		t.Fatalf("upgrade message must be English HIGH_SEC, got %q", highSecUpgrade)
	}
}
