package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const (
	maxExtractedUpdateBytes = maxUpdateBytes
	maxUpdateArchiveEntries = 4096
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
		return copyExecutableReplaceLimited(archive, dest, maxExtractedUpdateBytes)
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
	return extractFromTarGzWithLimits(archive, dest, maxExtractedUpdateBytes, maxUpdateArchiveEntries)
}

func extractFromTarGzLimited(archive, dest string, maxBytes int64) error {
	return extractFromTarGzWithLimits(archive, dest, maxBytes, maxUpdateArchiveEntries)
}

func extractFromTarGzWithLimits(archive, dest string, maxBytes int64, maxEntries int) error {
	if maxEntries <= 0 {
		return fmt.Errorf("update: invalid archive entry limit")
	}
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
	entries := 0
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		entries++
		if entries > maxEntries {
			return fmt.Errorf("update: archive exceeds %d entries", maxEntries)
		}
		if hdr.FileInfo().IsDir() {
			continue
		}
		if !looksLikeAgentBinary(hdr.Name) {
			continue
		}
		if hdr.Typeflag != tar.TypeReg && hdr.Typeflag != tar.TypeRegA {
			return fmt.Errorf("update: fleet-agent is not a regular file")
		}
		return writeExtractedLimited(dest, tr, hdr.FileInfo().Mode(), maxBytes)
	}
	return fmt.Errorf("update: fleet-agent not found in archive")
}

func extractFromZip(archive, dest string) error {
	return extractFromZipLimited(archive, dest, maxExtractedUpdateBytes)
}

func extractFromZipLimited(archive, dest string, maxBytes int64) error {
	r, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer r.Close()
	if len(r.File) > maxUpdateArchiveEntries {
		return fmt.Errorf("update: archive exceeds %d entries", maxUpdateArchiveEntries)
	}
	var fallback *zip.File
	for _, f := range r.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name := filepath.ToSlash(f.Name)
		if strings.HasSuffix(name, "Contents/MacOS/FleetAgent") || looksLikeAgentBinary(f.Name) {
			if !f.Mode().IsRegular() {
				return fmt.Errorf("update: FleetAgent is not a regular file")
			}
			rc, err := f.Open()
			if err != nil {
				return err
			}
			err = writeExtractedLimited(dest, rc, f.Mode(), maxBytes)
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
		if !fallback.Mode().IsRegular() {
			return fmt.Errorf("update: FleetAgent is not a regular file")
		}
		return writeExtractedLimited(dest, rc, fallback.Mode(), maxBytes)
	}
	return fmt.Errorf("update: FleetAgent not found in zip")
}

func writeExtracted(dest string, r io.Reader, mode os.FileMode) error {
	return writeExtractedLimited(dest, r, mode, maxExtractedUpdateBytes)
}

func writeExtractedLimited(dest string, r io.Reader, mode os.FileMode, maxBytes int64) error {
	return writeFileLimited(dest, r, mode, maxBytes, true)
}

func writeFileLimited(dest string, r io.Reader, mode os.FileMode, maxBytes int64, executable bool) error {
	if maxBytes <= 0 {
		return fmt.Errorf("update: invalid extraction limit")
	}
	tmp := dest + ".part"
	_ = os.Remove(tmp)
	perm := mode.Perm()
	if perm == 0 {
		perm = 0o755
	}
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(out, io.LimitReader(r, maxBytes+1))
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(tmp)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tmp)
		return closeErr
	}
	if n > maxBytes {
		_ = os.Remove(tmp)
		return fmt.Errorf("update: extracted payload exceeds %d bytes", maxBytes)
	}
	_ = os.Remove(dest)
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if executable {
		perm |= 0o111
	}
	return os.Chmod(dest, perm)
}

func copyFileReplaceLimited(src, dest string, maxBytes int64) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("update: payload is not a regular file")
	}
	return writeFileLimited(dest, in, info.Mode(), maxBytes, false)
}

