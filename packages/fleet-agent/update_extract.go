package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func extractAgentBinary(archive, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	switch {
	case strings.HasSuffix(strings.ToLower(archive), ".tar.gz") || strings.HasSuffix(strings.ToLower(archive), ".tgz"):
		return extractFromTarGz(archive, dest)
	case strings.HasSuffix(strings.ToLower(archive), ".zip"):
		return extractFromZip(archive, dest)
	case strings.HasSuffix(strings.ToLower(archive), ".dmg"):
		return extractFromDMG(archive, dest)
	default:
		return copyFileReplace(archive, dest)
	}
}

func looksLikeAgentBinary(name string) bool {
	base := filepath.Base(name)
	switch base {
	case "FleetAgent", "FleetAgent.exe", "fleet-agent", "fleet-agent.exe":
		return true
	default:
		return false
	}
}

func extractFromTarGz(archive, dest string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if hdr.FileInfo().IsDir() {
			continue
		}
		if !looksLikeAgentBinary(hdr.Name) {
			continue
		}
		if filepath.Base(hdr.Name) == "fleet" {
			continue
		}
		return writeExtracted(dest, tr, hdr.FileInfo().Mode())
	}
	return fmt.Errorf("update: fleet-agent not found in archive")
}

func extractFromZip(archive, dest string) error {
	r, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer r.Close()
	var fallback *zip.File
	for _, f := range r.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name := filepath.ToSlash(f.Name)
		if strings.HasSuffix(name, "Contents/MacOS/FleetAgent") || looksLikeAgentBinary(f.Name) {
			rc, err := f.Open()
			if err != nil {
				return err
			}
			err = writeExtracted(dest, rc, f.Mode())
			rc.Close()
			return err
		}
		if fallback == nil && strings.Contains(name, "FleetAgent") {
			fallback = f
		}
	}
	if fallback != nil {
		rc, err := fallback.Open()
		if err != nil {
			return err
		}
		defer rc.Close()
		return writeExtracted(dest, rc, fallback.Mode())
	}
	return fmt.Errorf("update: FleetAgent not found in zip")
}

func writeExtracted(dest string, r io.Reader, mode os.FileMode) error {
	tmp := dest + ".part"
	perm := mode.Perm()
	if perm == 0 {
		perm = 0o755
	}
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, r)
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(tmp)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tmp)
		return closeErr
	}
	_ = os.Remove(dest)
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Chmod(dest, perm|0o111)
}

func copyStream(dst io.Writer, src io.Reader) (int64, error) {
	return io.Copy(dst, src)
}
