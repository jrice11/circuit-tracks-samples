#!/usr/bin/env python3
"""Download and upload samples on a Novation Circuit Tracks over USB MIDI sysex.

  python3 tools/tracks_samples.py download PACK SLOT out.wav
  python3 tools/tracks_samples.py upload PACK SLOT in.wav [--name NAME] [--dry-run] [--overwrite]
  python3 tools/tracks_samples.py status PACK SLOT      # is the slot empty or used?
  python3 tools/tracks_samples.py list PACK             # every sample in a pack
  python3 tools/tracks_samples.py backup DIR            # every sample of every pack, read-only

PACK is the pack id from `tracks_probe.py packs` (0-31), SLOT the sample slot 1-64 exactly as the
Tracks shows it (the sysex messages and the names Components gives, such as 24_name.wav, count from 0).
`backup` saves samples only, not projects, patches or sequences. The upload converts any audio file with ffmpeg to what the Tracks stores
(16-bit, mono, 48000 Hz, plain 44-byte WAV header), refuses a used slot unless --overwrite, and
reads the sample back afterwards to compare it with what was sent.

The protocol was read from a USB capture of Novation Components uploading one sample, and from the
unofficial sysex notes and ZuluPro/companion (see tools/tracks_probe.py). Exchange Mode is always
left again, even after an error. Close any Novation Components tab first: it holds the port.
"""
import argparse, os, re, select, struct, subprocess, sys, time, zlib

import tracks_probe as tp

H = tp.HEADER + tp.TRACKS      # F0 00 20 29 01 64
CHUNK = 8192                   # raw bytes carried by one data message (9363 sysex bytes)
RATE = 48000


def nib(value, count):
    """`value` as `count` 4-bit nibbles, most significant first (the Tracks sends numbers like this)."""
    return [(value >> (4 * (count - 1 - i))) & 0x0F for i in range(count)]


def unnib(nibbles):
    v = 0
    for n in nibbles:
        v = (v << 4) | n
    return v


def encode7(data):
    """8-bit bytes -> 7-bit safe: a byte holding the top bits of the next 7 bytes (bit j = byte j), then those 7 bytes."""
    out = bytearray()
    for i in range(0, len(data), 7):
        g = data[i:i + 7]
        msb = 0
        for j, b in enumerate(g):
            msb |= (b >> 7) << j
        out.append(msb)
        out.extend(b & 0x7F for b in g)
    return bytes(out)


def decode7(data):
    """Inverse of encode7; the last group may be short."""
    out = bytearray()
    for i in range(0, len(data), 8):
        g = data[i:i + 8]
        for j, b in enumerate(g[1:]):
            out.append(b | (((g[0] >> j) & 1) << 7))
    return bytes(out)