func copyExecutableReplaceLimited(src, dest string, maxBytes int64) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("update: payload is not a regular file")
	}
	return writeFileLimited(dest, in, info.Mode(), maxBytes, true)
}

type extractionBudget struct {
	limit     int64
	remaining int64
}

func newExtractionBudget(maxBytes int64) (*extractionBudget, error) {
	if maxBytes <= 0 {
		return nil, fmt.Errorf("update: invalid extraction limit")
	}
	return &extractionBudget{limit: maxBytes, remaining: maxBytes}, nil
}

func (b *extractionBudget) copy(dst io.Writer, src io.Reader) error {
	if b == nil || b.remaining < 0 {
		return fmt.Errorf("update: invalid extraction budget")
	}
	limit := b.remaining
	n, err := io.Copy(dst, io.LimitReader(src, limit+1))
	if n <= limit {
		b.remaining -= n
	} else {
		b.remaining = 0
	}
	if err != nil {
		return err
	}
	if n > limit {
		return fmt.Errorf("update: extracted payload exceeds %d bytes", b.limit)
	}
	return nil
}

func (b *extractionBudget) readAll(src io.Reader) ([]byte, error) {
	if b == nil || b.remaining < 0 {
		return nil, fmt.Errorf("update: invalid extraction budget")
	}
	limit := b.remaining
	data, err := io.ReadAll(io.LimitReader(src, limit+1))
	if int64(len(data)) <= limit {
		b.remaining -= int64(len(data))
	} else {
		b.remaining = 0
	}
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("update: extracted payload exceeds %d bytes", b.limit)
	}
	return data, nil
}

// extractZipAppBundle extracts one complete .app into a sibling staging path.
// It never trusts zip size metadata as the enforcement mechanism: every byte
// written passes through one shared budget, and the partial bundle is removed
// on every failure.
func extractZipAppBundle(archive, destApp string, maxBytes int64) error {
	return extractZipAppBundleWithLimits(archive, destApp, maxBytes, maxUpdateArchiveEntries)
}

func extractZipAppBundleWithLimits(archive, destApp string, maxBytes int64, maxEntries int) error {
	if !safeAppBundlePath(destApp) {
		return fmt.Errorf("update: unsafe app staging path")
	}
	if maxEntries <= 0 {
		return fmt.Errorf("update: invalid archive entry limit")
	}
	r, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer r.Close()
	if len(r.File) > maxEntries {
		return fmt.Errorf("update: archive exceeds %d entries", maxEntries)
	}

	root, err := zipAppRoot(r.File)
	if err != nil {
		return err
	}
	part := destApp + ".part"
	if err := removeAppBundlePath(part); err != nil {
		return err
	}
	if err := removeAppBundlePath(destApp); err != nil {
		return err
	}
	if err := os.MkdirAll(part, 0o755); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = removeAppBundlePath(part)
		}
	}()

	budget, err := newExtractionBudget(maxBytes)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	prefix := root + "/"
	for _, f := range r.File {
		name, err := cleanZipPath(f.Name)
		if err != nil {
			return err
		}
		if name == root || !strings.HasPrefix(name, prefix) {
			continue
		}
		rel := strings.TrimPrefix(name, prefix)
		if rel == "" || isAppleDoublePath(rel) {
			continue
		}
		dest := filepath.Join(part, filepath.FromSlash(rel))
		if !pathWithin(part, dest) {
			return fmt.Errorf("update: zip path escapes app bundle")
		}
		mode := f.Mode()
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(dest, directoryMode(mode)); err != nil {
				return err
			}
			continue
		}
		if seen[rel] {
			return fmt.Errorf("update: duplicate zip entry %q", rel)
		}
		seen[rel] = true
		if f.UncompressedSize64 > uint64(budget.remaining) {
			return fmt.Errorf("update: extracted payload exceeds %d bytes", maxBytes)
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		if mode&os.ModeSymlink != 0 {
			data, readErr := budget.readAll(rc)
			closeErr := rc.Close()
			if readErr != nil {
				return readErr
			}
			if closeErr != nil {
				return closeErr
			}
			target := string(data)
			if !safeBundleSymlink(part, dest, target) {
				return fmt.Errorf("update: unsafe app symlink %q", rel)
			}
			if err := os.Symlink(target, dest); err != nil {
				return err
			}
			continue
		}
		if !mode.IsRegular() {
			_ = rc.Close()
			return fmt.Errorf("update: unsupported app entry %q", rel)
		}
		perm := mode.Perm()
		if perm == 0 {
			perm = 0o644
		}
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, perm)
		if err != nil {
			_ = rc.Close()
			return err
		}
		copyErr := budget.copy(out, rc)
		closeOutErr := out.Close()
		closeInErr := rc.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeOutErr != nil {
			return closeOutErr
		}
		if closeInErr != nil {
			return closeInErr
		}
	}
	if err := validateAppBundle(part); err != nil {
		return err
	}
	if err := os.Rename(part, destApp); err != nil {
		return err
	}
	committed = true
	return nil
}

