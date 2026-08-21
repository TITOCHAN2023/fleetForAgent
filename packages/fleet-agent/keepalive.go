package main

import "sync/atomic"

// wantedKeepAlive is set from the agent enabled switch.
// Platform loops hold an idle-sleep assertion only while this is true.
// Screen lock / display sleep stay allowed — the machine itself stays up.
var wantedKeepAlive atomic.Bool

func setKeepAlive(on bool) {
	wantedKeepAlive.Store(on)
}