def to_tracks_wav(path):
    """Any audio file -> bytes of a 16-bit mono 48 kHz WAV with a plain 44-byte header."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(RATE),
                        "-f", "s16le", "-"], capture_output=True)
    if r.returncode or not r.stdout:
        sys.exit(f"ffmpeg could not read {path}: {r.stderr.decode(errors='replace').strip()}")
    pcm = r.stdout
    return (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " +
            struct.pack("<IHHIIHH", 16, 1, 1, RATE, RATE * 2, 2, 16) + b"data" +
            struct.pack("<I", len(pcm)) + pcm)


def sel(pack, slot):
    return [0x05, pack, slot]


def build_upload(pack, slot, wav, name):
    """The messages of one upload in order: start, data chunks, end, name (Exchange Mode not included).

    Returns (messages, acks): acks[i] is the reply the Tracks sends after messages[i]."""
    s = sel(pack, slot)
    msgs = [bytes(H + [0x03, 0x01] + [0] * 8 + s + [0x01] + nib(len(wav), 8) + [0xF7])]
    acks = [bytes(H + [0x03, 0x04] + [0] * 8 + s + [0xF7])]
    n = 0
    for off in range(0, len(wav), CHUNK):
        n += 1
        msgs.append(bytes(H + [0x03, 0x02] + nib(n, 8) + s + list(encode7(wav[off:off + CHUNK])) + [0xF7]))
        acks.append(bytes(H + [0x03, 0x04] + nib(n, 8) + s + [0xF7]))
    msgs.append(bytes(H + [0x03, 0x03] + nib(n + 1, 8) + s + nib(zlib.crc32(wav), 8) + [0xF7]))
    acks.append(bytes(H + [0x03, 0x04] + nib(n + 1, 8) + s + [0xF7]))
    msgs.append(bytes(H + [0x03, 0x07] + s + list(name.encode("ascii")) + [0xF7]))
    acks.append(bytes(H + [0x03, 0x04] + [0] * 8 + s + [0xF7]))
    return msgs, acks


def parse_download(replies, pack, slot):
    """Replies to a sample request -> WAV bytes, or None if the slot sent no sample. Raises on a bad transfer."""
    s = bytes(sel(pack, slot))
    chunks, size, crc, count = {}, None, None, None
    for m in replies:
        if m[:6] != bytes(H) or m[16:19] != s:
            continue
        kind = m[7]
        if m[6] == 0x03 and kind == 0x01:
            size = unnib(m[20:28])  # m[19] is a flag byte (1)
        elif m[6] == 0x03 and kind == 0x02:
            chunks[unnib(m[8:16])] = decode7(m[19:-1])
        elif m[6] == 0x03 and kind == 0x03:
            count, crc = unnib(m[8:16]), unnib(m[19:27])
    if not chunks:
        return None
    if count is None or sorted(chunks) != list(range(1, count)):
        raise RuntimeError(f"incomplete transfer: got chunks {sorted(chunks)}, end says {count}")
    data = b"".join(chunks[i] for i in range(1, count))
    if size is not None and len(data) != size:
        raise RuntimeError(f"size mismatch: {len(data)} bytes received, start message says {size}")
    if crc is not None and zlib.crc32(data) != crc:
        raise RuntimeError(f"crc mismatch: {zlib.crc32(data):08X} computed, {crc:08X} sent")
    return data


def raw_path(hw):
    """"hw:1,0,0" (amidi name) -> "/dev/snd/midiC1D0"."""
    m = re.fullmatch(r"hw:(\d+),(\d+)(?:,\d+)?", hw)
    if not m:
        sys.exit(f"cannot read the port name {hw!r}")
    return f"/dev/snd/midiC{m.group(1)}D{m.group(2)}"


class RawPort:
    """The Tracks' raw MIDI device: whole sysex messages in and out, realtime bytes (clock) dropped."""

    def __init__(self, hw):
        path = raw_path(hw)
        try:
            self.fd = os.open(path, os.O_RDWR)
        except OSError as e:
            sys.exit(f"cannot open {path}: {e.strerror}. Close any Novation Components tab and retry.")
        self.buf, self.pending = None, []

    def close(self):
        os.close(self.fd)

    def _pump(self, timeout):
        if not select.select([self.fd], [], [], timeout)[0]:
            return False
        for b in os.read(self.fd, 4096):
            if b >= 0xF8:
                continue
            if b == 0xF0:
                self.buf = bytearray([b])
            elif self.buf is not None:
                self.buf.append(b)
                if b == 0xF7:
                    self.pending.append(bytes(self.buf))
                    self.buf = None
        return True

    def next(self, timeout):
        """Next sysex message, or None after `timeout` seconds."""
        end = time.time() + timeout
        while not self.pending:
            left = end - time.time()
            if left <= 0:
                return None
            self._pump(left)
        return self.pending.pop(0)

    def drain(self):
        while self._pump(0):
            pass
        self.pending.clear()
        self.buf = None

    def send(self, msg):
        view = memoryview(msg)
        while len(view):
            view = view[os.write(self.fd, view):]

    def ask(self, msg, first=2.0, quiet=0.5):
        """Send `msg`; return every reply, ending `quiet` s after the last one."""
        self.drain()
        self.send(msg)
        out, m = [], self.next(first)
        while m is not None:
            out.append(m)
            m = self.next(quiet)
        return out


class Exchange:
    """Exchange Mode for the length of a with-block; it is always left again."""

    def __init__(self, port):
        self.port = port

    def __enter__(self):
        self.port.ask(bytes(H + [0x03, 0x40, 0xF7]))
        return self.port

    def __exit__(self, *exc):
        self.port.ask(bytes(H + [0x03, 0x41, 0xF7]), first=3.0)


def fetch(port, pack, slot):
    """The sample in a slot as WAV bytes (size and CRC checked), or None if the slot is empty."""
    port.drain()
    port.send(bytes(H + [0x03, 0x01] + [0] * 8 + sel(pack, slot) + [0x02, 0xF7]))
    first = port.next(3.0)
    if first is None:
        raise RuntimeError("no reply from the Tracks")
    if first[6:8] == bytes([0x03, 0x06]):
        return None
    msgs = [first]
    while msgs[-1][6:8] != bytes([0x03, 0x03]):
        m = port.next(3.0)
        if m is None:
            raise RuntimeError("the transfer stalled")
        msgs.append(m)
    return parse_download(msgs, pack, slot)



