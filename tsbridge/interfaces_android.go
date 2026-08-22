//go:build android && cgo

package tsbridge

/*
#include <ifaddrs.h>
#include <net/if.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <stdlib.h>
*/
import "C"

import (
	"fmt"
	"net"
	"unsafe"

	"tailscale.com/net/netmon"
)

// init registers our getifaddrs(3)-backed interface getter with
// tailscale.com/net/netmon as soon as this package is linked into an
// android build.
//
// Why this is needed: net.Interfaces() in the Go standard library reads the
// interface list over an AF_NETLINK/NETLINK_ROUTE socket. Android 11+
// forbids untrusted_app-domain processes (i.e. every normal app, including
// this one) from opening NETLINK_ROUTE sockets under SELinux, so
// net.Interfaces() — and therefore netmon's default netInterfaces(), see
// tailscale.com/net/netmon/state.go's netInterfaces()/altNetInterfaces —
// fails on-device even though it can work fine on a Linux desktop or in the
// Android emulator. netmon already anticipates this with the
// RegisterInterfaceGetter hook (net/netmon/state.go): register an
// alternate implementation and it's used instead of net.Interfaces().
//
// getifaddrs(3) is a plain libc call, not a netlink socket, and is
// permitted for regular apps, so it's used here instead.
//
// (Historically, gomobile-era Tailscale Android registered this same hook
// under the older package name net/interfaces; the package was later
// renamed to net/netmon, carrying the hook — now
// netmon.RegisterInterfaceGetter — along with it. That's the exact function
// this file calls.)
func init() {
	netmon.RegisterInterfaceGetter(getInterfacesViaGetifaddrs)
}

// getInterfacesViaGetifaddrs implements netmon's interface-getter contract
// (func() ([]netmon.Interface, error)) using getifaddrs(3)/freeifaddrs(3)
// via cgo.
func getInterfacesViaGetifaddrs() ([]netmon.Interface, error) {
	var ifap *C.struct_ifaddrs
	if rc, errno := C.getifaddrs(&ifap); rc != 0 {
		return nil, fmt.Errorf("tsbridge: getifaddrs: %w", errno)
	}
	defer C.freeifaddrs(ifap)

	// getifaddrs emits one *entry* per address (so a single interface with
	// an IPv4 and an IPv6 address appears twice); coalesce by name into one
	// net.Interface with multiple AltAddrs, preserving first-seen order.
	var order []string
	byName := map[string]*net.Interface{}
	addrsByName := map[string][]net.Addr{}

	for cur := ifap; cur != nil; cur = cur.ifa_next {
		if cur.ifa_name == nil {
			continue
		}
		name := C.GoString(cur.ifa_name)

		iface, ok := byName[name]
		if !ok {
			iface = &net.Interface{
				Index: int(C.if_nametoindex(cur.ifa_name)),
				// getifaddrs doesn't report MTU (that needs a separate
				// SIOCGIFMTU ioctl); 0 is the documented "unknown" value
				// and netmon only ever compares MTU for change-detection
				// equality (net/netmon/state.go), never dereferences it, so
				// leaving it unknown is safe.
				MTU:   0,
				Name:  name,
				Flags: flagsFromIfaFlags(uint32(cur.ifa_flags)),
			}
			byName[name] = iface
			order = append(order, name)
		}

		if cur.ifa_addr == nil {
			continue
		}
		switch (*C.struct_sockaddr)(unsafe.Pointer(cur.ifa_addr)).sa_family {
		case C.AF_INET:
			sa := (*C.struct_sockaddr_in)(unsafe.Pointer(cur.ifa_addr))
			ip := make(net.IP, 4)
			copy(ip, (*[4]byte)(unsafe.Pointer(&sa.sin_addr))[:])

			mask := make(net.IPMask, 4)
			if cur.ifa_netmask != nil {
				msa := (*C.struct_sockaddr_in)(unsafe.Pointer(cur.ifa_netmask))
				copy(mask, (*[4]byte)(unsafe.Pointer(&msa.sin_addr))[:])
			} else {
				copy(mask, net.CIDRMask(32, 32))
			}
			addrsByName[name] = append(addrsByName[name], &net.IPNet{IP: ip, Mask: mask})

		case C.AF_INET6:
			sa := (*C.struct_sockaddr_in6)(unsafe.Pointer(cur.ifa_addr))
			ip := make(net.IP, 16)
			copy(ip, (*[16]byte)(unsafe.Pointer(&sa.sin6_addr))[:])

			mask := make(net.IPMask, 16)
			if cur.ifa_netmask != nil {
				msa := (*C.struct_sockaddr_in6)(unsafe.Pointer(cur.ifa_netmask))
				copy(mask, (*[16]byte)(unsafe.Pointer(&msa.sin6_addr))[:])
			} else {
				copy(mask, net.CIDRMask(128, 128))
			}
			addrsByName[name] = append(addrsByName[name], &net.IPNet{IP: ip, Mask: mask})
		}
	}

	result := make([]netmon.Interface, 0, len(order))
	for _, name := range order {
		result = append(result, netmon.Interface{
			Interface: byName[name],
			AltAddrs:  addrsByName[name],
		})
	}
	return result, nil
}

// flagsFromIfaFlags converts the IFF_* bitmask reported by getifaddrs (via
// ifa_flags, from <net/if.h>) into the standard library's net.Flags.
func flagsFromIfaFlags(f uint32) net.Flags {
	var flags net.Flags
	if f&C.IFF_UP != 0 {
		flags |= net.FlagUp
	}
	if f&C.IFF_BROADCAST != 0 {
		flags |= net.FlagBroadcast
	}
	if f&C.IFF_LOOPBACK != 0 {
		flags |= net.FlagLoopback
	}
	if f&C.IFF_POINTOPOINT != 0 {
		flags |= net.FlagPointToPoint
	}
	if f&C.IFF_MULTICAST != 0 {
		flags |= net.FlagMulticast
	}
	if f&C.IFF_RUNNING != 0 {
		flags |= net.FlagRunning
	}
	return flags
}
