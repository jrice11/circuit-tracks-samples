// A simulated Circuit Tracks for test/test_core.html: it answers the same sysex messages as the real one
// (as seen in a capture of Novation Components and in the sample downloads), instantly, so the upload, read-back,
// delete and failure handling in tracks_core.js can be tested without the hardware. It is a port object for
// TracksCore (drain / send / next) plus switches to make it misbehave.
"use strict";
class FakeTracks {
  constructor() {
    this.slots = new Map();          // "pack:slot" -> wav bytes
    this.names = new Map();
    this.inExchange = false;
    this.exchangeLeft = 0;           // how many times Exchange Mode was left
    this.queue = [];
    this.staged = null;
    this.log = [];
    this.dropAckAt = null;           // send no acknowledgement for the Nth upload message
    this.corruptStore = false;       // keep different bytes than were sent
    this.uploadMsgs = 0;
  }

  drain() { this.queue = []; }

  async next() { await null; return this.queue.length ? this.queue.shift() : null; }

  reply(...parts) { this.queue.push(TracksCore.bytes([0xF0, 0x00, 0x20, 0x29, 0x01, 0x64, ...parts.flat(), 0xF7])); }

  ack(n, s) { this.reply([0x03, 0x04, ...TracksCore.nib(n, 8), ...s]); }

  send(m) {
    const T = TracksCore;
    this.log.push(T.hex(m));
    if (m.length === 7 && m[4] === 0x00 && m[5] === 0x70) {  // ping: the reply a real Tracks (firmware 4486) gave
      this.queue.push(T.bytes([0xF0, 0x00, 0x20, 0x29, 0x00, 0x70, 0x00, 0x04, 0x00, 0x1B, 0x64, 0x01, 0x01, 0x00, 0x23, 0x06, 0x40, 0x02, 0xF7]));
      return;
    }
    const body = Array.from(m.subarray(6, m.length - 1));   // after F0 00 20 29 01 64, without F7
    if (body[0] !== 0x03) return;
    const t = body[1];
    if (t === 0x40) { this.inExchange = true; return this.reply([0x08, 0x00]); }
    if (t === 0x41) { this.inExchange = false; this.exchangeLeft++; return this.reply([0x08, 0x00]); }
    if (!this.inExchange) return;                            // the real Tracks ignores these outside Exchange Mode
    if (t === 0x0B && body[2] === 0x02) {
      this.reply([0x03, 0x0B, 0x02, 0x09]);
      this.reply([0x03, 0x0C, 0x02, 0x08, 0x30, ...Array.from("7_New Order", (c) => c.charCodeAt(0))]);
    } else if (t === 0x0B && body[2] === 0x05) {
      for (const [k, name] of this.names) {
        const [p, s] = k.split(":").map(Number);
        if (p === body[3]) this.reply([0x03, 0x0C, 0x05, p, s, ...Array.from(name, (c) => c.charCodeAt(0))]);
      }
    } else if (t === 0x0B || t === 0x09) {
      this.reply(body);
    } else if (t === 0x01) {
      this.startOrDownload(body);
    } else if (t === 0x02 || t === 0x03 || t === 0x07) {
      this.uploadMessage(body, t);
    } else if (t === 0x08) {
      const s = body.slice(2, 5);
      this.slots.delete(s[1] + ":" + s[2]);
      this.names.delete(s[1] + ":" + s[2]);
      this.ack(0, s);
    }
  }

  startOrDownload(body) {
    const T = TracksCore, s = body.slice(10, 13), key = s[1] + ":" + s[2];
    if (body[13] === 0x02) {                                 // download request
      const wav = this.slots.get(key);
      if (!wav) return this.reply([0x03, 0x06, ...s]);
      const chunks = [];
      for (let o = 0; o < wav.length; o += T.CHUNK) chunks.push(wav.subarray(o, o + T.CHUNK));
      this.reply([0x03, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, ...s, 0x01, ...T.nib(wav.length, 8)]);
      chunks.forEach((c, i) => this.reply([0x03, 0x02, ...T.nib(i + 1, 8), ...s], Array.from(T.encode7(c))));
      this.reply([0x03, 0x03, ...T.nib(chunks.length + 1, 8), ...s, ...T.nib(T.crc32(wav), 8)]);
    } else {                                                 // upload start
      this.staged = { key, chunks: [] };
      this.uploadMsgs = 0;
      this.ack(0, s);
    }
  }

  uploadMessage(body, t) {
    const T = TracksCore;
    this.uploadMsgs++;
    if (this.dropAckAt !== null && this.uploadMsgs === this.dropAckAt) return;
    if (t === 0x07) {
      const s = body.slice(2, 5);
      this.names.set(s[1] + ":" + s[2], String.fromCharCode(...body.slice(5)));
      return this.ack(0, s);
    }
    const n = T.unnib(body.slice(2, 10)), s = body.slice(10, 13);
    if (t === 0x02) {
      this.staged.chunks.push(T.decode7(Uint8Array.from(body.slice(13))));
    } else {
      let wav = T.concat(...this.staged.chunks);
      if (this.corruptStore) { wav = wav.slice(); wav[100] ^= 0x55; }
      this.slots.set(this.staged.key, wav);
    }
    this.ack(n, s);
  }
}
