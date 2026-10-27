package main

import (
	"strings"
	"testing"
)

func TestRedactSecrets(t *testing.T) {
	cases := []struct {
		in, leak string
	}{
		{`curl -H "Authorization: Bearer abcdEFGH1234.xyz" https://api.example.com`, "abcdEFGH1234"},
		{`OPENAI_API_KEY=sk-proj-0123456789abcdefABCD python run.py`, "0123456789abcdef"},
		{`fleet-agent start --token flt_1.AAAABBBBCCCCDDDD`, "AAAABBBBCCCC"},
		{`export GITHUB_TOKEN=ghp_0123456789abcdefghij`, "0123456789abcdef"},
		{`aws s3 ls # AKIAABCDEFGHIJKLMNOP`, "ABCDEFGHIJKLMNOP"},
		{`mysql --password=hunter22 -u root`, "hunter22"},
		{`{"api_key": "zyxw9876"}`, "zyxw9876"},
	}
	for _, c := range cases {
		got := redactSecrets(c.in)
		if strings.Contains(got, c.leak) || !strings.Contains(got, "[redacted]") {
			t.Errorf("redactSecrets(%q) = %q", c.in, got)
		}
	}
	for _, keep := range []string{"ls -la /tmp", "git status", "result 0: echo token", "npm run build -- --mode development"} {
		if got := redactSecrets(keep); got != keep {
			t.Errorf("redactSecrets(%q) changed to %q", keep, got)
		}
	}
}

func TestAgentLogRedactsStateLines(t *testing.T) {
	a := &Agent{}
	a.log("info", "result 0: curl -H 'Authorization: Bearer s3cr3tvalue99' x")
	if msg := a.logs[0].Msg; strings.Contains(msg, "s3cr3tvalue99") {
		t.Fatalf("log line kept secret: %q", msg)
	}
}
