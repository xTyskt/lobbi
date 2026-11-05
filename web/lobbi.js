/**
 * Lobbi browser SDK. Zero dependencies, ES module.
 *
 *   import { Lobbi } from './lobbi.js';
 *   const net = await Lobbi.connect({ key: 'pk_...', url: 'wss://api.example.com' });
 *   const lobby = await net.joinOrCreate({ name: 'room-1', max: 8 });
 *
 * Messages up to 16 KB go straight through. On the 'safe' channel, messages up to 8 MB are split into chunks and reassembled for you.
 * Topology: star. The host (the lobby creator) holds a WebRTC connection to every player.
 * Players talk to the host; the host can send to one player or broadcast.
 * v0.1: when the host is gone the lobby closes and everyone gets 'closed'. There is no host migration yet.
 */

export const VERSION = '0.1.0';

const MAX_MESSAGE_BYTES = 16 * 1024; // largest single data-channel message that is safe across browsers
const MAX_BIG_BYTES = 8 * 1024 * 1024; // larger 'safe' messages are split into chunks, up to this size
const BIG_CHUNK = 15_000;
const BIG_HEADER = 13; // kind(1) + message id(4) + index(4) + total(4)
const FAST_DROP_AT = 64 * 1024; // drop unreliable packets when this much is already queued
const ICE_TIMEOUT_MS = 15_000;
const CTL_PING_MS = 4_000;
const CTL_DEAD_MS = 12_000;
const RECONNECT_WINDOW_MS = 12_000;
const PROBE_BYTES = 256 * 1024;

export class LobbiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LobbiError';
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const utf8Length = (s) => (s.length < 512 ? s.length * 3 : new TextEncoder().encode(s).length);

class Emitter {
  constructor() {
    this._h = new Map();
  }
  on(ev, fn) {
    let set = this._h.get(ev);
    if (!set) this._h.set(ev, (set = new Set()));
    set.add(fn);
    return () => this.off(ev, fn);
  }
  off(ev, fn) {
    this._h.get(ev)?.delete(fn);
  }
  once(ev, fn) {
    const off = this.on(ev, (...a) => {
      off();
      fn(...a);
    });
    return off;
  }
  emit(ev, ...args) {
    for (const fn of [...(this._h.get(ev) ?? [])]) {
      try {
        fn(...args);
      } catch (e) {
        console.error('[lobbi] event handler threw', e);
      }
    }
  }
}

/**
 * One 1-second ticker for every timer in the SDK. It runs in a Web Worker so that background tabs
 * (which throttle main-thread timers) don't get a host kicked for missing heartbeats.
 */
class Ticker {
  constructor() {
    this.subs = new Set();
    this.worker = null;
    this.iv = null;
    try {
      const url = URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),1000)'], { type: 'text/javascript' }));
      this.worker = new Worker(url);
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      this.worker.onmessage = () => this.tick();
      this.worker.onerror = () => {
        this.worker?.terminate();
        this.worker = null;
        this.fallback();
      };
    } catch {
      this.fallback();
    }
  }
  fallback() {
    if (!this.iv) this.iv = setInterval(() => this.tick(), 1000);
  }
  tick() {
    const now = Date.now();
    for (const s of [...this.subs]) {
      if (now - s.last >= s.every - 50) {
        s.last = now;
        try {
          s.fn(now);
        } catch (e) {
          console.error('[lobbi] timer threw', e);
        }
      }
    }
  }
  add(every, fn) {
    const s = { every, fn, last: Date.now() };
    this.subs.add(s);
    return () => this.subs.delete(s);
  }
  stop() {
    this.worker?.terminate();
    clearInterval(this.iv);
    this.subs.clear();
  }
}

function detectCaps() {
  let wasm32 = false;
  try {
    wasm32 = typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  } catch {}
  const nav = typeof navigator === 'object' ? navigator : {};
  return { wasm32, cores: nav.hardwareConcurrency | 0, memGB: nav.deviceMemory || 0 };
}

