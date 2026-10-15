//go:build linux || darwin

package activity

import "os"

func replaceJournal(from, to string) error { return os.Rename(from, to) }
