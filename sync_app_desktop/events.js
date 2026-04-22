// events.js - Server-Sent Events broadcaster for backend→frontend signals.
//
// Used to push remote-originated changes from the sync engine down to the
// running TiddlyWiki in the browser, so it can update its in-memory wiki
// without a full page reload.
//
// Current event types:
//   delete  { title }   remote deletion detected by sync.js; the TW page
//                       should drop the tiddler from $tw.wiki.
//
// Why SSE (vs WebSocket): one-way, server→client is exactly what we need;
// it rides on vanilla HTTP (no upgrade handshake, no extra deps), and the
// browser's EventSource auto-reconnects on transient network errors.

const clients = new Set();

function attach(res) {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        // Disable proxy buffering so events flush immediately.
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    res.write(': connected\n\n');
    clients.add(res);

    // Heartbeat every 25s — keeps the connection alive through idle-timeout
    // proxies and lets us notice dead sockets promptly (write throws).
    const keepalive = setInterval(() => {
        try { res.write(': ping\n\n'); }
        catch (e) { cleanup(); }
    }, 25000);

    function cleanup() {
        clearInterval(keepalive);
        clients.delete(res);
    }
    res.on('close', cleanup);
    res.on('error', cleanup);
}

function broadcast(type, data) {
    if (!clients.size) return;
    const payload = 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
    for (const res of clients) {
        try { res.write(payload); }
        catch (e) { clients.delete(res); }
    }
}

function clientCount() {
    return clients.size;
}

module.exports = { attach, broadcast, clientCount };