async function selectedPathIsRelay(pc) {
  try {
    const stats = await pc.getStats();
    const byId = new Map();
    let pairId = null;
    stats.forEach((r) => {
      byId.set(r.id, r);
      if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    let pair = pairId ? byId.get(pairId) : null;
    if (!pair) stats.forEach((r) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && (pair = r));
    if (!pair) return false;
    return byId.get(pair.localCandidateId)?.candidateType === 'relay' || byId.get(pair.remoteCandidateId)?.candidateType === 'relay';
  } catch {
    return false;
  }
}

/** One WebRTC connection between this client and one other member (host <-> player). */
class PeerLink {
  constructor(lobby, id, initiator) {
    this.lobby = lobby;
    this.id = id;
    this.initiator = initiator;
    this.ready = false;
    this.failed = false;
    this.relayed = false;
    this.rtt = 0;
    this.maxBuf = 0;
    this.dropped = 0;
    this.lastCtl = Date.now();
    this.pendingIce = [];
    this.ch = {};
    this._bigSeq = 0;
    this._rx = new Map(); // message id -> partial big message
    this.disconnectTimer = null;

    const RTC = lobby._lobbi.opts.RTCPeerConnection || globalThis.RTCPeerConnection;
    if (!RTC) throw new LobbiError('unsupported', 'WebRTC is not available in this environment');
    this.pc = new RTC({ iceServers: lobby.ice });
    this.pc.onicecandidate = (e) => e.candidate && lobby._signal(id, 'ice', e.candidate.toJSON ? e.candidate.toJSON() : e.candidate);
    this.pc.onconnectionstatechange = () => this._onState(this.pc.connectionState);
    this.iceTimer = setTimeout(() => !this.ready && this.fail('failed'), ICE_TIMEOUT_MS);

    if (initiator) {
      this._wire(this.pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));
      this._wire(this.pc.createDataChannel('safe'));
      this._wire(this.pc.createDataChannel('ctl'));
      this._wire(this.pc.createDataChannel('big'));
      this._offer().catch(() => this.fail('failed'));
    } else {
      this.pc.ondatachannel = (e) => this._wire(e.channel);
    }
  }

  async _offer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    const d = this.pc.localDescription;
    this.lobby._signal(this.id, 'offer', { type: d.type, sdp: d.sdp });
  }

  async handleSignal(kind, data) {
    try {
      if (kind === 'offer') {
        await this.pc.setRemoteDescription(data);
        await this._flushIce();
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        const d = this.pc.localDescription;
        this.lobby._signal(this.id, 'answer', { type: d.type, sdp: d.sdp });
      } else if (kind === 'answer') {
        await this.pc.setRemoteDescription(data);
        await this._flushIce();
      } else if (kind === 'ice') {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(data).catch(() => {});
        else this.pendingIce.push(data);
      }
    } catch {
      this.fail('failed');
    }
  }

  async _flushIce() {
    const list = this.pendingIce.splice(0);
    for (const c of list) await this.pc.addIceCandidate(c).catch(() => {});
  }

  _wire(ch) {
    ch.binaryType = 'arraybuffer';
    this.ch[ch.label] = ch;
    ch.onopen = () => this._maybeReady();
    ch.onmessage = (e) => this._onData(ch.label, e.data);
    ch.onclose = () => !this.failed && this.ready && this.fail('lost');
    if (ch.readyState === 'open') this._maybeReady();
  }

  _maybeReady() {
    if (this.ready || this.failed) return;
    const { fast, safe, ctl, big } = this.ch;
    if (fast?.readyState === 'open' && safe?.readyState === 'open' && ctl?.readyState === 'open' && big?.readyState === 'open') {
      this.ready = true;
      clearTimeout(this.iceTimer);
      this.lastCtl = Date.now();
      selectedPathIsRelay(this.pc).then((relayed) => {
        this.relayed = relayed;
        this.lobby._onLinkReady(this);
      });
    }
  }

  _onData(label, data) {
    if (label === 'ctl') {
      const s = String(data);
      this.lastCtl = Date.now();
      if (s[0] === 'p') this.ch.ctl?.readyState === 'open' && this.ch.ctl.send('o' + s.slice(1));
      else if (s[0] === 'o') this.rtt = Math.max(0, Date.now() - Number(s.slice(1)));
      return;
    }
    if (label === 'big') return this._onBig(data);
    this.lobby._onData(this, label, data);
  }

  _sendBig(data) {
    const ch = this.ch.big;
    if (!ch || ch.readyState !== 'open') return false;
    const isString = typeof data === 'string';
    const bytes = isString
      ? new TextEncoder().encode(data)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.length > MAX_BIG_BYTES) throw new LobbiError('too_big', `Messages are limited to ${MAX_BIG_BYTES} bytes`);
    const total = Math.max(1, Math.ceil(bytes.length / BIG_CHUNK));
    const id = (this._bigSeq = (this._bigSeq + 1) >>> 0);
    for (let i = 0; i < total; i++) {
      const part = bytes.subarray(i * BIG_CHUNK, (i + 1) * BIG_CHUNK);
      const buf = new Uint8Array(BIG_HEADER + part.length);
      const dv = new DataView(buf.buffer);
      dv.setUint8(0, isString ? 1 : 0);
      dv.setUint32(1, id);
      dv.setUint32(5, i);
      dv.setUint32(9, total);
      buf.set(part, BIG_HEADER);
      try {
        ch.send(buf);
      } catch {
        return false;
      }
    }
    this.lobby._bytesSent += bytes.length;
    return true;
  }

  _onBig(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < BIG_HEADER) return;
    const dv = new DataView(data);
    const kind = dv.getUint8(0);
    const id = dv.getUint32(1);
    const index = dv.getUint32(5);
    const total = dv.getUint32(9);
    const maxTotal = Math.ceil(MAX_BIG_BYTES / BIG_CHUNK);
    if (total < 1 || total > maxTotal || index >= total) return; // malformed or too large: ignore
    const now = Date.now();
    for (const [k, v] of this._rx) if (now - v.at > 60_000) this._rx.delete(k); // drop stale partials
    let msg = this._rx.get(id);
    if (!msg) {
      if (this._rx.size >= 8) return; // cap concurrent reassemblies
      msg = { kind, total, parts: new Array(total), got: 0, at: now };
      this._rx.set(id, msg);
    }
    if (msg.total !== total || msg.parts[index]) return;
    msg.parts[index] = new Uint8Array(data.slice(BIG_HEADER));
    msg.got++;
    if (msg.got < msg.total) return;
    this._rx.delete(id);
    const size = msg.parts.reduce((n, p) => n + p.length, 0);
    const all = new Uint8Array(size);
    let off = 0;
    for (const p of msg.parts) {
      all.set(p, off);
      off += p.length;
    }
    this.lobby._onData(this, 'safe', msg.kind === 1 ? new TextDecoder().decode(all) : all.buffer);
  }

  ctlPing() {
    if (this.ch.ctl?.readyState === 'open') this.ch.ctl.send('p' + Date.now());
  }

  checkAlive(now) {
    if (this.ready && now - this.lastCtl > CTL_DEAD_MS) this.fail('lost');
  }

  _onState(state) {
    if (state === 'failed') this.fail('failed');
    else if (state === 'closed') this.ready && this.fail('lost');
    else if (state === 'disconnected') {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = setTimeout(() => this.pc.connectionState === 'disconnected' && this.fail('lost'), 5000);
    } else if (state === 'connected') clearTimeout(this.disconnectTimer);
  }

  send(channel, data) {
    const ch = this.ch[channel];
    if (!this.ready || !ch || ch.readyState !== 'open') return false;
    const size = typeof data === 'string' ? utf8Length(data) : data.byteLength;
    if (size > MAX_MESSAGE_BYTES) {
      if (channel !== 'safe') throw new LobbiError('too_big', `The fast channel is limited to ${MAX_MESSAGE_BYTES} bytes; use the safe channel for larger messages`);
      return this._sendBig(data);
    }
    if (ch.bufferedAmount > this.maxBuf) this.maxBuf = ch.bufferedAmount;
    if (channel === 'fast' && ch.bufferedAmount > FAST_DROP_AT) {
      this.dropped++;
      return false;
    }
    try {
      ch.send(data);
    } catch {
      return false;
    }
    this.lobby._bytesSent += size;
    return true;
  }

  fail(state) {
    if (this.failed) return;
    this.failed = true;
    const wasReady = this.ready;
    this.ready = false;
    this.close();
    this.lobby._onLinkFailed(this, state, wasReady);
  }

  close() {
    clearTimeout(this.iceTimer);
    clearTimeout(this.disconnectTimer);
    this.failed = true;
    for (const ch of Object.values(this.ch)) {
      ch.onopen = ch.onmessage = ch.onclose = null;
      try {
        ch.close();
      } catch {}
    }
    this.pc.onconnectionstatechange = this.pc.onicecandidate = null;
    try {
      this.pc.close();
    } catch {}
  }
}