def open_pack(port, pack):
    """The read-only queries Novation Components sends after entering Exchange Mode and before a write.

    Without them the Tracks acknowledged an upload but did not keep the sample (seen on the board)."""
    for q in ([0x0B, 0x01], [0x09, 0x01, 0x00], [0x09, 0x01, 0x01], [0x0B, 0x02], [0x0B, 0x05, pack]):
        port.ask(bytes(H + [0x03] + q + [0xF7]), first=1.0, quiet=0.3)


def send_upload(port, msgs, acks, progress=None):
    """Send each message and wait for the Tracks' matching acknowledgement before the next one."""
    for i, (msg, ack) in enumerate(zip(msgs, acks)):
        port.send(msg)
        got = port.next(10.0)  # the end message takes about half a second
        if got != ack:
            raise RuntimeError(f"message {i + 1} of {len(msgs)} was not acknowledged "
                               f"(got {tp.hexs(got) if got else 'nothing'})")
        if progress:
            progress(i + 1, len(msgs))


def default_name(slot, path):
    """The name Components gives a sample: wire slot number, underscore, file name; kept to 22 characters.

    The number matters: it appeared to decide which slot the sample ends up in (a name starting 26_ sent to
    slot 25 left the sample in slot 26), so a name given with --name has any leading "NN_" replaced."""
    base = re.sub(r"[^A-Za-z0-9_.\- ]", "_", os.path.basename(path))
    base = re.sub(r"^\d+_", "", base)
    name = f"{slot:02d}_{base}"
    if len(name) > 22:
        stem, ext = os.path.splitext(name)
        name = stem[:22 - len(ext)] + ext
    return name


def slot_names(port, pack):
    """{wire slot: sample name} for a pack, from the Tracks' own listing."""
    names = {}
    for m in port.ask(bytes(H + [0x03, 0x0B, 0x05, pack, 0xF7]), first=2.0, quiet=0.5):
        if len(m) > 11 and m[6:9] == bytes([0x03, 0x0C, 0x05]) and m[9] == pack:
            names[m[10]] = bytes(m[11:-1]).decode("ascii", errors="replace")
    return names


def pack_names(port):
    """{pack id: pack name} for every pack on the Tracks."""
    packs = {}
    for m in port.ask(bytes(H + [0x03, 0x0B, 0x02, 0xF7]), first=2.0, quiet=0.5):
        pk = tp.parse_pack(m)
        if pk:
            packs[pk[0]] = pk[1]
    return packs


def safe(text):
    return re.sub(r"[^A-Za-z0-9_.\- ]", "_", text).strip() or "_"


def cmd_list(args, port):
    with Exchange(port) as p:
        open_pack(p, args.pack)
        names = slot_names(p, args.pack)
        for s in range(64):
            d = fetch(p, args.pack, s)
            if d is not None:
                print(f"slot {s + 1:2d} (wire {s:2d})  {len(d):8d} bytes  {(len(d) - 44) / 2 / RATE:6.2f} s  "
                      f"crc {zlib.crc32(d):08X}  {names.get(s, '')}")


def cmd_backup(args, port):
    """Read-only: every sample of every pack to DIR/packNN_name/slotNN_name.wav, plus manifest.txt."""
    os.makedirs(args.directory, exist_ok=True)
    count = 0
    with Exchange(port) as p, open(os.path.join(args.directory, "manifest.txt"), "w") as manifest:
        for pack, pname in sorted(pack_names(p).items()):
            names = slot_names(p, pack)
            folder = os.path.join(args.directory, f"pack{pack:02d}_{safe(pname)}")
            os.makedirs(folder, exist_ok=True)
            n = 0
            for s in range(64):
                d = fetch(p, pack, s)
                if d is None:
                    continue
                fname = f"slot{s:02d}_{safe(names.get(s, ''))}"
                if not fname.lower().endswith(".wav"):
                    fname += ".wav"
                with open(os.path.join(folder, fname), "wb") as f:
                    f.write(d)
                manifest.write(f"{pack}\t{s}\t{names.get(s, '')}\t{len(d)}\t{zlib.crc32(d):08X}\t{pname}\n")
                manifest.flush()
                n += 1
            count += n
            print(f"pack {pack:2d} {pname!r}: {n} samples", flush=True)
    print(f"backed up {count} samples to {args.directory}")


