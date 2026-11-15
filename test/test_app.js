"use strict";
// Run by test/run.sh in headless Chrome. The real page body (index.html) is loaded, WebMIDI is
// replaced by a simulated Tracks that delivers its replies in pieces, and the buttons are pressed. It checks what
// test/test_core.html cannot: the buttons, the plan, the audio conversion in a real browser, the messages.
const out = document.getElementById("out");
let fails = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) fails++;
  out.textContent += (ok ? "ok   " : "FAIL ") + name + (ok ? "" : "  " + (detail || "")) + "\n";
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 600000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out waiting for " + what); await sleep(20); }
}
const $ = (id) => document.getElementById(id);
const idle = () => until(() => !$("connect").disabled, "the page to finish");
const text = (id) => $(id).textContent;
const count = (haystack, needle) => haystack.split(needle).length - 1;
const row = (r) => Array.from(r.cells, (c) => c.textContent).join("|");
const planRows = () => Array.from(document.querySelectorAll("#planTable tr")).slice(1).map(row);

// A 24-bit stereo WAV like a Koala export: 44.1 kHz, a sine at half level on the left and quarter level on the right.
function koalaWav(seconds, freq) {
  const n = Math.round(44100 * seconds), b = new Uint8Array(44 + n * 6), dv = new DataView(b.buffer);
  const tag = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  tag(0, "RIFF"); dv.setUint32(4, 36 + n * 6, true); tag(8, "WAVEfmt "); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, 44100, true); dv.setUint32(28, 44100 * 6, true);
  dv.setUint16(32, 6, true); dv.setUint16(34, 24, true); tag(36, "data"); dv.setUint32(40, n * 6, true);
  for (let i = 0; i < n; i++) {
    const v = Math.sin(2 * Math.PI * freq * i / 44100);
    [0.5, 0.25].forEach((level, c) => {
      const s = Math.round(v * level * 8388607), o = 44 + i * 6 + c * 3;
      b[o] = s & 0xFF; b[o + 1] = (s >> 8) & 0xFF; b[o + 2] = (s >> 16) & 0xFF;
    });
  }
  return b;
}
const fileOf = (name, bytes) => new File([bytes], name, { type: "audio/wav" });
function setFiles(files) {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  $("files").files = dt.files;
}

// WebMIDI replaced by the simulated Tracks. Its replies arrive in pieces of 3000 bytes, as a USB driver may deliver them.
function installFakeMidi(fake, asked) {
  const inPort = { name: "Circuit Tracks MIDI", type: "input", state: "connected", async open() {}, onmidimessage: null };
  const outPort = {
    name: "Circuit Tracks MIDI", type: "output", state: "connected", async open() {},
    send(bytes) {
      fake.send(bytes);
      setTimeout(() => {
        while (fake.queue.length) {
          const m = fake.queue.shift();
          for (let o = 0; o < m.length; o += 3000) inPort.onmidimessage({ data: m.subarray(o, o + 3000) });
        }
      }, 0);
    },
  };
  navigator.requestMIDIAccess = async (opts) => {
    check("page asks for sysex access", !!opts && opts.sysex === true);
    return { inputs: new Map([["i", inPort]]), outputs: new Map([["o", outPort]]), onstatechange: null };
  };
  window.confirm = (q) => { asked.push(q); return true; };
}

async function loadApp() {
  const page = await (await fetch("../index.html")).text();
  $("app").innerHTML = page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<meta[^>]*>|<title>[\s\S]*?<\/title>/g, "");
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "../tracks_app.js"; s.onload = resolve; s.onerror = () => reject(new Error("tracks_app.js did not load"));
    document.body.appendChild(s);
  });
}