class Lobby extends Emitter {
  constructor(lobbi, snap) {
    super();
    this._lobbi = lobbi;
    this.dead = false;
    this.peers = new Map(); // memberId -> PeerLink
    this._offs = [];
    this._ticks = [];
    this._bytesSent = 0;
    this._bytesAt = Date.now();
    this._budget = lobbi.opts.tickBudgetMs;
    this._applySnapshot(snap);
  }

  /** Members the server knows about (including yourself). */
  get members() {
    return [...this._members];
  }
  /** Ids of members this client currently has a working peer connection with. */
  get connected() {
    return [...this.peers.values()].filter((l) => l.ready).map((l) => l.id);
  }

  _applySnapshot(s) {
    this.code = s.code;
    this.name = s.name;
    this.hostId = s.hostId;
    this.id = s.you;
    this.isHost = s.isHost;
    this.max = s.max;
    this.meta = s.meta;
    this.hostUnfit = !!s.hostUnfit;
    this.ice = s.ice;
    this._members = new Set(s.members.map((m) => m.id));
  }

  _start() {
    const t = this._lobbi._ticker;
    this._offs.push(t.add(CTL_PING_MS, (now) => this._ctlTick(now)));
    this._offs.push(t.add(30 * 60 * 1000, () => this._refreshIce()));
    if (this.isHost) {
      this._offs.push(t.add(5000, () => this._sendHostStats()));
      if (this.hostUnfit) this.emit('hostUnfit');
    } else {
      this.peers.set(this.hostId, new PeerLink(this, this.hostId, true));
    }
  }

