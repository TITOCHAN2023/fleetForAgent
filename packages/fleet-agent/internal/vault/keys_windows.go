//go:build windows

package vault

import (
	"context"
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"runtime"
	"unsafe"
)

type dpapiStore struct{ dir string }

func systemKeyStore(dir string) KeyStore { return dpapiStore{dir: dir} }
func blob(b []byte) windows.DataBlob {
	if len(b) == 0 {
		return windows.DataBlob{}
	}
	return windows.DataBlob{Size: uint32(len(b)), Data: &b[0]}
}
func (s dpapiStore) Load(ctx context.Context, id string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(s.dir, id+".dpapi"))
	if err != nil || len(b) > 4096 {
		return nil, ErrLocked
	}
	in, entropy := blob(b), blob([]byte("Fleet storage v1/"+id))
	var out windows.DataBlob
	err = windows.CryptUnprotectData(&in, nil, &entropy, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	runtime.KeepAlive(b)
	if err != nil {
		return nil, ErrLocked
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	if out.Size != 32 {
		return nil, ErrLocked
	}
	return append([]byte{}, unsafe.Slice(out.Data, int(out.Size))...), nil
}
func (s dpapiStore) Save(ctx context.Context, id string, key []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(key) != 32 {
		return errors.New("invalid storage key")
	}
	in, entropy := blob(key), blob([]byte("Fleet storage v1/"+id))
	var out windows.DataBlob
	if err := windows.CryptProtectData(&in, nil, &entropy, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return errors.New("DPAPI protection failed")
	}
	runtime.KeepAlive(key)
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	path := filepath.Join(s.dir, id+".dpapi")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(unsafe.Slice(out.Data, int(out.Size))); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
