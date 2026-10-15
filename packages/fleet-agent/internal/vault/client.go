package vault

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

func InvocationCipher(ctx context.Context) (*Cipher, error) {
	endpoint, token := os.Getenv("FLEET_PLUGIN_STORAGE_URL"), os.Getenv("FLEET_PLUGIN_ACTIVITY_TOKEN")
	if endpoint == "" && token == "" {
		return nil, nil
	}
	if endpoint == "" {
		return nil, nil
	} // Older Core has no storage capability.
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" && u.Hostname() != "localhost") || token == "" {
		return nil, errors.New("invalid storage capability")
	}
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, strings.NewReader("{}"))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	client := http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("storage redirect refused") }}
	response, err := client.Do(req)
	if err != nil {
		return nil, errors.New("storage capability unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, ErrLocked
	}
	var reply struct {
		Encrypted bool   `json:"encrypted"`
		Key       []byte `json:"key"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 1024)).Decode(&reply) != nil {
		return nil, errors.New("invalid storage response")
	}
	defer clear(reply.Key)
	if !reply.Encrypted {
		return nil, nil
	}
	return New(reply.Key)
}
