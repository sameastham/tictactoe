package tsbridge

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

// upTimeout bounds how long StartForward waits for the tsnet node to finish
// registering with the coordination server and come up. Real-world joins
// can be slow on a first login (interactive auth, DERP warm-up), so this is
// generous rather than tight.
const upTimeout = 120 * time.Second

// state holds the single running forwarder, guarded by mu. Only one
// StartForward can be active at a time — see the package doc on
// StartForward for the double-start guard.
var (
	mu        sync.Mutex
	srv       *tsnet.Server
	listener  net.Listener
	localPort int
	hostname  string
	lastError string
	running   bool
)

// StartForward brings up an in-process, userspace Tailscale node (tsnet)
// under stateDir, joins the tailnet as hostname using authKey (and
// controlURL, if set — non-empty supports a Headscale coordination server
// instead of the default Tailscale one), then starts a loopback TCP
// listener on 127.0.0.1 (an OS-assigned port) that forwards every
// connection to hubHostPort over the tailnet.
//
// It returns the loopback port the caller should connect to. Calling
// StartForward again while a forwarder is already running is a no-op that
// just returns the existing port — it does not start a second node or
// listener.
//
// Only primitive types cross this function's signature (ints, strings,
// error) so the gomobile-generated Java binding for it stays stable
// regardless of what changes inside this package.
func StartForward(stateDir, hostname_, authKey, controlURL, hubHostPort string) (int, error) {
	mu.Lock()
	defer mu.Unlock()

	if running {
		// Double-start guard: report the already-running port rather than
		// starting a second tsnet node (Dir is not safe to share between
		// two concurrently-running Server instances) or a second listener.
		return localPort, nil
	}

	s := &tsnet.Server{
		Dir:        stateDir,
		Hostname:   hostname_,
		AuthKey:    authKey,
		Ephemeral:  false,
		ControlURL: controlURL,
	}

	ctx, cancel := context.WithTimeout(context.Background(), upTimeout)
	defer cancel()

	if _, err := s.Up(ctx); err != nil {
		lastError = err.Error()
		s.Close()
		return 0, fmt.Errorf("tsbridge: tsnet up: %w", err)
	}

	// The loopback side is plain OS networking — deliberately net.Listen
	// from the standard library, not s.Listen, since this listener faces
	// the phone's own WebView (127.0.0.1), not the tailnet.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		lastError = err.Error()
		s.Close()
		return 0, fmt.Errorf("tsbridge: listen on loopback: %w", err)
	}

	port := ln.Addr().(*net.TCPAddr).Port

	srv = s
	listener = ln
	localPort = port
	hostname = hostname_
	lastError = ""
	running = true

	go runForward(ln, s.Dial, hubHostPort)

	return port, nil
}

// Stop tears down the running forwarder (if any): closes the loopback
// listener, which ends the accept loop started by StartForward, then closes
// the tsnet node and resets state so a later StartForward call starts
// fresh. Calling Stop when nothing is running is a harmless no-op.
func Stop() error {
	mu.Lock()
	defer mu.Unlock()

	if !running {
		return nil
	}

	var lnErr, srvErr error
	if listener != nil {
		lnErr = listener.Close()
	}
	if srv != nil {
		srvErr = srv.Close()
	}

	srv = nil
	listener = nil
	localPort = 0
	hostname = ""
	running = false

	if lnErr != nil {
		return fmt.Errorf("tsbridge: closing listener: %w", lnErr)
	}
	if srvErr != nil {
		return fmt.Errorf("tsbridge: closing tsnet server: %w", srvErr)
	}
	return nil
}

// statusJSON is the wire shape returned by Status.
type statusJSON struct {
	Running      bool     `json:"running"`
	LocalPort    int      `json:"localPort"`
	Hostname     string   `json:"hostname"`
	TailscaleIPs []string `json:"tailscaleIPs"`
	LastError    string   `json:"lastError"`
}

// Status reports the forwarder's current state as JSON:
//
//	{"running":bool,"localPort":int,"hostname":string,"tailscaleIPs":[...],"lastError":string}
//
// It never returns an error — a JSON-encoding failure of this fixed, known
// shape isn't a realistic failure mode, and a primitive string return keeps
// the gomobile binding simple (Kotlin just gets a String to parse).
func Status() string {
	mu.Lock()
	defer mu.Unlock()

	st := statusJSON{
		Running:      running,
		LocalPort:    localPort,
		Hostname:     hostname,
		TailscaleIPs: []string{},
		LastError:    lastError,
	}

	if running && srv != nil {
		ip4, ip6 := srv.TailscaleIPs()
		if ip4.IsValid() {
			st.TailscaleIPs = append(st.TailscaleIPs, ip4.String())
		}
		if ip6.IsValid() {
			st.TailscaleIPs = append(st.TailscaleIPs, ip6.String())
		}
	}

	b, err := json.Marshal(st)
	if err != nil {
		// Fixed, known-serializable shape — this should be unreachable in
		// practice. Fall back to a minimal hand-built JSON string so
		// Status's contract (always valid JSON) still holds.
		return fmt.Sprintf(`{"running":false,"localPort":0,"hostname":"","tailscaleIPs":[],"lastError":%q}`, err.Error())
	}
	return string(b)
}

