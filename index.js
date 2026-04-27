#!/usr/bin/env node
const http = require('http');
const { WebSocket, createWebSocketStream } = require('ws');
const net = require('net');
const { Buffer } = require('buffer')
const { TextDecoder } = require('util');

// 配置：建议在 Apply.Build 后台设置环境变量
const UUID = process.env.UUID || 'de04add9-5c68-6bab-950c-08cd5320df33';
const DOMAIN = process.env.DOMAIN || 'your-app.apply.build';
const PORT = process.env.PORT || 8080;
// 关键：指定一个隐蔽的 WS 路径
const WSPATH = '/api/v1/telemetry/stream'; 

const uuidClean = UUID.replace(/-/g, '');

// ==================== HTTP 服务：API 深度伪装 ====================
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // 1. 伪装成监控 API
  if (pathname === '/api/v1/status' || pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      load: (Math.random() * 2).toFixed(2), // 模拟动态负载
      uptime: Math.floor(process.uptime()),
      node_version: process.version
    }));
    return;
  }

  // 2. 伪装的“配置获取”接口（原订阅链接）
  // 访问方式：https://xxx.apply.build/api/v1/config?token=de04...
  if (pathname === '/api/v1/config' && url.searchParams.get('token') === UUID) {
    const sub = `vless://${UUID}@${DOMAIN}:443?encryption=none&security=tls&sni=${DOMAIN}&type=ws&host=${DOMAIN}&path=${encodeURIComponent(WSPATH)}#Apply-Build-Node`;
    const base64 = Buffer.from(sub).toString('base64');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(base64 + '\n');
    return;
  }

  // 3. 根目录：返回通用的 API 欢迎信息
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ service: "Telemetry Gateway", message: "Internal access only" }));
});

// ==================== VLESS 核心：指定 Path 运行 ====================
// 增加 path 配置，确保只有访问指定路径才触发代理逻辑
const wss = new WebSocket.Server({ server: httpServer, path: WSPATH });

wss.on('connection', (ws) => {
  ws.once('message', (msg) => {
    const data = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
    if (data.length < 18) return;

    const version = data[0];
    const uuidBytes = data.slice(1, 17);
    if (!uuidBytes.every((byte, i) => byte === parseInt(uuidClean.substr(i * 2, 2), 16))) return;

    let offset = 18; 
    const port = data.slice(offset, offset += 2).readUInt16BE(0);
    const atype = data[offset++];
    let host = '';

    if (atype === 1) host = data.slice(offset, offset += 4).join('.');
    else if (atype === 2) {
      const len = data[offset++];
      host = new TextDecoder().decode(data.slice(offset, offset += len));
    } else if (atype === 3) {
      host = data.slice(offset, offset += 16).reduce((s, b, i) => 
        i % 2 ? s + b.toString(16).padStart(2, '0') : s + (i ? ':' : '') + b.toString(16).padStart(2, '0'), ''
      );
    }

    ws.send(new Uint8Array([version, 0])); 

    const tcp = net.connect({ host, port }, () => {
      const wsStream = createWebSocketStream(ws);
      tcp.pipe(wsStream).pipe(tcp);
    });

    tcp.on('error', () => ws.close());
    ws.on('error', () => tcp.destroy());
  });
});

httpServer.listen(PORT, () => {
  console.log(`🚀 API Service deployed on port ${PORT}`);
});
