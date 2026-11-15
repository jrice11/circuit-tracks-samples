#!/bin/sh
# Tests that need no Circuit Tracks. Needs python3 and Google Chrome (google-chrome-stable or chromium).
#   1. the JavaScript protocol code is checked against the Python tool, message for message
#   2. the web page is driven in headless Chrome against a simulated Tracks
# Set CHROME to use another browser binary.
set -e
cd "$(dirname "$0")/.."
CHROME=${CHROME:-$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser || true)}
[ -n "$CHROME" ] || { echo "no Chrome or Chromium found (set CHROME=...)"; exit 1; }
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"; kill $SERVER 2>/dev/null || true' EXIT

python3 - "$PWD" <<'EOF'
import json, struct, sys
sys.path.insert(0, sys.argv[1] + "/tools")
import tracks_samples as ts

def wav(n, seed):
    pcm = bytes((i * seed + (i >> 3) * 5 + 128) & 0xFF for i in range(n))   # uses every bit pattern
    return (b"RIFF" + struct.pack("<I", 36 + n) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 48000, 96000, 2, 16)
            + b"data" + struct.pack("<I", n) + pcm)

cases = []
for label, n, pack, slot, name in (("tiny", 40, 8, 28, "28_tiny.wav"), ("three chunks", 20000, 8, 29, "29_three.wav"),
                                   ("exact chunk size", 8192 - 44, 31, 63, "63_exact.wav"), ("last slot, odd length", 8192 * 2 + 3, 0, 0, "00_odd.wav")):
    w = wav(n, 7 + n % 11)
    msgs, acks = ts.build_upload(pack, slot, w, name)
    cases.append(dict(label=label, pack=pack, slot=slot, name=name, wav=w.hex(), crc=ts.zlib.crc32(w),
                      msgs=[m.hex() for m in msgs], acks=[a.hex() for a in acks]))
koala = [(n, ts.koala_slot(n)) for n in ("A01.wav", "a1.wav", "A1_kick.wav", "B16.wav", "C02.wav", "D16.wav", "D17.wav", "E01.wav", "A00.wav", "kick.wav", "A101.wav")]
names = [(s, f, ts.default_name(s, f)) for s, f in ((0, "kick.wav"), (27, "99_my_sound.wav"), (5, "a very long sample name here.wav"),
                                                     (63, "snare (1).wav"), (12, "no_extension_but_long_long_long"))]
with open("test/data.js", "w") as f:
    f.write("const TEST_DATA = " + json.dumps(dict(uploads=cases, koala=koala, names=names)) + ";\n")
print("test data:", len(cases), "uploads,", sum(len(c["msgs"]) for c in cases), "messages")
EOF

# Each test page is loaded in headless Chrome. Only the text inside <pre id="out"> counts: the page's own source
# also contains the words ALL PASS. The app test fetches index.html, so it is served over http on localhost.
run_page() {
  OUT=$(timeout 180 "$CHROME" --headless=new --user-data-dir="$WORK/profile" --no-first-run --disable-gpu --no-sandbox \
    --virtual-time-budget=900000 --dump-dom "$2" 2>/dev/null || true)
  rm -rf "$WORK/profile"
  RESULT=$(echo "$OUT" | sed -n '/<pre id="out">/,/<\/pre>/p' | sed 's/<[^>]*>//g' | grep -E '^(ok|FAIL|ALL PASS|[0-9]+ of [0-9]+ FAILED|log was)' || true)
  echo "$RESULT" | grep -v '^ok' || true
  echo "$RESULT" | grep -q '^ALL PASS' || { echo "$1: FAILED (or the browser did not run)"; FAILED=1; return; }
  echo "$1: passed ($(echo "$RESULT" | grep -c '^ok') checks)"
}
FAILED=0
run_page "protocol code (against the python tool and a simulated Tracks)" "file://$PWD/test/test_core.html"
python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
sleep 1
run_page "web page (with a simulated Tracks)" "http://127.0.0.1:8765/test/test_app.html"
rm -f test/data.js
[ $FAILED = 0 ] || exit 1
echo "all passed"
