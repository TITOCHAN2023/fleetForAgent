package tray

type Snapshot struct {
	Enabled        bool
	AutoUpdate     bool
	Permit         string
	Conn           string
	Error          string
	DeviceID       string
	PendingCommand string
}

type Controller interface {
	TraySnapshot() Snapshot
	SetEnabled(bool)
	SetPermit(string)
	Approve()
	Deny()
	Reconnect()
	RequestRestart()
	SetAutoUpdate(bool)
	OpenSettings()
	OnQuit()
}