async function main() {
  const fake = new FakeTracks(), asked = [];
  installFakeMidi(fake, asked);
  await loadApp();
  check("starts with Connect on and Upload off", !$("connect").disabled && $("upload").disabled);
  check("the hint says to connect first", /press Connect first/.test(text("hint")), text("hint"));

  $("connect").click();
  await until(() => text("log").includes("packs: 1"), "connect");
  await idle();
  check("shows the firmware build", text("status") === "connected: Circuit Tracks, firmware 4486", text("status"));
  check("lists the pack", $("pack").textContent.includes("7_New Order"), $("pack").textContent);
  check("Exchange Mode left after connect", fake.inExchange === false && fake.exchangeLeft === 1);
  check("upload stays off until there is a plan", $("upload").disabled);
  check("the hint now says to make the plan", /Check the plan/.test(text("hint")), text("hint"));

  check("the default mode takes any file names", document.querySelector("input[name=mode]:checked").value === "free");

  // a plan from Koala names, given out of order
  document.querySelector("input[name=mode][value=koala]").checked = true;
  setFiles([fileOf("C02.wav", koalaWav(0.5, 330)), fileOf("C01.wav", koalaWav(1.0, 220))]);
  $("plan").click();
  await until(() => text("log").includes("Nothing sent yet"), "the plan");
  await idle();
  check("plan rows are in slot order with seconds and names", planRows().join(" ; ") === "33|32_C01.wav|1.00|C01.wav ; 34|33_C02.wav|0.50|C02.wav", planRows().join(" ; "));
  check("planning sent nothing to the Tracks", fake.slots.size === 0 && !fake.log.some((l) => / 03 0[1237] /.test(l) && / 05 08 /.test(l)));

  $("upload").click();
  await until(() => text("log").includes("all 2 uploaded and verified"), "the upload");
  await idle();
  const a = fake.slots.get("8:32"), b = fake.slots.get("8:33");
  check("both samples stored", !!a && !!b);
  const dvA = new DataView(a.buffer, a.byteOffset, a.length);
  check("a stored sample is 16-bit mono 48 kHz with a plain 44-byte header",
    dvA.getUint16(22, true) === 1 && dvA.getUint32(24, true) === 48000 && dvA.getUint16(34, true) === 16 &&
    dvA.getUint32(40, true) === a.length - 44 && a.length === 44 + 96000, a.length);
  let peak = 0;
  for (let i = 0; i < 48000; i++) peak = Math.max(peak, Math.abs(dvA.getInt16(44 + i * 2, true)));
  check("level is the stereo mix (0.5 and 0.25 average to 0.375 of full scale)", Math.abs(peak / 32767 - 0.375) < 0.01, peak / 32767);
  check("the half-second sample has half the data", b.length === 44 + 48000, b.length);
  check("names stored", fake.names.get("8:32") === "32_C01.wav" && fake.names.get("8:33") === "33_C02.wav");
  check("upload left Exchange Mode", fake.inExchange === false);
  check("no confirmation asked for a plain upload", asked.length === 0);
  check("progress bar finished", $("bar").value === 1);
  check("the hint says ready, with the count", /Ready: 2 samples planned/.test(text("hint")), text("hint"));
  check("buttons usable again", !$("connect").disabled && !$("upload").disabled);

  // the same upload again is refused
  $("upload").click();
  await until(() => text("log").includes("already in use"), "the refusal");
  await idle();
  check("second upload is refused and says which slots", /already in use: 33, 34/.test(text("log")));
  check("the refused upload changed nothing", fake.slots.get("8:32") === a && fake.slots.get("8:33") === b);

  // overwrite asks first, then replaces
  $("overwrite").checked = true;
  const before = count(text("log"), "uploaded and verified");
  $("upload").click();
  await until(() => count(text("log"), "uploaded and verified") >= before + 1, "the overwrite");
  await idle();
  check("overwrite asked for confirmation", asked.length === 1 && /Replace any samples/.test(asked[0]), asked[0]);
  check("overwrite replaced the samples", fake.slots.get("8:32") !== a);

  // names that are not Koala names, then fill-from mode
  $("overwrite").checked = false;
  setFiles([fileOf("kick.wav", koalaWav(0.2, 100))]);
  document.querySelector("input[name=mode][value=koala]").checked = true;
  $("plan").click();
  await until(() => /not Koala pad names/.test(text("log")), "the name error");
  await idle();
  check("a non-Koala name is explained", /kick\.wav/.test(text("log")));
  check("a failed plan leaves nothing to upload", $("upload").disabled);
  document.querySelector("input[name=mode][value=start]").checked = true;
  $("start").value = "50";
  $("plan").click();
  await until(() => !$("upload").disabled, "the fill-from plan");
  await idle();
  check("fill-from plan goes to slot 50", planRows().join() === "50|49_kick.wav|0.20|kick.wav", planRows().join());

  // any file names: the first free slots, skipping what the Tracks says is used
  fake.names.set("8:0", "00_existing.wav");
  document.querySelector("input[name=mode][value=free]").checked = true;
  setFiles([fileOf("snare 10.wav", koalaWav(0.1, 150)), fileOf("My Kick (final).wav", koalaWav(0.1, 60)), fileOf("snare 2.wav", koalaWav(0.1, 140))]);
  $("plan").click();
  await until(() => planRows().length === 3, "the free-slot plan");
  await idle();
  check("free mode: first free slots, names in natural order", planRows().map((r) => r.split("|").slice(0, 2).join("|")).join(" ; ") ===
    "2|01_My Kick _final_.wav ; 3|02_snare 2.wav ; 4|03_snare 10.wav", planRows().join(" ; "));
  check("free mode: upload is ready", !$("upload").disabled && /Ready: 3 samples/.test(text("hint")), text("hint"));
  $("upload").click();
  await until(() => text("log").includes("all 3 uploaded and verified"), "the free-mode upload");
  await idle();
  check("free mode: stored in those slots under those names", fake.slots.has("8:1") && fake.slots.has("8:2") && fake.slots.has("8:3") && !fake.slots.has("8:0") &&
    fake.names.get("8:2") === "02_snare 2.wav", Array.from(fake.names.entries()).join());
  document.querySelector("input[name=mode][value=free]").checked = true;
  setFiles([]);
  $("plan").click();
  await until(() => /choose some audio files first/.test(text("log")), "the no-files message");
  await idle();
  check("no files chosen is explained", true);

  // delete
  $("delSlot").value = "34";
  $("delete").click();
  await until(() => text("log").includes("slot 34 cleared"), "the delete");
  await idle();
  check("delete asked first", /Delete the sample in slot 34/.test(asked[1]), asked[1]);
  check("delete cleared that slot only", !fake.slots.has("8:33") && fake.slots.has("8:32"));
  const askedBefore = asked.length;
  $("delSlot").value = "99";
  $("delete").click();
  await until(() => /type a slot from 1 to 64/.test(text("log")), "the slot error");
  await idle();
  check("delete refuses a slot outside 1-64 without asking", asked.length === askedBefore);

  // list shows the Tracks' own names, with the numbers the Tracks displays
  $("list").click();
  await until(() => /named samples/.test(text("log")), "the list");
  await idle();
  const listed = Array.from(document.querySelectorAll("#samples tr")).slice(1).map(row);
  check("list shows slot numbers as the Tracks does", listed.join() === "1|00_existing.wav,2|01_My Kick _final_.wav,3|02_snare 2.wav,4|03_snare 10.wav,33|32_C01.wav", listed.join());
  check("Exchange Mode is never left on", fake.inExchange === false);
}

main().then(() => { out.textContent += (fails ? fails + " of " + checks + " FAILED" : "ALL PASS (" + checks + " checks)") + "\n"; })
  .catch((e) => { out.textContent += "FAIL test crashed: " + e.message + "\n" + (fails + 1) + " of " + checks + " FAILED\nlog was: " + text("log") + "\n"; });

