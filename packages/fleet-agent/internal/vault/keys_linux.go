//go:build linux

package vault

import (
	"context"
	"errors"
	"github.com/godbus/dbus/v5"
)

type secretServiceStore struct{}
type serviceSecret struct {
	Session     dbus.ObjectPath
	Parameters  []byte
	Value       []byte
	ContentType string
}

func systemKeyStore(string) KeyStore { return secretServiceStore{} }

const secretBus = "org.freedesktop.secrets"

func secretSession(ctx context.Context) (*dbus.Conn, dbus.ObjectPath, error) {
	conn, err := dbus.ConnectSessionBus(dbus.WithContext(ctx))
	if err != nil {
		return nil, "", ErrLocked
	}
	var output dbus.Variant
	var session dbus.ObjectPath
	err = conn.Object(secretBus, "/org/freedesktop/secrets").CallWithContext(ctx, "org.freedesktop.Secret.Service.OpenSession", 0, "plain", dbus.MakeVariant("")).Store(&output, &session)
	if err != nil || session == "/" {
		conn.Close()
		return nil, "", ErrLocked
	}
	return conn, session, nil
}
func (secretServiceStore) Load(ctx context.Context, id string) ([]byte, error) {
	conn, session, err := secretSession(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	var unlocked, locked []dbus.ObjectPath
	attrs := map[string]string{"application": "cc.ginfo.fleet", "key_id": id}
	err = conn.Object(secretBus, "/org/freedesktop/secrets").CallWithContext(ctx, "org.freedesktop.Secret.Service.SearchItems", 0, attrs).Store(&unlocked, &locked)
	if err != nil || len(unlocked) != 1 || len(locked) != 0 {
		return nil, ErrLocked
	}
	var secret serviceSecret
	err = conn.Object(secretBus, unlocked[0]).CallWithContext(ctx, "org.freedesktop.Secret.Item.GetSecret", 0, session).Store(&secret)
	if err != nil || secret.Session != session || len(secret.Parameters) != 0 || len(secret.Value) != 32 {
		return nil, ErrLocked
	}
	return secret.Value, nil
}
func (secretServiceStore) Save(ctx context.Context, id string, key []byte) error {
	if len(id) != 32 || len(key) != 32 {
		return errors.New("invalid Secret Service item")
	}
	conn, session, err := secretSession(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	var collection dbus.ObjectPath
	err = conn.Object(secretBus, "/org/freedesktop/secrets").CallWithContext(ctx, "org.freedesktop.Secret.Service.ReadAlias", 0, "default").Store(&collection)
	if err != nil || collection == "/" {
		return ErrLocked
	}
	properties := map[string]dbus.Variant{"org.freedesktop.Secret.Item.Label": dbus.MakeVariant("Fleet encrypted storage"), "org.freedesktop.Secret.Item.Attributes": dbus.MakeVariant(map[string]string{"application": "cc.ginfo.fleet", "key_id": id})}
	var item, prompt dbus.ObjectPath
	secret := serviceSecret{Session: session, Parameters: []byte{}, Value: key, ContentType: "application/octet-stream"}
	err = conn.Object(secretBus, collection).CallWithContext(ctx, "org.freedesktop.Secret.Collection.CreateItem", 0, properties, secret, false).Store(&item, &prompt)
	if err != nil || prompt != "/" || item == "/" {
		return ErrLocked
	}
	return nil
}