  // ----- public API -----

  /**
   * Send a message. Players always send to the host. The host sends to `to`, or broadcasts when `to` is omitted.
   * channel 'fast' = unreliable/unordered (may be dropped under load), 'safe' = reliable/ordered.
   * Returns true if the message was handed to the network.
   */
  send(data, { to, channel = 'fast' } = {}) {
    this._assertAlive();
    if (!this.isHost) return this.peers.get(this.hostId)?.send(channel, data) ?? false;
    if (to === undefined) return this.broadcast(data, { channel }) > 0;
    return this.peers.get(to)?.send(channel, data) ?? false;
  }

  /** Host: send to every connected player (optionally skipping one). Players: same as send(). Returns how many got it. */
  broadcast(data, { channel = 'fast', except } = {}) {
    this._assertAlive();
    let n = 0;
    for (const link of this.peers.values()) {
      if (link.id !== except && link.send(channel, data)) n++;
    }
    return n;
  }

  /** Host: report how long your simulation tick took (ms). Feeds the adaptive player cap. */
  reportTick(ms, budgetMs) {
    if (!this.isHost) return;
    this._ticks.push(ms);
    if (this._ticks.length > 120) this._ticks.shift();
    if (budgetMs) this._budget = budgetMs;
  }

  setMeta(meta) {
    this._assertAlive();
    this._lobbi._send({ t: 'meta', meta });
  }

