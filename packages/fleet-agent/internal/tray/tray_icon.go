//go:build darwin || windows || linux

package tray

import _ "embed"

//go:embed tray.png
var trayPNGBytes []byte

//go:embed tray.ico
var trayICOBytes []byte

func trayPNG(template bool) []byte {
	return trayPNGBytes
}

func trayICO() []byte {
	return trayICOBytes
}
