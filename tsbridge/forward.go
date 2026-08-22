// Package tsbridge embeds a userspace Tailscale node (tsnet) in-process and
// forwards a loopback TCP listener to a single host:port reachable over the
// tailnet. It exposes only primitive-typed functions (see bridge.go) so the
// gomobile-generated Java binding stays stable across changes to this
// package's internals.
package tsbridge

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"sync"
	"time"
)

// dialFunc matches the signature of both net.Dialer.DialContext and
// tsnet.Server.Dial, letting runForward be exercised in tests with a plain
// TCP dialer instead of a real tsnet node.
type dialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// runForward accepts connections on l and, for each one, dials hubHostPort
// via dial and pipes the two connections together bidirectionally. It
// returns when l is closed (net.ErrClosed from Accept) or, for any other
// context, keeps looping — a single failed accept or a single failed dial
// only affects that one connection.
//
// This is the testable core of the forwarder: it has no dependency on tsnet,
// so forward_test.go exercises it against two plain local listeners (one
// standing in for the tsnet-dialed hub).
func runForward(l net.Listener, dial dialFunc, hubHostPort string) {
	var wg sync.WaitGroup
	defer wg.Wait()

	for {
		conn, err := l.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			// Any other accept error is treated as transient: log and keep
			// serving rather than tearing down the whole forwarder.
			log.Printf("tsbridge: accept error: %v", err)
			continue
		}

		wg.Add(1)
		go func(c net.Conn) {
			defer wg.Done()
			handleConn(c, dial, hubHostPort)
		}(conn)
	}
}

// handleConn dials hubHostPort and pipes c <-> the dialed connection until
// either side is done, then closes both.
func handleConn(c net.Conn, dial dialFunc, hubHostPort string) {
	defer c.Close()

	// A per-connection dial timeout keeps a hung dial from leaking a
	// goroutine forever; the tailnet dial itself may be slow (DERP relay,
	// first handshake) so this is generous rather than tight.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	hubConn, err := dial(ctx, "tcp", hubHostPort)
	if err != nil {
		log.Printf("tsbridge: dial %s failed: %v", hubHostPort, err)
		return
	}
	defer hubConn.Close()

	pipe(c, hubConn)
}

// pipe copies data bidirectionally between a and b until both directions are
// done, half-closing each side's write direction (via CloseWrite) when its
// source is exhausted so the other side sees EOF/FIN as normal TCP would,
// rather than an abrupt reset. If either copy errors, both connections are
// closed to unblock the other goroutine.
func pipe(a, b net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)

	copyAndClose := func(dst, src net.Conn) {
		defer wg.Done()
		_, err := io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			cw.CloseWrite()
		} else {
			dst.Close()
		}
		if err != nil {
			// Propagating an error on one leg means the other leg's read is
			// very likely stuck or about to fail on its own; force both
			// connections closed so neither goroutine blocks forever.
			a.Close()
			b.Close()
		}
	}

	go copyAndClose(b, a)
	go copyAndClose(a, b)
	wg.Wait()
}
