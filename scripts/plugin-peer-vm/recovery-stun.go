// Local test fixture only. The harness exposes this UDP socket solely on an
// internal Docker network; production neither imports nor packages this file.
package main

import (
	"log"
	"net"

	"github.com/pion/stun/v3"
)

func main() {
	socket, err := net.ListenUDP("udp4", &net.UDPAddr{Port: 3478})
	if err != nil {
		log.Fatal(err)
	}
	defer socket.Close()
	buffer := make([]byte, 2048)
	for {
		n, peer, err := socket.ReadFromUDP(buffer)
		if err != nil {
			log.Fatal(err)
		}
		request := &stun.Message{Raw: append([]byte(nil), buffer[:n]...)}
		if request.Decode() != nil || request.Type != stun.BindingRequest {
			continue
		}
		response, err := stun.Build(stun.NewTransactionIDSetter(request.TransactionID),
			stun.BindingSuccess, stun.XORMappedAddress{IP: peer.IP, Port: peer.Port}, stun.Fingerprint)
		if err != nil {
			continue
		}
		if _, err = socket.WriteToUDP(response.Raw, peer); err != nil {
			log.Print(err)
		}
	}
}