  kick(id) {
    this._assertAlive();
    this._lobbi._send({ t: 'kick', id });
  }

  async leave() {
    if (this.dead) return;
    try {
      await this._lobbi._request('leave');
    } catch {}
    if (this._lobbi.lobby === this) this._lobbi.lobby = null;
    this._die('left');
  }

  /** Per-connection info for debugging or UI. */
  stats() {
    return [...this.peers.values()].map((l) => ({
      id: l.id,
      ready: l.ready,
      relayed: l.relayed,
      rttMs: l.rtt,
      dropped: l.dropped,
      buffered: l.ch.fast?.bufferedAmount ?? 0,
    }));
  }

  // ----- internals -----

  _assertAlive() {
    if (this.dead) throw new LobbiError('closed', 'This lobby is closed');
  }

  _setIce(ice) {
    this.ice = ice;
    for (const link of this.peers.values()) {
      try {
        link.pc.setConfiguration({ ...link.pc.getConfiguration(), iceServers: ice });
      } catch {}
    }
  }

  _signal(to, kind, data) {
    this._lobbi._send({ t: 'signal', to, kind, data });
  }

  _handleSignal(from, kind, data) {
    let link = this.peers.get(from);
    if (!link) {
      if (!this.isHost || kind !== 'offer' || !this._members.has(from)) return;
      link = new PeerLink(this, from, false);
      this.peers.set(from, link);
    }
    link.handleSignal(kind, data);
  }

  _onLinkReady(link) {
    if (this.dead) return;
    if (this.isHost) {
      this._lobbi._send({ t: 'report', peer: link.id, state: 'connected' });
      this.emit('playerConnected', { id: link.id, relayed: link.relayed });
    } else {
      this._lobbi._send({ t: 'report', peer: link.id, state: 'connected', path: link.relayed ? 'relay' : 'direct', rtt: link.rtt });
      this.emit('connected', { relayed: link.relayed });
    }
  }

  _onLinkFailed(link, state, wasReady) {
    if (this.dead) return;
    this.peers.delete(link.id);
    this._lobbi._send({ t: 'report', peer: link.id, state: state === 'failed' ? 'failed' : 'lost' });
    if (!this.isHost) this.emit('hostUnresponsive', { state });
    else if (wasReady) this.emit('playerLost', { id: link.id });
  }

  _onData(link, channel, data) {
    if (!this.dead) this.emit('message', link.id, data, channel);
  }

  _onPeerJoined(id) {
    this._members.add(id);
    this.emit('playerJoined', id);
  }

  _onPeerLeft(id, reason) {
    this._members.delete(id);
    this.peers.get(id)?.close();
    this.peers.delete(id);
    this.emit('playerLeft', id, reason);
  }

  _ctlTick(now) {
    for (const link of [...this.peers.values()]) {
      if (this.isHost) link.ctlPing();
      link.checkAlive(now);
    }
  }

  _sendHostStats() {
    if (!this.isHost || this.dead) return;
    const now = Date.now();
    const sorted = [...this._ticks].sort((a, b) => a - b);
    const p95 = (a) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * 0.95))] : 0);
    const links = [...this.peers.values()];
    const upKbps = Math.round((this._bytesSent * 8) / Math.max(1, now - this._bytesAt));
    this._lobbi._send({
      t: 'hostStats',
      tickP95: p95(sorted),
      tickBudget: this._budget,
      bufMax: Math.max(0, ...links.map((l) => l.maxBuf)),
      upKbps,
      rttP95: p95(links.map((l) => l.rtt).sort((a, b) => a - b)),
    });
    this._bytesSent = 0;
    this._bytesAt = now;
    for (const l of links) l.maxBuf = 0;
  }

  async _refreshIce() {
    try {
      const r = await this._lobbi._request('turn');
      this._setIce(r.ice);
    } catch {}
  }

  _die(reason) {
    if (this.dead) return;
    this.dead = true;
    for (const off of this._offs) off();
    for (const link of this.peers.values()) link.close();
    this.peers.clear();
    this.emit('closed', reason);
  }
}

