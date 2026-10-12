//go:build !linux && !darwin && !freebsd && !netbsd && !openbsd

package pane

import "fmt"

func SessionCLI([]string) error {
	return fmt.Errorf("Fleet mux sessions require a supported POSIX terminal")
}
