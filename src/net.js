// Networking (PLAN.md A1-A4). Star topology over PeerJS: the host owns the room id
// `hunty-watch-party-<CODE>` and fans every message out to all guests; guests only
// ever talk to the host. Emits net:status / net:message / net:roster on HWP.bus.
(() => {
  if (!window.HWP || HWP.net) return;

  const PREFIX = 'hunty-watch-party-';
  const HOST_ID_RETRIES = 5;          // A3: re-claim our id after a reload
  const HOST_ID_RETRY_MS = 2000;
  const RETRY_MS = 3000;              // A2: guest reconnect cadence
  const RECONNECT_WINDOW_MS = 2 * 60 * 1000;
  const ATTEMPT_TIMEOUT_MS = 15000;   // one connect attempt that never opens
  const SIGNAL_RETRY_MS = 2000;       // re-attach to the signaling server
  const MAX_MSG_CHARS = 10 * 1024;
  // Only the host may originate these. A guest sending one is dropped, never relayed.
  const HOST_ONLY = new Set(['welcome', 'roster', 'control', 'end']);
  // Host-only concerns: emitted on the host's bus but not forwarded to other guests.
  const NO_RELAY = new Set(['hello', 'sync-request']);

  const S = HWP.state;
  const bus = HWP.bus;
  let role = null, code = null, lastCode = null;
  let peer = null, peerOpened = false;
  const guests = new Map();   // host: guest peerId -> { conn, name }
  let hostConn = null;        // guest: link to the host (pending or open)
  let everConnected = false;  // guest: true => a dropped link means "reconnect", not "fail"
  let lostAt = 0;             // guest: when the host link dropped
  let hostTries = 0;
  const timers = {};
  let lastStatus = { state: 'idle', code: null, peerCount: 0 };

  // ---------- helpers ----------
  function later(key, ms, fn) { stop(key); timers[key] = setTimeout(() => { timers[key] = null; fn(); }, ms); }
  function stop(key) { clearTimeout(timers[key]); timers[key] = null; }
  function session(op) { try { if (HWP.session) HWP.session[op](); } catch (_) {} }
  const normCode = (c) => String(c == null ? '' : c).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cleanName = (n) => (typeof n === 'string' ? n.trim().slice(0, 40) : '') || 'Someone';
  const myName = () => cleanName(S.name);
  const stamp = (msg) => Object.assign({}, msg, { from: myName(), sentAt: Date.now() });

  function rawSend(conn, msg) {
    if (!conn || !conn.open) return false;
    try { conn.send(msg); return true; } catch (e) { HWP.log('send failed', e); return false; }
  }
  // Untrusted input from another browser: must be a plain object with a string type, <=10KB.
  function clean(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.type !== 'string') return null;
    try { if (JSON.stringify(raw).length > MAX_MSG_CHARS) return null; } catch (_) { return null; }
    return raw;
  }
  // Live direct links: host = open guest links, guest = 1 while linked to the host.
  function peerCount() {
    if (role === 'host') { let n = 0; for (const g of guests.values()) if (g.conn.open) n++; return n; }
    return hostConn && hostConn.open ? 1 : 0;
  }
  function status(state, message) {
    S.connected = peerCount() > 0;
    lastStatus = { state, message, code: code || lastCode, peerCount: peerCount() };
    bus.emit('net:status', Object.assign({}, lastStatus));
  }
  function setPeerNames(names) {
    S.peerNames = names;
    bus.emit('net:roster', { names: names.slice() });
  }
  function setControl(mode) { if (mode === 'everyone' || mode === 'host') S.controlMode = mode; }

  function friendly(type) {
    switch (type) {
      case 'unavailable-id': return 'That party code is already in use. Start a new party.';
      case 'peer-unavailable': return 'No party with that code. Check the code and make sure the host pressed Start.';
      case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
        return 'Could not reach the connection server. Check your internet and try again.';
      case 'browser-incompatible': return 'This browser cannot run a watch party. Try the latest Chrome.';
      case 'webrtc': return 'Could not open a direct connection. Try again, or try another network.';
      default: return 'Connection error' + (type ? ' (' + type + ')' : '') + '. Try again.';
    }
  }

  // ---------- teardown ----------
  // Drop every link and timer. Late PeerJS callbacks from the old peer/conns are
  // ignored because every handler checks it still belongs to the current session.
  function teardown(graceMs) {
    for (const k in timers) stop(k);
    const p = peer;
    const conns = [...guests.values()].map((g) => g.conn).concat(hostConn || []);
    peer = null; peerOpened = false; hostConn = null; guests.clear();
    role = null; code = null; everConnected = false; lostAt = 0;
    S.role = null; S.code = null; S.connected = false;
    if (S.peerNames && S.peerNames.length) setPeerNames([]);
    const kill = () => {
      for (const c of conns) { try { c.close(); } catch (_) {} }
      if (p) { try { p.destroy(); } catch (_) {} }
    };
    if (graceMs) setTimeout(kill, graceMs); else kill();
  }
  function fail(message) {
    const c = code;
    teardown();
    session('clear');
    lastCode = c;
    status('error', message);
  }

  // ---------- peer (shared by both roles) ----------
  function makePeer(id) {
    const opts = { debug: 1 };
    const p = id ? new Peer(id, opts) : new Peer(opts);
    peer = p; peerOpened = false;
    p.on('error', (e) => onPeerError(p, e));
    // Signaling socket dropped (wifi blip, server restart). Open P2P links keep
    // working; signaling is only needed for new joins, so re-attach quietly.
    p.on('disconnected', () => {
      if (p !== peer) return;
      later('signal', SIGNAL_RETRY_MS, () => {
        if (p === peer && p.disconnected && !p.destroyed) { try { p.reconnect(); } catch (_) {} }
      });
    });
    return p;
  }

  function onPeerError(p, e) {
    if (p !== peer) return;
    const type = (e && e.type) || '';
    HWP.log('peer error', type, e && e.message);
    if (role === 'host') {
      if (type === 'unavailable-id' && !peerOpened) {
        // Usually our own pre-reload page still holds the id for a moment.
        peer = null;
        try { p.destroy(); } catch (_) {}
        if (hostTries++ < HOST_ID_RETRIES) {
          status('hosting', 'Reclaiming your party code...');
          later('hostId', HOST_ID_RETRY_MS, startHostPeer);
        } else fail(friendly(type));
        return;
      }
      // Once live, signaling hiccups or one guest's failed handshake never end the party.
      if (peerOpened || type === 'peer-unavailable' || type === 'webrtc') return;
      return fail(friendly(type));
    }
    if (role === 'guest') {
      // PeerJS reports "host not there" on the Peer, not the conn, and leaves the conn pending.
      if (type === 'peer-unavailable' || type === 'webrtc') {
        if (hostConn) { if (everConnected) linkLost(hostConn); else fail(friendly(type)); }
        return;
      }
      if (!peerOpened) fail(friendly(type));
    }
  }

  // ---------- host ----------
  function host(c) {
    const next = normCode(c);
    if (!next) return status('error', 'Missing party code.');
    teardown();
    role = 'host'; code = next; lastCode = next; hostTries = 0;
    S.role = role; S.code = code;
    session('save');
    startHostPeer();
  }

  function startHostPeer() {
    if (role !== 'host') return;
    const p = makePeer(PREFIX + code);
    if (!hostTries) hostStatus();
    p.on('open', () => { if (p !== peer) return; peerOpened = true; hostStatus(); });
    p.on('connection', (conn) => {
      if (p !== peer) { try { conn.close(); } catch (_) {} return; }
      conn.on('open', () => {
        if (p !== peer) { try { conn.close(); } catch (_) {} return; }
        // Same guest peer reconnecting: replace its old link (old close is then ignored).
        const old = guests.get(conn.peer);
        guests.delete(conn.peer);
        guests.set(conn.peer, { conn, name: null });
        if (old && old.conn !== conn) { try { old.conn.close(); } catch (_) {} }
        hostStatus();
      });
      conn.on('data', (d) => onHostData(conn, d));
      conn.on('close', () => dropGuest(conn));
      conn.on('error', () => { if (!conn.open) dropGuest(conn); }); // open-link errors are followed by 'close'
    });
  }

  function hostStatus() {
    if (!peerOpened) status('hosting', 'Starting your party...');
    else if (peerCount() > 0) status('connected');
    else status('hosting', 'Waiting for people to join...');
  }

  function dropGuest(conn) {
    const g = guests.get(conn.peer);
    if (role !== 'host' || !g || g.conn !== conn) return;
    guests.delete(conn.peer);
    try { conn.close(); } catch (_) {}
    if (g.name) broadcastRoster();
    hostStatus();
  }

  function allNames() {
    const names = [myName()];
    for (const g of guests.values()) if (g.name && g.conn.open) names.push(g.name);
    return names;
  }

  function broadcastRoster() {
    const names = allNames();
    const msg = stamp({ type: 'roster', names });
    for (const g of guests.values()) rawSend(g.conn, msg);
    setPeerNames(names.slice(1)); // host is always first
  }

  function onHostData(conn, raw) {
    const g = guests.get(conn.peer);
    if (role !== 'host' || !g || g.conn !== conn) return;
    const msg = clean(raw);
    if (!msg || HOST_ONLY.has(msg.type)) return;
    if (msg.type === 'hello') {
      g.name = cleanName(msg.name);
      rawSend(conn, stamp({ type: 'welcome', names: allNames(), controlMode: S.controlMode }));
      broadcastRoster();
    } else if (!NO_RELAY.has(msg.type)) {
      // Relay unchanged (original from/sentAt) to everyone except the sender.
      for (const o of guests.values()) if (o.conn !== conn) rawSend(o.conn, msg);
    }
    bus.emit('net:message', msg, conn.peer);
  }

  // ---------- guest ----------
  function join(c) {
    const next = normCode(c);
    if (!next) return status('error', 'Enter a party code.');
    const prev = HWP.session && HWP.session.load ? HWP.session.load() : null;
    teardown();
    role = 'guest'; code = next; lastCode = next;
    S.role = role; S.code = code;
    // Rejoining after our own reload: be patient, the host may be reloading too.
    everConnected = !!(prev && prev.role === 'guest' && prev.code === next);
    session('save');
    status('joining', 'Joining ' + code + '...');
    const p = makePeer(null);
    p.on('open', () => {
      if (p !== peer) return;
      peerOpened = true;
      if (!hostConn && !timers.retry) attempt();
    });
  }

  // One connect attempt at a time: a late "peer-unavailable" can't be matched to a
  // specific attempt, so overlapping attempts would kill each other.
  function attempt() {
    const p = peer;
    if (role !== 'guest' || !p || p.destroyed || hostConn) return;
    if (lostAt && Date.now() - lostAt > RECONNECT_WINDOW_MS) return fail('The host left the party.');
    if (!p.open) return later('retry', RETRY_MS, attempt); // signaling still re-attaching
    const c = p.connect(PREFIX + code, { reliable: true });
    if (!c) return later('retry', RETRY_MS, attempt);
    hostConn = c;
    later('attempt', ATTEMPT_TIMEOUT_MS, () => { if (c === hostConn && !c.open) linkLost(c); });
    c.on('open', () => {
      if (c !== hostConn) return;
      stop('attempt');
      everConnected = true; lostAt = 0;
      rawSend(c, stamp({ type: 'hello', name: myName() }));
      status('connected');
    });
    c.on('data', (d) => { if (c === hostConn) onGuestData(d, c.peer); });
    c.on('close', () => linkLost(c));
    c.on('error', () => { if (!c.open) linkLost(c); }); // open-link errors are followed by 'close'
    // ICE "disconnected" can hang ~30s before PeerJS gives up; cut it short.
    c.on('iceStateChanged', (s) => {
      if (s !== 'disconnected') return;
      later('ice', 5000, () => {
        const pc = c.peerConnection;
        if (c === hostConn && pc && pc.iceConnectionState === 'disconnected') linkLost(c);
      });
    });
  }

  function linkLost(c) {
    if (c !== hostConn) return;
    hostConn = null;
    stop('attempt'); stop('ice');
    try { c.close(); } catch (_) {}
    if (role !== 'guest') return;
    if (!everConnected) return fail('Could not connect to the party. Check the code and try again.');
    if (!lostAt) lostAt = Date.now();
    if (Date.now() - lostAt > RECONNECT_WINDOW_MS) return fail('The host left the party.');
    status('reconnecting', 'Lost the host. Reconnecting...');
    later('retry', RETRY_MS, attempt);
  }

  function onGuestData(raw, fromId) {
    const msg = clean(raw);
    if (!msg) return;
    if (msg.type === 'welcome' || msg.type === 'roster') {
      if (Array.isArray(msg.names)) {
        const list = msg.names.filter((n) => typeof n === 'string').map(cleanName);
        const i = list.indexOf(myName()); // drop ONE copy of us (two people may share a name)
        if (i >= 0) list.splice(i, 1);
        setPeerNames(list);
      }
      if (msg.type === 'welcome') setControl(msg.controlMode);
    } else if (msg.type === 'control') setControl(msg.mode);
    bus.emit('net:message', msg, fromId);
    if (msg.type === 'end') fail('The host ended the party.');
  }

  // ---------- leave / page lifecycle ----------
  function leave() {
    const tellGuests = role === 'host' && guests.size > 0;
    // Tell guests it's over so they don't sit in "reconnecting" for 2 minutes.
    if (tellGuests) for (const g of guests.values()) rawSend(g.conn, stamp({ type: 'end' }));
    teardown(tellGuests ? 400 : 0); // brief grace so "end" leaves before the links close
    session('clear');
    lastCode = null;
    status('idle');
  }

  // Close links on unload so peers notice at once instead of waiting on ICE timeouts.
  // The session stays saved, so main.js rejoins after a reload; a back/forward-cache
  // restore rejoins here.
  window.addEventListener('pagehide', () => { if (role) teardown(); });
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted || role || !HWP.session) return;
    const s = HWP.session.load();
    if (s && s.code) (s.role === 'host' ? host : join)(s.code);
  });

  HWP.net = {
    host,
    join,
    leave,
    // Stamps from/sentAt on a copy. Host -> all guests, guest -> host. Returns true if sent.
    send(msg) {
      if (!msg || typeof msg !== 'object') return false;
      const out = stamp(msg);
      if (role === 'host') { let n = 0; for (const g of guests.values()) if (rawSend(g.conn, out)) n++; return n > 0; }
      if (role === 'guest') return rawSend(hostConn, out);
      return false;
    },
    isConnected: () => peerCount() > 0,
    peerCount,
    status: () => Object.assign({}, lastStatus), // last net:status payload, for late subscribers
  };
})();