export class Lobbi extends Emitter {
  /**
   * Connect to a Lobbi server.
   * @param {{ key: string, url: string, perPlayerKbps?: number, tickBudgetMs?: number }} opts
   */
  static async connect(opts) {
    const lobbi = new Lobbi(opts);
    await lobbi._open(null);
    return lobbi;
  }

  constructor(opts) {
    super();
    if (!opts || !opts.key) throw new LobbiError('bad_options', 'A public key is required');
    if (!opts.url) throw new LobbiError('bad_options', 'The server url is required');
    this.opts = { tickBudgetMs: 50, ...opts };
    this.lobby = null;
    this.sessionId = null;
    this._token = null;
    this._ws = null;
    this._seq = 0;
    this._pending = new Map();
    this._closed = false;
    this._reconnecting = false;
    this._probed = false;
    this._lastRx = Date.now();
    this._ticker = new Ticker();
    this._hb = null;
    this.iceServers = [];
    this.version = VERSION;
    if (typeof addEventListener === 'function') {
      this._onHide = () => this._ws?.readyState === 1 && this._send({ t: 'leave' });
      addEventListener('pagehide', this._onHide);
    }
  }

  // ----- public API -----

  async list(filter, cursor) {
    const r = await this._request('list', { filter, cursor });
    return { items: r.items, cursor: r.cursor };
  }

  async create(o = {}) {
    return this._enter(await this._request('create', this._opts(o)));
  }

  async join(code, o = {}) {
    return this._enter(await this._request('join', { code, password: o.password }));
  }

  /** Join an open lobby with this name, or create it (you become the host). */
  async joinOrCreate(o = {}) {
    return this._enter(await this._request('joinOrCreate', this._opts(o)));
  }

