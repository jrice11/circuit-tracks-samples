# Circuit Tracks sample messages (as observed)

Everything here was read from a USB capture of Novation Components uploading one sample to a Circuit Tracks
(firmware build 4486), plus read-only requests sent to that same unit, plus the sources credited in the README.
**It is not an official specification.** Fields marked "unknown" were copied as seen and not understood. Other
firmware versions, and the Circuit Rhythm, may differ.

All messages start `F0 00 20 29 01 64` (Novation, synth, Circuit Tracks) and end `F7`. Below, `H` is that start and
`SEL` is `05 <pack> <slot>`: pack id 0-31, slot 0-63 (the Tracks shows slot + 1). `nib(v, 8)` is a number as eight
4-bit nibbles, most significant first. Data bytes are 7-bit packed (see the end).

## Device
| Request | Reply |
|---|---|
| `F0 00 20 29 00 70 F7` (ping) | `F0 00 20 29 00 70 00 04 ...`: byte 7 is `04` for a Tracks (`03` for a Circuit); bytes 14 and 15 are the firmware build, `b14 * 128 + b15` (`23 06` = 4486) |

## Exchange Mode
Samples can only be read or written inside Exchange Mode, which locks the Tracks' controls and shows an exchange
screen. Always leave it again.
- Enter: `H 03 40 F7`, leave: `H 03 41 F7`. Each is answered by `H 08 00 F7` and an `H 03 04 00...` message.

## Listing
- Packs: `H 03 0B 02 F7`, answered by `H 03 0B 02 <count> F7` and one `H 03 0C 02 <pack id> <ASCII name> F7` per pack.
- Sample names in a pack: `H 03 0B 05 <pack> F7`, answered by one `H 03 0C 05 <pack> <slot> <ASCII name> F7` per named slot.

## Reading a sample
Request: `H 03 01 00 00 00 00 00 00 00 00 SEL 02 F7`.
- Empty slot: `H 03 06 SEL F7`.
- Otherwise: a start message `H 03 01 00*8 SEL 01 nib(size, 8) F7`, then data messages
  `H 03 02 nib(n, 8) SEL <7-bit data> F7` for n = 1, 2, ... (8192 raw bytes each, the last one shorter), then an end
  message `H 03 03 nib(last n + 1, 8) SEL nib(crc32, 8) F7`. `size` is the length of the WAV file, `crc32` is the
  standard CRC-32 of the whole WAV file.
- The WAV is 16-bit mono 48000 Hz with a plain 44-byte header.

## Writing a sample
The host sends the same three kinds of message, and waits for an acknowledgement after each one:

| Host sends | Tracks replies |
|---|---|
| start: `H 03 01 00*8 SEL 01 nib(size, 8) F7` | `H 03 04 00*8 SEL F7` |
| data n (n = 1...): `H 03 02 nib(n, 8) SEL <7-bit data> F7` | `H 03 04 nib(n, 8) SEL F7` |
| end: `H 03 03 nib(last n + 1, 8) SEL nib(crc32, 8) F7` | `H 03 04 nib(last n + 1, 8) SEL F7` |
| name: `H 03 07 SEL <ASCII name> F7` | `H 03 04 00*8 SEL F7` |

- The name seen from Components is `<slot>_<file name>`, at most 22 characters. **The number in the name seems to decide
  which slot the sample ends up in**: sending the name `26_...` to slot 25 left the sample in slot 26.
- Before writing, Components enters Exchange Mode and sends these read-only queries, which this project repeats:
  `H 03 0B 01 F7`, `H 03 09 01 00 F7`, `H 03 09 01 01 F7`, `H 03 0B 02 F7`, `H 03 0B 05 <pack> F7`. Their meaning is
  unknown. An early attempt without them reported the slot empty straight after the upload, and later left an unexplained
  extra copy of the sample in another slot. I do not have a clean explanation for that.

## Deleting a sample
`H 03 08 SEL F7` is answered by `H 03 04 00*8 SEL F7` and the slot reads as empty afterwards. **Components was not seen
doing this.** It was found by sending candidate messages one at a time to a throwaway test sample and checking the
slot after each. Nothing else in the pack changed (compared against a backup), but treat it as lightly tested.

## 7-bit packing
Raw bytes go out in groups of 7. Each group is preceded by one byte whose bit j holds the top bit of byte j of the
group; the 7 bytes that follow have their top bit cleared. The last group may be shorter. Decoding reverses this.

## Not understood
`H 03 0A SEL F7` (sent by Components for each slot while listing) is answered with what looks like a size in nibbles.
It is not used here. The extra bytes in the `03 09` replies are unknown too.