def cmd_download(args, port):
    with Exchange(port) as p:
        data = fetch(p, args.pack, args.slot)
    if data is None:
        sys.exit(f"pack {args.pack} slot {args.slot} is empty")
    with open(args.file, "wb") as f:
        f.write(data)
    print(f"saved {len(data)} bytes to {args.file}")


def cmd_status(args, port):
    with Exchange(port) as p:
        data = fetch(p, args.pack, args.slot)
    print("empty" if data is None else f"used: {len(data)} bytes, "
          f"{(len(data) - 44) / 2 / RATE:.2f} s, crc {zlib.crc32(data):08X}")


def cmd_upload(args, port):
    wav = to_tracks_wav(args.file)
    name = default_name(args.slot, args.name or args.file)
    msgs, acks = build_upload(args.pack, args.slot, wav, name)
    print(f"{args.file} -> pack {args.pack} slot {args.slot + 1} (wire {args.slot}) as {name!r}: {len(wav)} bytes, "
          f"{(len(wav) - 44) / 2 / RATE:.2f} s, {len(msgs)} messages, crc {zlib.crc32(wav):08X}")
    if args.dry_run:
        print("dry run: nothing sent")
        return
    with Exchange(port) as p:
        open_pack(p, args.pack)
        old = fetch(p, args.pack, args.slot)
        if old is not None and not args.overwrite:
            sys.exit(f"pack {args.pack} slot {args.slot} already holds a sample ({len(old)} bytes); "
                     "nothing written. Use --overwrite to replace it.")
        send_upload(p, msgs, acks, lambda i, n: print(f"\r  sent {i}/{n}", end="", flush=True))
        print()
        back = fetch(p, args.pack, args.slot)
    if back == wav:
        print("done: read back from the Tracks and identical to what was sent")
    else:
        sys.exit("WARNING: the sample read back from the Tracks differs from what was sent "
                 f"({'empty slot' if back is None else str(len(back)) + ' bytes'})")


def delete_slot(port, pack, slot):
    """Clear one sample slot. Found by trying candidates on a test sample: 03 08 <05 pack slot>."""
    reply = port.ask(bytes(H + [0x03, 0x08] + sel(pack, slot) + [0xF7]), first=2.0, quiet=0.3)
    if bytes(H + [0x03, 0x04] + [0] * 8 + sel(pack, slot) + [0xF7]) not in reply:
        raise RuntimeError(f"delete of slot {slot + 1} was not acknowledged")
    if fetch(port, pack, slot) is not None:
        raise RuntimeError(f"slot {slot + 1} still holds a sample after the delete")


def cmd_delete(args, port):
    if not args.yes:
        sys.exit("this erases the sample for good (back up first with `backup`): add --yes to go ahead")
    with Exchange(port) as p:
        open_pack(p, args.pack)
        if fetch(p, args.pack, args.slot) is None:
            sys.exit(f"pack {args.pack} slot {args.slot + 1} is already empty")
        delete_slot(p, args.pack, args.slot)
    print(f"pack {args.pack} slot {args.slot + 1} cleared")


def koala_slot(path):
    """Slot (0-63) from a Koala export name: bank letter A-D plus pad 1-16, so A01 -> 0 and D16 -> 63."""
    m = re.match(r"([A-Da-d])0*(\d{1,2})(?!\d)", os.path.basename(path))
    if not m or not 1 <= int(m.group(2)) <= 16:
        return None
    return (ord(m.group(1).upper()) - 65) * 16 + int(m.group(2)) - 1


def plan_bulk(files, start):
    """[(slot, file)] from the Koala names, or consecutive slots from `start` (0-based) in name order."""
    if start is None:
        plan = [(koala_slot(f), f) for f in files]
        bad = [f for s, f in plan if s is None]
        if bad:
            sys.exit("these names are not Koala pad names (A01 .. D16): " + ", ".join(map(os.path.basename, bad)) +
                     "\nrename them, or give --start N to fill consecutive slots in name order")
    else:
        plan = [(start + i, f) for i, f in enumerate(files)]
    slots = [s for s, _ in plan]
    if len(set(slots)) != len(slots):
        sys.exit("two files map to the same slot: " + ", ".join(f"{s + 1}" for s in sorted(set(x for x in slots if slots.count(x) > 1))))
    if slots and (min(slots) < 0 or max(slots) > 63):
        sys.exit("that would go past slot 64")
    return sorted(plan)


