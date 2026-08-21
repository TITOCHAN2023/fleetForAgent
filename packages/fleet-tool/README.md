# fleet-tool

Operator client. Config is the website origin plus the hub token from Settings.

```bash
FLEET_URL=http://127.0.0.1:8080 FLEET_TOKEN=flt_... node index.mjs list
FLEET_URL=http://127.0.0.1:8080 FLEET_TOKEN=flt_... node index.mjs run <device_id> 'uname -a'
```

Cursor / MCP: run `node index.mjs` with those two env vars, no extra args.