  close() {
    this._closed = true;
    this._ticker.stop();
    if (typeof removeEventListener === 'function' && this._onHide) removeEventListener('pagehide', this._onHide);
    this.lobby?._die('left');
    this.lobby = null;
    this._ws?.close(1000);
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(new LobbiError('closed', 'Connection closed'));
    }
    this._pending.clear();
  }

  // ----- internals -----

  _opts(o) {
    return { name: o.name, max: o.max, public: o.public, password: o.password, meta: o.meta, bw: o.perPlayerKbps ?? this.opts.perPlayerKbps };
  }

  _enter(snap) {
    if (this.lobby && !this.lobby.dead) throw new LobbiError('already_in_lobby', 'Leave your current lobby first');
    const lobby = new Lobby(this, snap);
    this.lobby = lobby;
    lobby._start();
    return lobby;
  }

  _url(resume) {
    let base = this.opts.url.replace(/\/+$/, '');
    if (!/\/ws$/.test(base)) base += '/ws';
    return `${base}?key=${encodeURIComponent(this.opts.key)}` + (resume ? `&resume=${encodeURIComponent(resume)}` : '');
  }

  _open(resume) {
    return new Promise((resolve, reject) => {
      const WS = this.opts.WebSocket || globalThis.WebSocket;
      const ws = new WS(this._url(resume));
      ws.binaryType = 'arraybuffer';
      let welcomed = false;
      const fail = () => {
        if (!welcomed) {
          welcomed = true;
          reject(new LobbiError('connect_failed', 'Could not reach the Lobbi server (check the url, key and allowed origins)'));
        }
      };
      ws.onerror = fail;
      ws.onclose = () => (welcomed && this._ws === ws ? this._onSocketClosed(ws) : fail());
      ws.onmessage = (ev) => {
        this._lastRx = Date.now();
        if (typeof ev.data !== 'string') return;
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!welcomed && m.t === 'welcome') {
          welcomed = true;
          this._ws = ws;
          this._onWelcome(m);
          resolve(m);
          return;
        }
        this._onMessage(m);
      };
    });
  }

  _onWelcome(m) {
    this.sessionId = m.sessionId;
    this._token = m.token;
    this.iceServers = m.ice;
    this._lastRx = Date.now();
    this._hb?.();
    this._hb = this._ticker.add(m.heartbeatMs || 10_000, () => {
      this._send({ t: 'ping', n: Date.now() });
      if (Date.now() - this._lastRx > (m.timeoutMs || 20_000)) {
        const ws = this._ws;
        try {
          ws?.close();
        } catch {}
        if (ws) this._onSocketClosed(ws);
      }
    });
    this._send({ t: 'hello', v: 1, sdk: VERSION, caps: detectCaps() });
  }

  _onSocketClosed(ws) {
    if (ws !== this._ws || ws._handled) return;
    ws._handled = true;
    this._ws = null;
    if (this._closed) return;
    this.emit('disconnected');
    this._reconnect();
  }

  async _reconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    this.emit('reconnecting');
    const deadline = Date.now() + RECONNECT_WINDOW_MS;
    let delay = 300;
    while (!this._closed && Date.now() < deadline) {
      try {
        const w = await this._open(this._token);
        this._reconnecting = false;
        if (!w.resumed && this.lobby) this._lobbyGone('connection-lost');
        this.emit('reconnected', { resumed: w.resumed });
        return;
      } catch {
        await sleep(delay);
        delay = Math.min(delay * 2, 2000);
      }
    }
    this._reconnecting = false;
    this._lobbyGone('connection-lost');
    this.emit('offline');
  }

  _lobbyGone(reason) {
    const l = this.lobby;
    this.lobby = null;
    l?._die(reason);
  }

  _send(obj) {
    if (this._ws?.readyState === 1) this._ws.send(JSON.stringify(obj));
  }

  _request(t, payload = {}) {
    return new Promise((resolve, reject) => {
      if (this._ws?.readyState !== 1) return reject(new LobbiError('offline', 'Not connected to the Lobbi server'));
      const id = ++this._seq;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new LobbiError('timeout', 'The Lobbi server did not respond'));
      }, 10_000);
      this._pending.set(id, { resolve, reject, timer });
      this._ws.send(JSON.stringify({ t, id, ...payload }));
    });
  }

  _onMessage(m) {
    if (m.re !== undefined && this._pending.has(m.re)) {
      const p = this._pending.get(m.re);
      this._pending.delete(m.re);
      clearTimeout(p.timer);
      if (m.t === 'error') p.reject(new LobbiError(m.code, m.msg));
      else p.resolve(m);
      return;
    }
    const lobby = this.lobby;
    switch (m.t) {
      case 'peerJoined':
        return lobby?._onPeerJoined(m.id);
      case 'peerLeft':
        return lobby?._onPeerLeft(m.id, m.reason);
      case 'signal':
        return lobby?._handleSignal(m.from, m.kind, m.data);
      case 'cap':
        if (lobby) {
          lobby.max = m.max;
          lobby.emit('cap', m.max);
        }
        return;
      case 'meta':
        if (lobby) {
          lobby.meta = m.meta;
          lobby.emit('meta', m.meta);
        }
        return;
      case 'lobby': // snapshot after a resumed connection
        if (lobby) lobby._applySnapshot(m);
        return;
      case 'lobbyClosed':
        return this._lobbyGone(m.reason);
      case 'kicked':
        if (lobby) lobby.emit('kicked', m.reason);
        return this._lobbyGone(m.reason);
      case 'ice': // relay credentials pushed to the host when the first player joins
        return lobby?._setIce(m.ice);
      case 'needProbe':
        return this._probe();
      case 'error':
        return this.emit('error', new LobbiError(m.code, m.msg));
      default:
    }
  }

  _probe() {
    if (this._probed || this._ws?.readyState !== 1) return;
    this._probed = true;
    this._send({ t: 'probeStart' });
    this._ws.send(new Uint8Array(PROBE_BYTES));
  }
}

export default Lobbi;