def cmd_bulk(args, port):
    exts = (".wav", ".flac", ".aif", ".aiff", ".mp3", ".ogg")
    files = sorted(os.path.join(args.folder, f) for f in os.listdir(args.folder) if f.lower().endswith(exts))
    if not files:
        sys.exit(f"no audio files in {args.folder}")
    plan = plan_bulk(files, None if args.start is None else args.start - 1)
    jobs = []
    for slot, f in plan:
        wav = to_tracks_wav(f)
        name = default_name(slot, f)
        jobs.append((slot, f, wav, name, build_upload(args.pack, slot, wav, name)))
    total = sum((len(w) - 44) / 2 / RATE for _, _, w, _, _ in jobs)
    print(f"pack {args.pack}: {len(jobs)} samples, {total:.1f} s in all")
    for slot, f, wav, name, _ in jobs:
        print(f"  slot {slot + 1:2d}  {name:24s} {(len(wav) - 44) / 2 / RATE:6.2f} s  <- {os.path.basename(f)}")
    if args.dry_run:
        print("dry run: nothing sent")
        return
    with Exchange(port) as p:
        open_pack(p, args.pack)
        used = [slot + 1 for slot, *_ in jobs if fetch(p, args.pack, slot) is not None]
        if used and not args.overwrite:
            sys.exit(f"slots already in use: {used}. Nothing written. Use --overwrite to replace them.")
        failed = []
        for slot, f, wav, name, (msgs, acks) in jobs:
            try:
                send_upload(p, msgs, acks)
                ok = fetch(p, args.pack, slot) == wav
            except RuntimeError as e:
                ok = False
                print(f"  slot {slot + 1}: {e}")
            print(f"  slot {slot + 1:2d} {name}: {'ok, read back identical' if ok else 'FAILED'}", flush=True)
            if not ok:
                failed.append(slot + 1)
                break
    if failed:
        sys.exit(f"stopped at slot {failed[0]}; the slots before it were written and verified")
    print("all done")


def main():
    p = argparse.ArgumentParser(description="Download / upload samples on a Circuit Tracks")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, fn in (("download", cmd_download), ("status", cmd_status), ("upload", cmd_upload)):
        s = sub.add_parser(name)
        s.add_argument("pack", type=int, help="pack id, 0-31")
        s.add_argument("slot", type=int, help="sample slot 1-64, as the Tracks shows it")
        if name != "status":
            s.add_argument("file", help="WAV file to write" if name == "download" else "audio file to send")
        if name == "upload":
            s.add_argument("--name", help="sample name shown on the Tracks")
            s.add_argument("--dry-run", action="store_true", help="convert and build the messages, send nothing")
            s.add_argument("--overwrite", action="store_true", help="replace a slot that already holds a sample")
        s.set_defaults(fn=fn)
    s = sub.add_parser("delete", help="erase one sample slot (needs --yes)")
    s.add_argument("pack", type=int, help="pack id, 0-31")
    s.add_argument("slot", type=int, help="sample slot 1-64, as the Tracks shows it")
    s.add_argument("--yes", action="store_true", help="really erase it")
    s.set_defaults(fn=cmd_delete)
    s = sub.add_parser("bulk", help="upload a folder of audio files; Koala names A01..D16 pick the slots")
    s.add_argument("pack", type=int, help="pack id, 0-31")
    s.add_argument("folder", help="folder of exported samples")
    s.add_argument("--start", type=int, help="ignore the names: fill consecutive slots from N (1-64) in name order")
    s.add_argument("--dry-run", action="store_true", help="show the plan, send nothing")
    s.add_argument("--overwrite", action="store_true", help="replace slots that already hold a sample")
    s.set_defaults(fn=cmd_bulk)
    s = sub.add_parser("list", help="list the samples in a pack (read-only)")
    s.add_argument("pack", type=int, help="pack id, 0-31")
    s.set_defaults(fn=cmd_list)
    s = sub.add_parser("backup", help="save every sample of every pack to a folder (read-only)")
    s.add_argument("directory", help="folder to create or fill")
    s.set_defaults(fn=cmd_backup)
    args = p.parse_args()
    if hasattr(args, "pack") and not 0 <= args.pack <= 31:
        p.error("pack must be 0-31")
    if hasattr(args, "slot"):
        if not 1 <= args.slot <= 64:
            p.error("slot must be 1-64, as the Tracks shows it")
        args.slot -= 1  # from here on `slot` is the number on the wire (0-63)
    if args.cmd in ("upload", "bulk") and args.dry_run:
        args.fn(args, None)
        return
    hw = tp.find_port()
    if not hw:
        sys.exit("No 'Circuit Tracks MIDI' port found (amidi -l)")
    port = RawPort(hw)
    try:
        args.fn(args, port)
    finally:
        port.close()


if __name__ == "__main__":
    main()

