// The page logic of index.html. The protocol itself is in tracks_core.js (tested against a USB capture and a
// simulated Tracks by test/run.sh); this file only connects WebMIDI to it and draws the screen.
"use strict";
(function () {
  const T = TracksCore;
  const $ = (id) => document.getElementById(id);
  const logEl = $("log");
  let input = null, output = null, queue = [], waiter = null, partial = null, busy = false, jobs = [], wakeLock = null;

  function say(text, cls) {
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = text;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---- the WebMIDI port, in the shape TracksCore wants ----
  function onMessage(ev) {
    const d = ev.data;
    if (d[0] === 0xF0) partial = [];
    if (partial === null) return;                       // clock and other non-sysex bytes
    for (const b of d) if (b < 0xF8) partial.push(b);
    if (partial[partial.length - 1] === 0xF7) {
      queue.push(Uint8Array.from(partial));
      partial = null;
      if (waiter) { const w = waiter; waiter = null; w(); }
    }
  }

  const port = {
    drain() { queue = []; },
    send(bytes) { output.send(bytes); },
    next(timeoutMs) {
      return new Promise((resolve) => {
        if (queue.length) return resolve(queue.shift());
        const t = setTimeout(() => { waiter = null; resolve(null); }, timeoutMs);
        waiter = () => { clearTimeout(t); resolve(queue.shift()); };
      });
    },
  };

  function setButtons() {
    const on = !!output && !busy;
    for (const id of ["pack", "list", "delete"]) $(id).disabled = !on;
    $("plan").disabled = busy;
    $("upload").disabled = !on || !jobs.length;
    $("connect").disabled = busy;
    // Say why Upload is off, in the order the steps have to be done.
    $("hint").textContent = busy ? "working: keep this screen open"
      : !output ? "Upload is off: press Connect first (and it must say \"connected\")"
      : !jobs.length ? "Upload is off: choose files, then press \"Check the plan\" (it must list your samples without an error)"
      : "Ready: " + jobs.length + " sample" + (jobs.length > 1 ? "s" : "") + " planned. Press Upload.";
  }

  // Run one operation at a time; the buttons stay off while it works.
  async function run(label, fn) {
    if (busy) return;
    busy = true;
    setButtons();
    try {
      if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen").catch(() => null);
      await fn();
    } catch (e) {
      say(label + ": " + e.message, "bad");
    } finally {
      if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
      busy = false;
      setButtons();
    }
  }

  async function connect() {
    if (!navigator.requestMIDIAccess) throw new Error("this browser has no WebMIDI: use Chrome on Android, from an https address");
    const midi = await navigator.requestMIDIAccess({ sysex: true });
    midi.onstatechange = (e) => say("port " + e.port.state + ": " + e.port.type + " " + e.port.name, "dim");
    await new Promise((r) => setTimeout(r, 1500));
    input = [...midi.inputs.values()].find((p) => /circuit tracks/i.test(p.name));
    output = [...midi.outputs.values()].find((p) => /circuit tracks/i.test(p.name));
    if (!input || !output) {
      input = output = null;
      throw new Error("no Circuit Tracks port: check the cable, that the Tracks is on, and allow the USB permission box if one appeared");
    }
    input.onmidimessage = onMessage;
    await input.open(); await output.open();
    const ping = await T.ask(port, T.bytes([0xF0, 0x00, 0x20, 0x29, 0x00, 0x70, 0xF7]));
    const p = ping.find((m) => m.length >= 19 && m[4] === 0 && m[5] === 0x70);
    if (!p || p[7] !== 4) throw new Error("the device did not answer like a Circuit Tracks");
    $("status").textContent = "connected: Circuit Tracks, firmware " + ((p[14] << 7) | p[15]);
    $("status").className = "ok";
    const packs = await T.withExchange(port, () => T.packNames(port));
    const sel = $("pack");
    sel.innerHTML = "";
    for (const id of Object.keys(packs).map(Number).sort((a, b) => a - b)) {
      const o = document.createElement("option");
      o.value = id; o.textContent = id + "  " + packs[id];
      sel.appendChild(o);
    }
    say("packs: " + Object.keys(packs).length, "ok");
  }

  const pack = () => +$("pack").value;

  async function list() {
    const names = await T.withExchange(port, async () => { await T.openPack(port, pack()); return T.slotNames(port, pack()); });
    const rows = Object.keys(names).map(Number).sort((a, b) => a - b);
    const t = $("samples");
    t.innerHTML = "<tr><th>slot</th><th>name on the Tracks</th></tr>";
    for (const s of rows) {
      const tr = t.insertRow();
      tr.insertCell().textContent = s + 1;
      tr.insertCell().textContent = names[s];
    }
    say("pack " + pack() + ": " + rows.length + " named samples (the Tracks' own list; the upload checks the slots itself)", "ok");
  }

  async function makePlan() {
    jobs = [];
    $("planTable").innerHTML = "";
    const files = Array.from($("files").files);
    if (!files.length) throw new Error("choose some audio files first");
    const mode = document.querySelector("input[name=mode]:checked").value;
    let plan;
    if (mode === "free") {
      if (!output) throw new Error("press Connect first: finding free slots needs the Tracks");
      const names = await T.withExchange(port, async () => { await T.openPack(port, pack()); return T.slotNames(port, pack()); });
      plan = T.planFree(files, Object.keys(names).map(Number));   // the upload itself still checks every slot before it writes
    } else {
      plan = T.planBulk(files, mode === "start" ? +$("start").value - 1 : null);
    }
    const t = $("planTable");
    t.innerHTML = "<tr><th>slot</th><th>name</th><th>seconds</th><th>file</th></tr>";
    let total = 0;
    for (const p of plan) {
      const wav = await T.toTracksWav(await p.file.arrayBuffer());
      const secs = (wav.length - 44) / 2 / T.RATE;
      total += secs;
      const job = { slot: p.slot, wav, name: T.defaultName(p.slot, p.file.name) };
      jobs.push(job);
      const tr = t.insertRow();
      tr.insertCell().textContent = p.slot + 1;
      tr.insertCell().textContent = job.name;
      tr.insertCell().textContent = secs.toFixed(2);
      tr.insertCell().textContent = p.file.name;
    }
    say(jobs.length + " samples, " + total.toFixed(1) + " s in all. The Tracks holds about 196 s in total, shared with what is already on it. Nothing sent yet.", "ok");
  }

  async function upload() {
    if (!jobs.length) throw new Error("make the plan first");
    const overwrite = $("overwrite").checked;
    if (overwrite && !confirm("Replace any samples already in those " + jobs.length + " slots? This cannot be undone.")) return;
    const bar = $("bar");
    bar.hidden = false; bar.value = 0;
    let done = 0;
    await T.bulkUpload(port, pack(), jobs, {
      overwrite,
      onStep: (j, step) => { if (step === "verified") { done++; say("slot " + (j.slot + 1) + " " + j.name + ": uploaded and read back identical", "ok"); } },
      onProgress: (j, i, n) => { bar.value = (done + i / n) / jobs.length; },
    });
    bar.value = 1;
    say("all " + done + " uploaded and verified", "ok");
  }

  async function del() {
    const slot = +$("delSlot").value;
    if (!(slot >= 1 && slot <= 64)) throw new Error("type a slot from 1 to 64");
    if (!confirm("Delete the sample in slot " + slot + " of pack " + pack() + "? This cannot be undone.")) return;
    await T.withExchange(port, async () => { await T.openPack(port, pack()); await T.deleteSlot(port, pack(), slot - 1); });
    say("slot " + slot + " cleared", "ok");
  }

  for (const [id, label, fn] of [["connect", "connect", connect], ["list", "list", list], ["plan", "plan", makePlan], ["upload", "upload", upload], ["delete", "delete", del]]) {
    $(id).onclick = () => run(label, fn);
  }
  say("secure context: " + window.isSecureContext + "   WebMIDI: " + !!navigator.requestMIDIAccess, "dim");
  setButtons();
})();

