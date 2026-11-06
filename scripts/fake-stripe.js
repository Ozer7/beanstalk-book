// A tiny stand-in for the parts of Stripe's API this app uses, for local tests
// only. No network, no key. `npm test` starts it.
import http from "node:http";

export function startFakeStripe(port) {
  const sessions = new Map();
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const f = new URLSearchParams(body);
      const send = (o, code = 200) => { res.writeHead(code, { "Content-Type": "application/json", "Request-Id": "req_fake" }); res.end(JSON.stringify(o)); };
      if (req.method === "POST" && req.url === "/v1/checkout/sessions") {
        const id = `cs_test_${++n}`;
        const s = { id, object: "checkout.session", url: `http://localhost:${port}/pay/${id}`, payment_status: "unpaid", status: "open", amount_total: Number(f.get("line_items[0][price_data][unit_amount]")), payment_intent: `pi_test_${n}` };
        sessions.set(id, s);
        return send(s);
      }
      let m = /^\/v1\/checkout\/sessions\/(.+)$/.exec(req.url);
      if (m) return sessions.has(m[1]) ? send(sessions.get(m[1])) : send({ error: { message: "no such session" } }, 404);
      m = /^\/pay\/(.+)$/.exec(req.url);
      if (m) { const s = sessions.get(m[1]); s.payment_status = "paid"; s.status = "complete"; return send({ ok: true }); }
      if (req.method === "POST" && req.url === "/v1/refunds") {
        if (f.get("metadata[fail]")) return send({ error: { message: "nope" } }, 400);
        return send({ id: `re_test_${++n}`, object: "refund", status: "succeeded", amount: Number(f.get("amount")), payment_intent: f.get("payment_intent") });
      }
      send({ error: { message: `not faked: ${req.url}` } }, 404);
    });
  });
  return new Promise((r) => server.listen(port, () => r({ server, pay: (id) => fetch(`http://localhost:${port}/pay/${id}`) })));
}
