package tsbridge

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

// startEchoServer starts a plain TCP listener that echoes back whatever it
// reads, standing in for "the hub" on the far side of a tsnet dial in these
// tests. It returns the listener (so the test can close it to simulate the
// hub going away) and its address.
func startEchoServer(t *testing.T) (net.Listener, string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				io.Copy(c, c) //nolint:errcheck // best-effort echo for test fixture
				c.Close()
			}(c)
		}
	}()
	return ln, ln.Addr().String()
}

// dialTCP adapts net.Dialer to the dialFunc signature runForward expects.
func dialTCP(ctx context.Context, network, addr string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, network, addr)
}

func startForwarder(t *testing.T, hubAddr string) (frontAddr string, stop func()) {
	t.Helper()
	front, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	done := make(chan struct{})
	go func() {
		runForward(front, dialTCP, hubAddr)
		close(done)
	}()
	return front.Addr().String(), func() {
		front.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("runForward did not return after listener close")
		}
	}
}

func TestRunForward_EchoRoundTrip(t *testing.T) {
	hub, hubAddr := startEchoServer(t)
	defer hub.Close()

	frontAddr, stop := startForwarder(t, hubAddr)
	defer stop()

	conn, err := net.Dial("tcp", frontAddr)
	if err != nil {
		t.Fatalf("dial forwarder: %v", err)
	}
	defer conn.Close()

	want := []byte("hola mundo, esto es una prueba de ida y vuelta")
	if _, err := conn.Write(want); err != nil {
		t.Fatalf("write: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	got := make([]byte, len(want))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("echo mismatch: got %q want %q", got, want)
	}
}

func TestRunForward_LargeBidirectionalTransfer(t *testing.T) {
	hub, hubAddr := startEchoServer(t)
	defer hub.Close()

	frontAddr, stop := startForwarder(t, hubAddr)
	defer stop()

	conn, err := net.Dial("tcp", frontAddr)
	if err != nil {
		t.Fatalf("dial forwarder: %v", err)
	}
	defer conn.Close()

	// Larger than typical TCP buffers so both io.Copy directions have to do
	// real work concurrently, not just single small read/writes.
	want := make([]byte, 4*1024*1024)
	if _, err := rand.Read(want); err != nil {
		t.Fatalf("rand: %v", err)
	}

	var wg sync.WaitGroup
	wg.Add(1)
	var writeErr error
	go func() {
		defer wg.Done()
		_, writeErr = conn.Write(want)
	}()

	conn.SetReadDeadline(time.Now().Add(20 * time.Second))
	got := make([]byte, len(want))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read: %v", err)
	}
	wg.Wait()
	if writeErr != nil {
		t.Fatalf("write: %v", writeErr)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("large transfer mismatch")
	}
}

func TestRunForward_MultipleConcurrentConns(t *testing.T) {
	hub, hubAddr := startEchoServer(t)
	defer hub.Close()

	frontAddr, stop := startForwarder(t, hubAddr)
	defer stop()

	const n = 20
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			conn, err := net.Dial("tcp", frontAddr)
			if err != nil {
				errs <- err
				return
			}
			defer conn.Close()
			msg := []byte{byte(i), byte(i + 1), byte(i + 2)}
			if _, err := conn.Write(msg); err != nil {
				errs <- err
				return
			}
			conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			got := make([]byte, len(msg))
			if _, err := io.ReadFull(conn, got); err != nil {
				errs <- err
				return
			}
			if !bytes.Equal(got, msg) {
				errs <- errors.New("mismatch")
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("concurrent conn failed: %v", err)
		}
	}
}

func TestRunForward_HubCloseEndsClientConn(t *testing.T) {
	// A hub listener that hands back the accepted conn on a channel, so the
	// test can close that specific conn (simulating the far end hanging up
	// mid-session) rather than just closing the listener.
	hubLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer hubLn.Close()
	hubConns := make(chan net.Conn, 1)
	go func() {
		c, err := hubLn.Accept()
		if err != nil {
			return
		}
		hubConns <- c
	}()

	frontAddr, stop := startForwarder(t, hubLn.Addr().String())
	defer stop()

	conn, err := net.Dial("tcp", frontAddr)
	if err != nil {
		t.Fatalf("dial forwarder: %v", err)
	}
	defer conn.Close()

	// Prove the pair is actually established end-to-end before tearing
	// anything down: write from the client and read the same bytes back on
	// the hub side.
	if _, err := conn.Write([]byte("hi")); err != nil {
		t.Fatalf("client write: %v", err)
	}
	var hubConn net.Conn
	select {
	case hubConn = <-hubConns:
	case <-time.After(5 * time.Second):
		t.Fatal("hub never accepted a connection")
	}
	hubConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 2)
	if _, err := io.ReadFull(hubConn, buf); err != nil {
		t.Fatalf("hub read: %v", err)
	}

	// Now close only the hub's accepted connection (not the listener) —
	// this should propagate through the forwarder as EOF on the client
	// side, proving hub-side close propagates through the pipe.
	hubConn.Close()

	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err := conn.Read(buf)
	if n != 0 || (err != io.EOF && !errors.Is(err, net.ErrClosed)) {
		t.Fatalf("expected EOF/closed on client side after hub-side close, got n=%d err=%v", n, err)
	}
}

func TestRunForward_ListenerCloseEndsAcceptLoop(t *testing.T) {
	hub, hubAddr := startEchoServer(t)
	defer hub.Close()

	front, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	done := make(chan struct{})
	go func() {
		runForward(front, dialTCP, hubAddr)
		close(done)
	}()

	front.Close()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("runForward did not return after listener.Close()")
	}
}

func TestRunForward_DialFailureDoesNotCrashLoop(t *testing.T) {
	// Reserve a hub address, then free it immediately so the address is
	// valid but nothing is listening on the first attempt.
	reserveLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	hubAddr := reserveLn.Addr().String()
	reserveLn.Close()

	frontAddr, stop := startForwarder(t, hubAddr)
	defer stop()

	// First connection: nothing listens at hubAddr yet, so the dial inside
	// the forwarder fails and it must close this connection rather than
	// hang or crash the accept loop.
	conn, err := net.Dial("tcp", frontAddr)
	if err != nil {
		t.Fatalf("dial forwarder: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 1)
	if n, err := conn.Read(buf); err == nil {
		t.Fatalf("expected the connection to be closed after a failed dial, got n=%d err=%v", n, err)
	}
	conn.Close()

	// Now bring up a real listener on that exact same hub address and make
	// a second connection through the SAME forwarder/accept loop. If the
	// earlier dial failure had killed runForward's loop, this would hang or
	// fail to connect.
	hub, err := net.Listen("tcp", hubAddr)
	if err != nil {
		t.Fatalf("re-listen on %s: %v", hubAddr, err)
	}
	defer hub.Close()
	go func() {
		c, err := hub.Accept()
		if err != nil {
			return
		}
		io.Copy(c, c) //nolint:errcheck // best-effort echo for test fixture
		c.Close()
	}()

	conn2, err := net.Dial("tcp", frontAddr)
	if err != nil {
		t.Fatalf("second dial to same forwarder: %v", err)
	}
	defer conn2.Close()
	if _, err := conn2.Write([]byte("ok")); err != nil {
		t.Fatalf("write: %v", err)
	}
	conn2.SetReadDeadline(time.Now().Add(5 * time.Second))
	got := make([]byte, 2)
	if _, err := io.ReadFull(conn2, got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != "ok" {
		t.Fatalf("got %q want %q", got, "ok")
	}
}
