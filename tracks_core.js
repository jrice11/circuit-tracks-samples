// Circuit Tracks sample protocol, shared by index.html (WebMIDI on the phone) and by the PC test
// test/run.sh. It is a port of tools/tracks_samples.py, which was checked byte for byte against a USB
// capture of Novation Components uploading a sample. Nothing here touches the hardware: every function that
// talks to the Tracks takes a `port` object with
//   drain()              forget anything received so far
//   send(bytes)          send one sysex message (Uint8Array)
//   next(timeoutMs)      promise of the next received sysex message, or null after the timeout
"use strict";
(function (root) {
  const H = [0xF0, 0x00, 0x20, 0x29, 0x01, 0x64];   // sysex start, Novation, synth, Circuit Tracks
  const CHUNK = 8192;                               // raw bytes carried by one data message
  const RATE = 48000;

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // `value` as `count` 4-bit nibbles, most significant first (plain arithmetic: values can pass 31 bits).
  function nib(value, count) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(Math.floor(value / Math.pow(16, count - 1 - i)) % 16);
    return out;
  }

  function unnib(nibbles) {
    let v = 0;
    for (const n of nibbles) v = v * 16 + n;
    return v;
  }

  // 8-bit bytes -> 7-bit safe: a byte holding the top bits of the next 7 bytes (bit j = byte j), then those 7 bytes.
  function encode7(data) {
    const out = [];
    for (let i = 0; i < data.length; i += 7) {
      const n = Math.min(7, data.length - i);
      let msb = 0;
      for (let j = 0; j < n; j++) msb |= (data[i + j] >> 7) << j;
      out.push(msb);
      for (let j = 0; j < n; j++) out.push(data[i + j] & 0x7F);
    }
    return Uint8Array.from(out);
  }

  // Inverse of encode7; the last group may be short.
  function decode7(data) {
    const out = [];
    for (let i = 0; i < data.length; i += 8) {
      const msb = data[i];
      for (let j = 1; j < 8 && i + j < data.length; j++) out.push(data[i + j] | (((msb >> (j - 1)) & 1) << 7));
    }
    return Uint8Array.from(out);
  }

  function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  const bytes = (a) => Uint8Array.from(a);
  const sel = (pack, slot) => [0x05, pack, slot];
  const ZEROS8 = [0, 0, 0, 0, 0, 0, 0, 0];
  const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
  const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");

  // The messages of one upload in order (start, data chunks, end, name) and the acknowledgement expected after each.
  function buildUpload(pack, slot, wav, name) {
    const s = sel(pack, slot);
    const nameBytes = Array.from(name, (ch) => ch.charCodeAt(0) & 0x7F);
    const msgs = [bytes([...H, 0x03, 0x01, ...ZEROS8, ...s, 0x01, ...nib(wav.length, 8), 0xF7])];
    const acks = [bytes([...H, 0x03, 0x04, ...ZEROS8, ...s, 0xF7])];
    let n = 0;
    for (let off = 0; off < wav.length; off += CHUNK) {
      n++;
      msgs.push(concat(bytes([...H, 0x03, 0x02, ...nib(n, 8), ...s]), encode7(wav.subarray(off, off + CHUNK)), bytes([0xF7])));
      acks.push(bytes([...H, 0x03, 0x04, ...nib(n, 8), ...s, 0xF7]));
    }
    msgs.push(bytes([...H, 0x03, 0x03, ...nib(n + 1, 8), ...s, ...nib(crc32(wav), 8), 0xF7]));
    acks.push(bytes([...H, 0x03, 0x04, ...nib(n + 1, 8), ...s, 0xF7]));
    msgs.push(bytes([...H, 0x03, 0x07, ...s, ...nameBytes, 0xF7]));
    acks.push(bytes([...H, 0x03, 0x04, ...ZEROS8, ...s, 0xF7]));
    return { msgs, acks };
  }

  // Replies to a sample request -> WAV bytes, or null if the slot sent no sample. Throws on a bad transfer.
  function parseDownload(replies, pack, slot) {
    const chunks = new Map();
    const want = bytes(sel(pack, slot));
    let size = null, crc = null, count = null;
    for (const m of replies) {
      if (m.length < 20 || !same(m.subarray(0, 6), bytes(H)) || !same(m.subarray(16, 19), want) || m[6] !== 0x03) continue;
      if (m[7] === 0x01) size = unnib(m.subarray(20, 28));          // m[19] is a flag byte (1)
      else if (m[7] === 0x02) chunks.set(unnib(m.subarray(8, 16)), decode7(m.subarray(19, m.length - 1)));
      else if (m[7] === 0x03) { count = unnib(m.subarray(8, 16)); crc = unnib(m.subarray(19, 27)); }
    }
    if (!chunks.size) return null;
    const got = Array.from(chunks.keys()).sort((a, b) => a - b);
    if (count === null || got.length !== count - 1 || got.some((v, i) => v !== i + 1)) {
      throw new Error("incomplete transfer: got chunks " + got.join(",") + ", end says " + count);
    }
    const data = concat(...got.map((i) => chunks.get(i)));
    if (size !== null && data.length !== size) throw new Error("size mismatch: " + data.length + " received, start says " + size);
    if (crc !== null && crc32(data) !== crc) throw new Error("crc mismatch");
    return data;
  }

  // Koala pad name -> slot 0-63: bank letter A-D plus pad 1-16, so A01 -> 0 and D16 -> 63. null if it is not one.
  function koalaSlot(name) {
    const m = /^([A-Da-d])0*(\d{1,2})(?!\d)/.exec(name);
    if (!m || +m[2] < 1 || +m[2] > 16) return null;
    return (m[1].toUpperCase().charCodeAt(0) - 65) * 16 + +m[2] - 1;
  }

  // The name Components gives a sample: wire slot number, underscore, file name, at most 22 characters.
  // The number decides which slot the sample lands in, so a leading "NN_" in the file name is replaced.
  function defaultName(slot, fileName) {
    const base = fileName.split(/[\\/]/).pop().replace(/[^A-Za-z0-9_.\- ]/g, "_").replace(/^\d+_/, "");
    let name = String(slot).padStart(2, "0") + "_" + base;
    if (name.length > 22) {
      const dot = name.lastIndexOf(".");
      const ext = dot > 0 ? name.slice(dot) : "";
      const stem = dot > 0 ? name.slice(0, dot) : name;
      name = stem.slice(0, 22 - ext.length) + ext;
    }
    return name;
  }


  // File name order that treats numbers as numbers: "kick 2" comes before "kick 10".
  const byName = (a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });

  // [{slot, file}] for any file names: the first free slots (0-63) in name order. `used` lists the slots in use.
  function planFree(files, used) {
    const taken = new Set(used);
    const free = [];
    for (let s = 0; s < 64; s++) if (!taken.has(s)) free.push(s);
    if (files.length > free.length) throw new Error("only " + free.length + " free slots in this pack, and you chose " + files.length + " files");
    return files.slice().sort(byName).map((f, i) => ({ slot: free[i], file: f }));
  }

  // [{slot, file}] sorted by slot: from the Koala names, or consecutive slots from `start` (0-based) in name order.
  function planBulk(files, start) {
    const sorted = files.slice().sort(byName);
    let plan;
    if (start === null || start === undefined) {
      plan = sorted.map((f) => ({ slot: koalaSlot(f.name), file: f }));
      const bad = plan.filter((p) => p.slot === null).map((p) => p.file.name);
      if (bad.length) throw new Error("not Koala pad names (A01 .. D16): " + bad.join(", ") + ". Rename them, or use \"fill from slot\".");
    } else {
      plan = sorted.map((f, i) => ({ slot: start + i, file: f }));
    }
    const slots = plan.map((p) => p.slot);
    const dup = slots.filter((s, i) => slots.indexOf(s) !== i);
    if (dup.length) throw new Error("two files map to the same slot: " + Array.from(new Set(dup)).map((s) => s + 1).join(", "));
    if (slots.length && (Math.min(...slots) < 0 || Math.max(...slots) > 63)) throw new Error("that would go past slot 64");
    return plan.sort((a, b) => a.slot - b.slot);
  }

  // Any audio file's bytes -> a 16-bit mono 48 kHz WAV with a plain 44-byte header (needs a browser's Web Audio).
  async function toTracksWav(arrayBuffer) {
    const buf = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(arrayBuffer);   // resampled to 48 kHz
    const n = buf.length, chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const out = new Uint8Array(44 + n * 2), dv = new DataView(out.buffer);
    const tag = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
    tag(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); tag(8, "WAVE"); tag(12, "fmt ");
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, RATE, true); dv.setUint32(28, RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    tag(36, "data"); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const ch of chans) s += ch[i];
      s = Math.max(-1, Math.min(1, s / chans.length));
      dv.setInt16(44 + i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
    }
    return out;
  }

  // ---- talking to the Tracks through a `port` (see the top of this file) ----

  // Send `msg`, return every reply, ending `quiet` ms after the last one.
  async function ask(port, msg, first = 2000, quiet = 500) {
    port.drain();
    port.send(msg);
    const out = [];
    let m = await port.next(first);
    while (m) { out.push(m); m = await port.next(quiet); }
    return out;
  }

  // Exchange Mode for the length of `fn`; it is always left again, even if `fn` throws.
  async function withExchange(port, fn) {
    await ask(port, bytes([...H, 0x03, 0x40, 0xF7]));
    try {
      return await fn();
    } finally {
      await ask(port, bytes([...H, 0x03, 0x41, 0xF7]), 3000, 500);
    }
  }

  // The read-only queries Novation Components sends before a write; without them the Tracks acknowledged an
  // upload but did not keep the sample.
  async function openPack(port, pack) {
    for (const q of [[0x0B, 0x01], [0x09, 0x01, 0x00], [0x09, 0x01, 0x01], [0x0B, 0x02], [0x0B, 0x05, pack]]) {
      await ask(port, bytes([...H, 0x03, ...q, 0xF7]), 1000, 300);
    }
  }

  const text = (a) => String.fromCharCode(...a);

  // {pack id: pack name}
  async function packNames(port) {
    const packs = {};
    for (const m of await ask(port, bytes([...H, 0x03, 0x0B, 0x02, 0xF7]))) {
      if (m.length > 10 && same(m.subarray(4, 9), bytes([0x01, 0x64, 0x03, 0x0C, 0x02]))) packs[m[9]] = text(m.subarray(10, m.length - 1));
    }
    return packs;
  }

  // {wire slot: sample name} for a pack, from the Tracks' own listing.
  async function slotNames(port, pack) {
    const names = {};
    for (const m of await ask(port, bytes([...H, 0x03, 0x0B, 0x05, pack, 0xF7]))) {
      if (m.length > 11 && m[6] === 0x03 && m[7] === 0x0C && m[8] === 0x05 && m[9] === pack) names[m[10]] = text(m.subarray(11, m.length - 1));
    }
    return names;
  }

  // The sample in a slot as WAV bytes (size and CRC checked), or null if the slot is empty.
  async function fetchSample(port, pack, slot) {
    port.drain();
    port.send(bytes([...H, 0x03, 0x01, ...ZEROS8, ...sel(pack, slot), 0x02, 0xF7]));
    const first = await port.next(3000);
    if (!first) throw new Error("no reply from the Tracks");
    if (first[6] === 0x03 && first[7] === 0x06) return null;
    const msgs = [first];
    while (!(msgs[msgs.length - 1][6] === 0x03 && msgs[msgs.length - 1][7] === 0x03)) {
      const m = await port.next(3000);
      if (!m) throw new Error("the transfer stalled");
      msgs.push(m);
    }
    return parseDownload(msgs, pack, slot);
  }

  // Send each message and wait for the Tracks' matching acknowledgement before the next one.
  async function sendUpload(port, msgs, acks, progress) {
    for (let i = 0; i < msgs.length; i++) {
      port.send(msgs[i]);
      const got = await port.next(10000);          // the end message takes about half a second
      if (!same(got, acks[i])) {
        throw new Error("message " + (i + 1) + " of " + msgs.length + " was not acknowledged (got " + (got ? hex(got) : "nothing") + ")");
      }
      if (progress) progress(i + 1, msgs.length);
    }
  }

  // Erase one slot: 03 08 <05 pack slot>, found by trying candidates on a test sample.
  async function deleteSlot(port, pack, slot) {
    const ack = bytes([...H, 0x03, 0x04, ...ZEROS8, ...sel(pack, slot), 0xF7]);
    const reply = await ask(port, bytes([...H, 0x03, 0x08, ...sel(pack, slot), 0xF7]), 2000, 300);
    if (!reply.some((r) => same(r, ack))) throw new Error("delete of slot " + (slot + 1) + " was not acknowledged");
    if ((await fetchSample(port, pack, slot)) !== null) throw new Error("slot " + (slot + 1) + " still holds a sample after the delete");
  }

  // Upload jobs [{slot, wav, name}] to a pack, one at a time, each read back and compared. Stops at the first
  // failure (the ones before it stay written and verified). Refuses used slots unless `overwrite`.
  async function bulkUpload(port, pack, jobs, opts) {
    const o = Object.assign({ overwrite: false, onStep: () => {}, onProgress: null }, opts);
    return withExchange(port, async () => {
      await openPack(port, pack);
      const used = [];
      for (const j of jobs) if ((await fetchSample(port, pack, j.slot)) !== null) used.push(j.slot + 1);
      if (used.length && !o.overwrite) throw new Error("slots already in use: " + used.join(", ") + ". Nothing written.");
      for (const j of jobs) {
        const { msgs, acks } = buildUpload(pack, j.slot, j.wav, j.name);
        o.onStep(j, "sending");
        await sendUpload(port, msgs, acks, o.onProgress ? (i, n) => o.onProgress(j, i, n) : null);
        const back = await fetchSample(port, pack, j.slot);
        if (!back || !same(back, j.wav)) throw new Error("slot " + (j.slot + 1) + " was acknowledged but reads back different (" + (back ? back.length + " bytes" : "empty") + ")");
        o.onStep(j, "verified");
      }
      return jobs.length;
    });
  }

  root.TracksCore = {
    H, CHUNK, RATE, crc32, nib, unnib, encode7, decode7, concat, bytes, sel, same, hex,
    buildUpload, parseDownload, koalaSlot, defaultName, planFree, planBulk, toTracksWav,
    ask, withExchange, openPack, packNames, slotNames, fetchSample, sendUpload, deleteSlot, bulkUpload,
  };
})(typeof window !== "undefined" ? window : globalThis);

