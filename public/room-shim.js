// Gives the game the same "room" interface it uses on claude.ai, backed by this app's own WebSocket server.
(function () {
  'use strict';
  window.DUEL_APP = true;
  var id;
  try { id = sessionStorage.getItem('duel-id'); } catch (e) {}
  if (!id) { id = 'p' + Math.random().toString(36).slice(2, 10); try { sessionStorage.setItem('duel-id', id); } catch (e) {} }
  var ws = null, connected = false, rooms = {}, connHandlers = [], opening = false;

  function emitConn() { connHandlers.slice().forEach(function (fn) { try { fn(connected); } catch (e) {} }); }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function open() {
    if (opening) return;
    opening = true;
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws?id=' + encodeURIComponent(id));
    ws.onopen = function () {
      opening = false; connected = true;
      Object.keys(rooms).forEach(function (n) { send({ t: 'join', room: n }); });
      emitConn();
    };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      var r = rooms[m.room]; if (!r) return;
      if (m.t === 'msg') r.deliver(m); else if (m.t === 'peers') r.setPeers(m.peers);
    };
    ws.onclose = function () { opening = false; var was = connected; connected = false; if (was) emitConn(); setTimeout(open, 1500); };
    ws.onerror = function () { try { ws.close(); } catch (x) {} };
  }
  open();

  function mkPeer(p) { return { peer: p, sameTab: p === id, isMe: p === id, kind: 'viewer', guest: false, by: null, presence: {}, updatedAt: Date.now() }; }
  function makeRoom(name) {
    var handlers = {}, peerHandlers = [], peers = [], left = false;
    var r = {
      name: name,
      emit: function (topic, data) {
        if (left) return Promise.reject({ code: 'invalid_argument', message: 'left room' });
        if (JSON.stringify(data === undefined ? null : data).length > 4096) return Promise.reject({ code: 'invalid_argument', message: 'message too large' });
        send({ t: 'emit', room: name, topic: topic, data: data });
        return Promise.resolve();
      },
      on: function (topic, fn) {
        (handlers[topic] = handlers[topic] || []).push(fn);
        return function () { var a = handlers[topic] || [], i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
      },
      presence: function () { return Promise.resolve(); },
      peers: function () { return peers; },
      onPeers: function (fn) {
        peerHandlers.push(fn);
        setTimeout(function () { fn({ peers: peers, joined: peers, left: [], updated: [] }); }, 0);
        return function () { var i = peerHandlers.indexOf(fn); if (i >= 0) peerHandlers.splice(i, 1); };
      },
      connected: function () { return connected; },
      onConnection: function (fn) {
        connHandlers.push(fn);
        setTimeout(function () { fn(connected); }, 0);
        return function () { var i = connHandlers.indexOf(fn); if (i >= 0) connHandlers.splice(i, 1); };
      },
      leave: function () { left = true; send({ t: 'leave', room: name }); delete rooms[name]; return Promise.resolve(); },
      deliver: function (m) {
        var msg = mkPeer(m.peer); msg.topic = m.topic; msg.data = m.data;
        (handlers[m.topic] || []).slice().forEach(function (fn) { try { fn(msg); } catch (e) { console.error(e); } });
      },
      setPeers: function (ids) {
        var prev = peers.map(function (p) { return p.peer; });
        peers = ids.map(mkPeer);
        var joined = peers.filter(function (p) { return prev.indexOf(p.peer) < 0; });
        var gone = prev.filter(function (p) { return ids.indexOf(p) < 0; }).map(mkPeer);
        peerHandlers.slice().forEach(function (fn) { try { fn({ peers: peers, joined: joined, left: gone, updated: [] }); } catch (e) { console.error(e); } });
      }
    };
    return r;
  }
  function join(name) {
    return new Promise(function (resolve, reject) {
      var tries = 0;
      (function go() {
        if (connected) {
          var r = rooms[name] || (rooms[name] = makeRoom(name));
          send({ t: 'join', room: name });
          return resolve(r);
        }
        if (++tries > 40) return reject({ code: 'upstream_error', message: 'Cannot reach the game server' });
        setTimeout(go, 250);
      })();
    });
  }
  var api = { join: join, emit: function () { return Promise.resolve(); }, on: function () { return function () {}; }, peers: function () { return []; }, onPeers: function () { return function () {}; }, connected: function () { return connected; }, onConnection: function (fn) { connHandlers.push(fn); return function () {}; } };
  window.claude = { use: function (n) { return Promise.resolve(n === 'room' ? api : null); } };
})();
