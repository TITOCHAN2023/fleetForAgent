//go:build darwin || windows || linux

package main

import _ "embed"

//go:embed ui/tray.png
var trayPNGBytes []byte

//go:embed ui/tray.ico
var trayICOBytes []byte

func trayPNG(template bool) []byte {
	return trayPNGBytes
}

func trayICO() []byte {
	return trayICOBytes
}