func zipAppRoot(files []*zip.File) (string, error) {
	roots := map[string]bool{}
	for _, f := range files {
		name, err := cleanZipPath(f.Name)
		if err != nil {
			return "", err
		}
		const executable = "/Contents/MacOS/FleetAgent"
		if !strings.HasSuffix(name, executable) {
			continue
		}
		root := strings.TrimSuffix(name, executable)
		if !strings.HasSuffix(root, ".app") || strings.Contains(root, "/") {
			return "", fmt.Errorf("update: app bundle must be at zip root")
		}
		roots[root] = true
	}
	if len(roots) != 1 {
		return "", fmt.Errorf("update: expected one FleetAgent app bundle")
	}
	for root := range roots {
		return root, nil
	}
	return "", fmt.Errorf("update: FleetAgent app bundle not found")
}

func cleanZipPath(name string) (string, error) {
	if name == "" || strings.Contains(name, "\\") || strings.HasPrefix(name, "/") {
		return "", fmt.Errorf("update: unsafe zip path %q", name)
	}
	clean := path.Clean(name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("update: unsafe zip path %q", name)
	}
	return clean, nil
}

func isAppleDoublePath(rel string) bool {
	for _, part := range strings.Split(rel, "/") {
		if strings.HasPrefix(part, "._") {
			return true
		}
	}
	return false
}

func directoryMode(mode os.FileMode) os.FileMode {
	if perm := mode.Perm(); perm != 0 {
		return perm
	}
	return 0o755
}

func pathWithin(root, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func safeBundleSymlink(root, linkPath, target string) bool {
	if target == "" || filepath.IsAbs(target) {
		return false
	}
	resolved := filepath.Clean(filepath.Join(filepath.Dir(linkPath), filepath.FromSlash(target)))
	return pathWithin(root, resolved)
}

func safeAppBundlePath(app string) bool {
	clean := filepath.Clean(app)
	return filepath.IsAbs(clean) && strings.HasSuffix(filepath.Base(clean), ".app") && filepath.Dir(clean) != clean
}

func removeAppBundlePath(app string) error {
	clean := strings.TrimSuffix(filepath.Clean(app), ".part")
	if !safeAppBundlePath(clean) {
		return fmt.Errorf("update: unsafe app removal path")
	}
	return os.RemoveAll(app)
}

func validateAppBundle(app string) error {
	for _, rel := range []string{"Contents/Info.plist", "Contents/MacOS/FleetAgent"} {
		info, err := os.Stat(filepath.Join(app, filepath.FromSlash(rel)))
		if err != nil {
			return fmt.Errorf("update: incomplete app bundle: %s: %w", rel, err)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("update: incomplete app bundle: %s is not a regular file", rel)
		}
	}
	return nil
}

func copyStream(dst io.Writer, src io.Reader) (int64, error) {
	return io.Copy(dst, src)
}
