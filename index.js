#!/usr/bin/env node
const http = require('http');
const net = require('net');
const { WebSocket, createWebSocketStream } = require('ws');

// ==================== 配置 ====================
const UUID = process.env.UUID || '5efabea4-f6d4-91fd-b8f0-17e004c89c60';
const DOMAIN = process.env.DOMAIN || 'your-app-name.apply.build';
const PORT = parseInt(process.env.PORT) || 8080;
const WSPATH = process.env.WSPATH || '/api/v1/telemetry/stream';
const DEBUG = process.env.DEBUG === 'true';   // 调试时在环境变量里设 DEBUG=true

const uuidClean = UUID.replace(/-/g, '').toLowerCase();
const expectedUUID = Buffer.from(uuidClean, 'hex');   // 用于快速 equals 校验

if (DEBUG) {
  console.log('[DEBUG] 配置加载完成', { DOMAIN, WSPATH, UUID_PREFIX: UUID.slice(0, 8) });
} else {
  console.log(`[INFO] 服务启动 | 端口: ${PORT} | 路径: ${WSPATH}`);
}

// ==================== HTTP 深度伪装 ====================
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || DOMAIN}`);

  // 平台健康检查
  if (url.pathname === '/' || url.pathname === '/api/health' || url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'UP',
      service: 'api-service-core',
      timestamp: Date.now(),
      uptime: process.uptime()
    }));
    return;
  }

  // 秘密配置路径（客户端通过这个获取节点信息）
  const secretConfigPath = `/config/${UUID.slice(0, 8)}`;
  if (url.pathname === secretConfigPath) {
    const vlessUrl = `vless://${UUID}@${DOMAIN}:443?encryption=none&security=tls&sni=${DOMAIN}&fp=chrome&type=ws&host=${DOMAIN}&path=${encodeURIComponent(WSPATH)}#ApplyBuild-VLESS`;
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(Buffer.from(vlessUrl).toString('base64'));
    if (DEBUG) console.log(`[DEBUG] 秘密配置已被访问`);
    return;
  }

  // 其他请求全部 404 伪装
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

// ==================== VLESS over WS 核心 ====================
const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false   // 关闭压缩，提升兼容性和性能
});

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress || 'unknown';
  const reqPath = (req.url || '').split('?')[0];

  if (DEBUG) console.log(`[WS] 新连接 | IP: ${clientIp} | 路径: ${reqPath}`);

  if (reqPath !== WSPATH) {
    if (DEBUG) console.log(`[WS] 路径不匹配，已拒绝`);
    ws.close(1008, 'Policy Violation');
    return;
  }

  ws.once('message', (msg) => {
    try {
      const data = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);

      if (data.length < 22 || data[0] !== 0x00) {
        if (DEBUG) console.log(`[VLESS] 握手失败 | 长度: ${data.length} | 版本: ${data[0]}`);
        return ws.close(1002);
      }

      // UUID 校验（更高效）
      const id = data.slice(1, 17);
      if (!id.equals(expectedUUID)) {
        if (DEBUG) console.log(`[VLESS] UUID 不匹配`);
        return ws.close(1002, 'Invalid UUID');
      }

      if (DEBUG) console.log(`[VLESS] 握手成功 | IP: ${clientIp}`);

      // 解析 VLESS 头部
      let offset = 17;
      offset += data[offset] + 1;           // 跳过 additional data

      const cmd = data[offset++];
      if (cmd !== 0x01) {                   // 只支持 TCP
        if (DEBUG) console.log(`[VLESS] 不支持的命令: ${cmd}`);
        return ws.close();
      }

      const port = data.readUInt16BE(offset);
      offset += 2;

      const atyp = data[offset++];
      let host = '';

      if (atyp === 0x01) {                  // IPv4
        host = data.slice(offset, offset + 4).join('.');
        offset += 4;
      } else if (atyp === 0x02) {           // Domain
        const len = data[offset++];
        host = data.slice(offset, offset + len).toString('utf8');
        offset += len;
      } else if (atyp === 0x03) {           // IPv6
        const parts = [];
        for (let i = 0; i < 8; i++) {
          parts.push(data.readUInt16BE(offset + i * 2).toString(16));
        }
        host = parts.join(':');
        offset += 16;
      } else {
        return ws.close();
      }

      if (DEBUG) console.log(`[VLESS] 目标: ${host}:${port}`);

      // VLESS 握手响应
      ws.send(Buffer.from([0x00, 0x00]));

      const payload = data.slice(offset);
      const duplex = createWebSocketStream(ws);

      const tcp = net.connect({ host, port }, () => {
        if (payload.length > 0) tcp.write(payload);
        duplex.pipe(tcp).pipe(duplex);
      });

      // 错误与关闭处理
      tcp.on('error', (err) => {
        if (DEBUG) console.error(`[TCP] 错误 ${host}:${port} →`, err.message);
        ws.close();
      });
      tcp.on('close', () => ws.close());
      duplex.on('error', () => tcp.destroy());
      ws.on('error', () => tcp.destroy());

    } catch (err) {
      if (DEBUG) console.error('[ERROR] 握手解析异常:', err.message);
      ws.close();
    }
  });

  // 额外事件监听
  ws.on('error', (err) => {
    if (DEBUG) console.error('[WS] 连接错误:', err.message);
  });
  ws.on('close', (code) => {
    if (DEBUG) console.log(`[WS] 连接关闭 | code: ${code}`);
  });
});

// ==================== 启动服务 ====================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[INFO] ✅ 服务已启动 | 监听 0.0.0.0:${PORT}`);
  console.log(`[INFO] 健康检查: / 或 /api/health`);
  console.log(`[INFO] 节点配置: /config/${UUID.slice(0, 8)}`);
  if (!process.env.UUID) console.warn('[WARN] 未设置自定义 UUID，请在 Apply.Build 后台设置！');
});

// 全局异常捕获（PaaS 防止进程直接崩溃）
process.on('uncaughtException', (err) => {
  console.error('[FATAL] 未捕获异常:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] 未处理的 Promise 拒绝:', reason);
});
