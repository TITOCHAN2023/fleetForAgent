package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	tokenV1Prefix = "flt_1."
	pssSaltLen    = 32

	highSecUpgrade     = "HIGH_SEC: this hub requires the high-security channel. Update the Fleet agent and MCP client, then issue a new hub token in Settings and paste it. Legacy Bearer tokens are not accepted."
	highSecKeyMismatch = "HIGH_SEC: hub key does not match this token. Issue a new hub token in Settings and paste it. This computer will refuse to connect until the keys match."
	highSecHandshake   = "HIGH_SEC: hub did not complete the high-security handshake. Update the Fleet agent and MCP client, then issue a new hub token in Settings."
)

type tokenV1Claims struct {
	V   int    `json:"v"`
	Aud string `json:"aud"`
	Kid string `json:"kid"`
	Pub string `json:"pub"`
	Iat int64  `json:"iat"`
	Sec string `json:"sec"`
}

type wrapBody struct {
	Sec   string `json:"sec"`
	Nonce string `json:"nonce"`
}

type challengeBody struct {
	Nonce string `json:"nonce"`
	Kid   string `json:"kid"`
	Aud   string `json:"aud"`
	Sig   string `json:"sig"`
	Error string `json:"error"`
}

func isTokenV1(raw string) bool {
	t := strings.TrimSpace(raw)
	if !strings.HasPrefix(t, tokenV1Prefix) {
		return false
	}
	rest := t[len(tokenV1Prefix):]
	i := strings.IndexByte(rest, '.')
	return i > 0 && i < len(rest)-1
}

func isLegacyFlt(raw string) bool {
	t := strings.TrimSpace(raw)
	return strings.HasPrefix(t, "flt_") && !strings.HasPrefix(t, tokenV1Prefix)
}

// hubTokenPublic is what /api/state may return. Never the pasted flt_1 secret.
func hubTokenPublic(raw string) string {
	t := strings.TrimSpace(raw)
	if t == "" {
		return ""
	}
	claims, err := verifyTokenV1(t)
	if err == nil && claims != nil && claims.Kid != "" {
		kid := claims.Kid
		if len(kid) > 8 {
			kid = kid[:8]
		}
		return tokenV1Prefix + kid
	}
	return "set"
}

func hubOrigin(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	s = strings.Replace(s, "wss://", "https://", 1)
	s = strings.Replace(s, "ws://", "http://", 1)
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)
}

func httpOriginFromWSS(wss string) (string, error) {
	origin := hubOrigin(wss)
	if origin == "" {
		return "", fmt.Errorf("Enter the hub address")
	}
	return origin, nil
}

func b64urlDecode(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(s)
}

func b64urlEncode(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func parseSPKI(pubB64 string) (*rsa.PublicKey, error) {
	der, err := b64urlDecode(pubB64)
	if err != nil {
		return nil, err
	}
	k, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	pub, ok := k.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf(highSecUpgrade)
	}
	return pub, nil
}

func verifyPSS(pub *rsa.PublicKey, msg, sig []byte) error {
	sum := sha256.Sum256(msg)
	return rsa.VerifyPSS(pub, crypto.SHA256, sum[:], sig, &rsa.PSSOptions{SaltLength: pssSaltLen})
}

func verifyTokenV1(raw string) (*tokenV1Claims, error) {
	t := strings.TrimSpace(raw)
	if !isTokenV1(t) {
		return nil, fmt.Errorf("%s", highSecUpgrade)
	}
	rest := t[len(tokenV1Prefix):]
	dot := strings.LastIndexByte(rest, '.')
	if dot < 1 {
		return nil, fmt.Errorf("%s", highSecUpgrade)
	}
	payload, err := b64urlDecode(rest[:dot])
	if err != nil {
		return nil, fmt.Errorf("%s", highSecUpgrade)
	}
	sig, err := b64urlDecode(rest[dot+1:])
	if err != nil {
		return nil, fmt.Errorf("%s", highSecUpgrade)
	}
	var claims tokenV1Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, fmt.Errorf("%s", highSecUpgrade)
	}
	if claims.V != 1 || claims.Aud == "" || claims.Kid == "" || claims.Pub == "" || claims.Sec == "" {
		return nil, fmt.Errorf("%s", highSecUpgrade)
	}
	pub, err := parseSPKI(claims.Pub)
	if err != nil {
		return nil, fmt.Errorf("%s", highSecUpgrade)
	}
	if err := verifyPSS(pub, payload, sig); err != nil {
		return nil, fmt.Errorf("%s", highSecUpgrade)
	}
	claims.Aud = hubOrigin(claims.Aud)
	return &claims, nil
}

func wrapAuth(pub *rsa.PublicKey, sec, nonce string) (string, error) {
	pt, err := json.Marshal(wrapBody{Sec: sec, Nonce: nonce})
	if err != nil {
		return "", err
	}
	ct, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, pub, pt, nil)
	if err != nil {
		return "", err
	}
	return b64urlEncode(ct), nil
}

func verifyChallenge(pub *rsa.PublicKey, aud, kid, nonce, sigB64 string) bool {
	if pub == nil || aud == "" || kid == "" || nonce == "" || sigB64 == "" {
		return false
	}
	sig, err := b64urlDecode(sigB64)
	if err != nil {
		return false
	}
	msg := []byte("v1|" + aud + "|" + kid + "|" + nonce)
	return verifyPSS(pub, msg, sig) == nil
}

func highSecAuthorization(ctx context.Context, wss, tok string) (string, error) {
	tok = strings.TrimSpace(tok)
	if tok == "" {
		return "", nil
	}
	if isLegacyFlt(tok) {
		return "", fmt.Errorf("%s", highSecUpgrade)
	}
	if !isTokenV1(tok) {
		return "Bearer " + tok, nil
	}
	claims, err := verifyTokenV1(tok)
	if err != nil {
		return "", err
	}
	origin, err := httpOriginFromWSS(wss)
	if err != nil {
		return "", err
	}
	if claims.Aud != origin {
		return "", fmt.Errorf("HIGH_SEC: this token is bound to %s, not %s. Use the matching hub URL or issue a new token.", claims.Aud, origin)
	}
	pub, err := parseSPKI(claims.Pub)
	if err != nil {
		return "", fmt.Errorf("%s", highSecKeyMismatch)
	}
	reqURL := origin + "/v1/challenge?kid=" + url.QueryEscape(claims.Kid)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return "", err
	}
	client := &http.Client{Timeout: 15 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("%s", highSecHandshake)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("%s", highSecHandshake)
	}
	var chal challengeBody
	if err := json.Unmarshal(body, &chal); err != nil {
		return "", fmt.Errorf("%s", highSecHandshake)
	}
	if res.StatusCode != http.StatusOK {
		if chal.Error != "" {
			return "", fmt.Errorf("%s", chal.Error)
		}
		return "", fmt.Errorf("%s", highSecHandshake)
	}
	if chal.Kid != "" && chal.Kid != claims.Kid {
		return "", fmt.Errorf("%s", highSecKeyMismatch)
	}
	if chal.Aud != "" && hubOrigin(chal.Aud) != claims.Aud {
		return "", fmt.Errorf("%s", highSecKeyMismatch)
	}
	if !verifyChallenge(pub, claims.Aud, claims.Kid, chal.Nonce, chal.Sig) {
		return "", fmt.Errorf("%s", highSecKeyMismatch)
	}
	wrap, err := wrapAuth(pub, claims.Sec, chal.Nonce)
	if err != nil {
		return "", fmt.Errorf("%s", highSecKeyMismatch)
	}
	return "Fleet-OAEP " + claims.Kid + "." + wrap, nil
}
