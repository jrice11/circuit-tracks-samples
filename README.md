# Circuit Tracks samples

Upload, list and delete samples on a **Novation Circuit Tracks** from a web page (Chrome on Android, or a computer), without
Novation Components. There are also command-line tools for Linux that can **back up every sample** first.

> **Unofficial.** This project is not made, endorsed or supported by Novation or Focusrite. "Novation", "Circuit" and
> "Circuit Tracks" belong to their owners and are used here only to say what the software works with. The messages it
> sends were worked out by observation, not from a specification. **A bug or a bad assumption could overwrite or delete
> samples on your device. Back up first and use it at your own risk.** See "How much has it been tested" below.
>
> The code was written with an AI coding assistant (Cline) working from captures and tests on the author's own Tracks, and
> reviewed and run by the author. Read it before you trust it.

## Use it

**Page:** once GitHub Pages is switched on for this repository it is served at
`https://jrice11.github.io/circuit-tracks-samples/`. Everything runs in your browser; the page makes no
network requests of its own, and your audio never leaves your device.

1. Use **Chrome** (or a Chromium browser). WebMIDI with sysex is needed: iPhone and iPad browsers do not have it, Firefox
   does not allow it by default.
2. Connect the Tracks by USB (on a phone, a data cable, with the phone acting as USB host) and close Novation Components.
3. **Connect**, allow MIDI and sysex when Chrome asks (and the USB permission box on Android, if it appears).
4. Pick a pack, choose your audio files, press **Check the plan**. It shows which slot each file will go to and what the
   Tracks will call it, and sends nothing. Then **Upload**.

Any audio the browser can decode works (wav, flac, mp3, ogg...). Each file is converted in the browser to what the Tracks
stores: **16-bit, mono, 48 kHz** (stereo is averaged to mono). Slots are numbered 1-64 as the Tracks shows them.

Slot choice, three ways:
- **Any file names** (default): the first free slots, in file name order (`snare 2` before `snare 10`).
- **Koala names**: `A01`..`D16` map to slots 1..64. **This mapping is an assumption**, made from one Koala export named
  `A01.wav`; check the plan table.
- **Fill from slot N.**

Safety built in: nothing is sent while you plan; a slot that already holds a sample is refused unless you tick "Replace"
(and confirm); each sample is **read back from the Tracks and compared** with what was sent, and the upload stops at the
first problem; Exchange Mode (which locks the Tracks' controls) is always left again, also after errors.

`diagnose.html` is a read-only page that connects, pings and lists packs. Use it first if Connect fails, and paste its log
into an issue.

## Command-line tools (Linux, needs `amidi` and `ffmpeg`)
```
python3 tools/tracks_samples.py backup  ~/tracks-backup        # every sample of every pack (read-only)
python3 tools/tracks_samples.py list    8                      # samples in pack 8
python3 tools/tracks_samples.py upload  8 30 kick.wav          # slot 30 of pack 8 (refuses a used slot)
python3 tools/tracks_samples.py bulk    8 ~/exports            # a folder, Koala names or --start N
python3 tools/tracks_samples.py delete  8 30 --yes
python3 tools/tracks_probe.py ping                             # read-only checks
```
`backup` saves **samples only**: not projects, patches, sequences or settings. Close Novation Components first, it holds the port.

## How much has it been tested

Be realistic about this before trusting it with samples you care about.
- Worked out on **one Circuit Tracks, firmware build 4486**. Other firmware, and the Circuit Rhythm, may differ.
- The upload messages were checked **byte for byte against a USB capture of Novation Components** uploading one sample, and the
  Python and JavaScript versions are checked against each other. Samples read back from the Tracks matched what was sent.
- The web page was developed against a **simulated Tracks** (`test/fake_tracks.js`), and the author has used it on one Android
  phone to upload a sample. It has **not** had wide testing: no other phones, Android versions or Tracks units.
- **Delete is not something Components was seen doing.** It was found by sending candidate messages to a throwaway sample.
  Nothing else in the pack changed (compared with a backup), but treat it as lightly tested.
- An early upload attempt left an **unexplained extra copy** of a sample in another slot. The cause was probably the name's
  slot number (see `docs/PROTOCOL.md`) combined with skipping some read-only queries, but that is not proven.
- The 196.6 s total sample time (firmware 1.1.5 and later, per Novation) is **not enforced** by the tools. The page only
  shows the length of what you are about to upload.

## Tests
`sh test/run.sh` (needs `python3` and Chrome or Chromium; set `CHROME=` for another binary). No Tracks is needed. It checks the
JavaScript against the Python tool and drives the page against the simulation, including failures such as a missing
acknowledgement, a corrupted read-back and a used slot.

## Credits and sources
- **The unofficial "Novation Circuit Tracks Sysex Commands" document**, a Google Doc by the author of a Novation Circuit patch
  editor for iPad (I did not find the author's name in the text I read; if you know it, please open an issue):
  <https://docs.google.com/document/d/1ekuIs-Vub3A7DnI7_xbXZs5n1kRAq2p6dVpjxEcmPFU/mobilebasic>. It gave the Exchange
  Mode commands, the pack listing, the ping and the sysex header. It said sample upload was still unknown.
- **[ZuluPro/companion](https://github.com/ZuluPro/companion)** by Anthony Monthe (BSD-style licence), a Python tool that
  downloads samples from a Circuit **Rhythm**. Reading it showed the sample download request and the 7-bit packing. The code
  here was written separately, but that work is what made the rest possible. Thank you.
- **Novation Components** was observed over USB while it uploaded one sample, on the author's own device. That is where
  the upload messages came from. Novation's own Programmer's Reference documents the Circuit's MIDI but not these messages.
- Sample time figures: Novation, "Increased Sample Time for Circuit Tracks".

If you are the author of one of these and would like the credit changed, please open an issue.

## Help wanted
Reports from other firmware versions and devices, a Circuit Rhythm check, what the `03 09` and `03 0A` messages mean, and
what Components does about the total sample time. See `docs/PROTOCOL.md` for what is known.

## Licence
MIT, see `LICENSE`.

