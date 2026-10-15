//go:build linux || darwin

package vault

import "os"

func publishConfig(from, to string) error {
	// The source is complete; a hard link is an atomic no-clobber publication.
	if err := os.Link(from, to); err != nil {
		return err
	}
	f, err := os.OpenFile(to, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
func replaceFile(from, to string) error { return os.Rename(from, to) }
