---
title: One machine was not enough
date: 2026-08-24
summary: The grok bot could only touch one machine at a time, and that machine was not mine. I wanted any agent that loads an MCP server to reach all of my own computers, which meant solving dial-out first and then solving models that re-send commands.
---

Fleet started from that bot on grok. It could run commands, one machine at a time, and the machine was its own sandbox.

What I lacked was not a machine. The machines were already here, Windows, Linux, macOS, any arch. What was missing was the layer that lets an agent reach them.

## Why MCP

I did not write a new client. Nobody would have used it, because the good agents already live somewhere else.

The nice thing about this layer is that it does not care about the host. Any agent that can load an MCP server gets a whole list of machines to work with. Configuration is two values, `FLEET_URL` and `FLEET_TOKEN`, the same pair the Go agent takes. `~/.fleet/mcp.env` gets read too, and it leaves already-set environment variables alone.

One file is the entry point. With arguments it is a CLI, without them it goes to MCP stdio.

```js
// packages/fleet-tool/index.mjs
const argv = applyCliDevFlag(process.argv.slice(2), process.env);
if (argv.length) {
  // ... node index.mjs list / run <device_id> '...'
} else {
  mcp();
}
```

That saves maintaining one more binary, and it saves the chance for two codebases to contradict each other.

## What the tool surface looks like

Twelve tools. `list_computers` returns the machines under the account, `set_computer` remembers one, and later calls can leave `device_id` out.

`set_computer` lives only in the current stdio process. It touches no disk, writes nothing back to the account, and stays invisible to other clients. That part is deliberate. One account may have the web console and two agents open under it, and none of them should move the machine somebody else is working on.

It also will not pick the only online machine for you. Models are happy to guess, and a wrong guess lands the command on a different computer. With no remembered device it errors out and asks you to say which one.

## A model is not a person

This is the part I changed the most.

A person waits in a terminal for the command to finish. A model does not wait. It decides it failed and sends the same command again. The traces of taking that seriously sit in the tool descriptions, where the same warning appears four times, once each in `run`, `get_result` and `wait`, plus once in the instructions handed to the model at initialize.

`run` returns right away, and `wait_ms` is only how long this MCP call is willing to wait, with nothing to do with killing a process on timeout.

```js
// packages/fleet-tool/operator.mjs
/** MCP-call wait budget only. Not a kill timeout. Hosts cancel tools at ~60s. */
export const WAIT_MAX_MS = 30_000;
```

The ceiling sits at 30 seconds. Hosts cancel a tool call at around 60, which leaves headroom. Running out returns one line of `still running`, which does not count as an error, and cancelling the wait does not kill the remote command.

The note handed to the model says exactly that.

```
run waits up to 30s; if the text is still running, call wait — do not run again.
```

## What that changed on the device

Hang the command on a hub request and the hub has to hold a process up the whole time, and the output has nobody to receive it the moment the model disconnects. So the job lives on the device.

Every `run` starts its own process there, `shell -c` on a PTY under POSIX, `cmd /C` on Windows. Finishing is the child exit code rather than a prompt. A stuck job therefore cannot eat the next command.

Output stays in a local ring with a fixed length.

```go
// packages/fleet-agent/internal/pane/pane.go
const (
	ScreenInterval = 250 * time.Millisecond
	ringLines      = 200
	headLines      = 200
	screenLines    = 80
)
```

The wire carries snapshots, one frame per 250 milliseconds, latest frame wins, intermediate ones dropped. A model reading a screen wants to know what it looks like now, not every byte that scrolled past in the last two seconds.

## Dial-out is the precondition

Machines behind home broadband usually have no public IP, and the router should not open a port over this. The agent dials `WSS /v1/device` outward on its own, no inbound port on the device, and the operator side only talks HTTPS to the website.

That decides whether ordinary people can use any of this. Teaching someone to set up port forwarding first would waste however smooth the tools above are.

## The token is held by a model

That is also why the switch stays on the machine. The three permit states live in the agent, off, ask and allow, and the hub cannot change them, since the protocol has no message for it. At ask, the command waits there until you tap on the machine.

Models take liberties. People slip. A switch on the machine being operated covers both.

There is no ceiling on the number of machines.

```ts
// src/lib/fleet/cap.ts
/** Fleet size is unbounded. Three seed boxes are a demo, not a ceiling. */
export const FLEET_CAP: number | null = null;
```
