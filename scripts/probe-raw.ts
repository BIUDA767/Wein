const ws = new WebSocket("wss://api.derivws.com/trading/v1/options/ws/public");
let n = 0;
ws.onopen = () => {
  ws.send(JSON.stringify({ active_symbols: "brief", product_type: "basic", req_id: 1 }));
  ws.send(JSON.stringify({ ticks: "R_100", req_id: 2 }));
};
ws.onmessage = (e) => {
  const d = JSON.parse(String(e.data));
  n++;
  console.log(`#${n}`, JSON.stringify(d).slice(0, 320));
  if (n >= 2) process.exit(0);
};
setTimeout(() => process.exit(0), 10000);
