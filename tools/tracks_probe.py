#!/usr/bin/env python3
"""Read-only probe of a Novation Circuit Tracks over USB MIDI sysex (no extra Python packages).

  python3 tools/tracks_probe.py ping     # device type and firmware build
  python3 tools/tracks_probe.py pack     # current pack request (raw reply, not decoded)
  python3 tools/tracks_probe.py packs    # list the packs (enters Exchange Mode, ALWAYS leaves it again)
  python3 tools/tracks_probe.py --raw "F0 00 20 29 00 70 F7"   # send any sysex and print what comes back

Uses `amidi` on the raw port, so the browser (Novation Components) must not have the Tracks open.
Commands come from the unofficial Circuit Tracks sysex document and the
ZuluPro/companion repository; none of them write to the device. Exchange Mode locks the Tracks'
controls until it is left: `packs` leaves it in a finally block, and
`--raw "F0 00 20 29 01 64 03 41 F7"` leaves it by hand if something went wrong.
"""
import argparse, re, subprocess, sys

HEADER = [0xF0, 0x00, 0x20, 0x29]
TRACKS = [0x01, 0x64]  # Novation synth product, Circuit Tracks


def find_port(name="Circuit Tracks MIDI"):
    """Raw ALSA device ("hw:1,0,0") whose name matches, from `amidi -l` (same as midi_bridge.py)."""
    out = subprocess.run(["amidi", "-l"], capture_output=True, text=True).stdout
    for line in out.splitlines()[1:]:
        parts = line.split(None, 2)
        if len(parts) == 3 and parts[2].strip() == name:
            return parts[1]
    return None


def hexs(data):
    return " ".join(f"{b:02X}" for b in data)


def split_sysex(text):
    """Turn `amidi -d` output (hex bytes, line breaks anywhere) into a list of complete sysex messages."""
    msgs, buf = [], None
    for tok in text.split():
        if not re.fullmatch(r"[0-9A-Fa-f]{2}", tok):
            continue
        b = int(tok, 16)
        if b == 0xF0:
            buf = [b]
        elif buf is not None and b == 0xF7:
            buf.append(b)
            msgs.append(bytes(buf))
            buf = None
        elif buf is not None and b < 0xF8:  # F8..FF (clock, active sensing) can come in the middle
            buf.append(b)
    return msgs


class Session:
    """One `amidi` call per request: it sends the bytes, then dumps what comes back."""

    def __init__(self, port):
        self.port = port

    def close(self):
        pass

    def ask(self, data, silence=1):
        """Send `data`; return every sysex message that arrives, ending after `silence` s without data."""
        r = subprocess.run(["amidi", "-p", self.port, "-S", hexs(data), "-d", "-t", str(silence)],
                           capture_output=True, text=True, timeout=30)
        if r.returncode and "busy" in r.stderr:
            sys.exit(f"{self.port} is busy: close the browser tab using the Tracks (Novation Components) and retry")
        if r.returncode and not r.stdout:
            sys.exit(r.stderr.strip() or f"amidi failed ({r.returncode})")
        return split_sysex(r.stdout)


def firmware(reply):
    """Ping reply F0 00 20 29 00 70 00 <type> ... : type 04 = Tracks, build in two 7-bit bytes."""
    if len(reply) < 19 or reply[4:6] != bytes([0x00, 0x70]):
        return None
    kind = {3: "Circuit", 4: "Circuit Tracks"}.get(reply[7], f"unknown type {reply[7]:02X}")
    return kind, (reply[14] << 7) | reply[15]


def parse_pack(reply):
    """Pack info reply F0 00 20 29 01 64 03 0C 02 <id> <ascii name...> F7 -> (id, text) or None."""
    if len(reply) > 10 and reply[4:9] == bytes([0x01, 0x64, 0x03, 0x0C, 0x02]):
        return reply[9], bytes(reply[10:-1]).decode("ascii", errors="replace")
    return None


def main():
    p = argparse.ArgumentParser(description="Read-only Circuit Tracks sysex probe")
    p.add_argument("command", nargs="?", choices=["ping", "pack", "packs"])
    p.add_argument("--raw", help='send this sysex, e.g. "F0 00 20 29 00 70 F7"')
    p.add_argument("--port", help='raw ALSA device, default: found by name (e.g. "hw:1,0,0")')
    args = p.parse_args()
    if not args.command and not args.raw:
        p.error("give a command or --raw")

    port = args.port or find_port()
    if not port:
        sys.exit("No 'Circuit Tracks MIDI' port found (amidi -l)")
    print(f"port {port}")
    s = Session(port)
    try:
        if args.raw:
            for r in s.ask([int(x, 16) for x in args.raw.split()]):
                print(hexs(r))
        elif args.command == "ping":
            replies = s.ask(HEADER + [0x00, 0x70, 0xF7])
            for r in replies:
                fw = firmware(r)
                print(hexs(r) + (f"   -> {fw[0]}, firmware build {fw[1]}" if fw else ""))
            if not replies:
                print("no reply")
        elif args.command == "pack":
            replies = s.ask(HEADER + TRACKS + [0x49, 0xF7])
            for r in replies:
                print(hexs(r))
            if not replies:
                print("no reply")
        elif args.command == "packs":
            try:
                print("enter Exchange Mode:", [hexs(r) for r in s.ask(HEADER + TRACKS + [0x03, 0x40, 0xF7])])
                replies = s.ask(HEADER + TRACKS + [0x03, 0x0B, 0x02, 0xF7], silence=2)
            finally:
                print("leave Exchange Mode:", [hexs(r) for r in s.ask(HEADER + TRACKS + [0x03, 0x41, 0xF7])])
            for r in replies:
                pk = parse_pack(r)
                print(f"pack {pk[0]:2d}  {pk[1]!r}" if pk else hexs(r))
    finally:
        s.close()


if __name__ == "__main__":
    main()

