#!/usr/bin/env node

const http = require('http');
const net = require('net');
const { Buffer } = require('buffer');
const { WebSocket, createWebSocketStream } = require('ws');

// ================= 环境与参数 =================
// 强烈建议在 Apply.Build 后台环境变量中设置自定义 UUID
const UUID = process.env.UUID || '5efabea4-f6d4-91fd-b8f0-17e004c89c60';
const DOMAIN = process.env.DOMAIN || 'your-app-name.apply.build'; 
const PORT = process.env.PORT || 8080;

// 伪装的业务通信路径，客户端填这个
const WSPATH = process.env.WSPATH || '/api/v1/telemetry/stream';

// 提取 UUID 的纯数字母部分用于校验
const uuidClean = UUID.replace(/-/g, "").toLowerCase();

// ================= HTTP 深度伪装服务 =================
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || DOMAIN}`);
  
  // 1. 探针伪装：PaaS 平台的存活检测通常会访问这些路径
  if (url.pathname === '/' || url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: "UP", 
      service: "telemetry-gateway", 
      timestamp: Date.now(),
      uptime: process.uptime()
    }));
    return;
  }

  // 2. 隐藏的节点信息获取路径： /config/你的UUID前8位
  // 例如：/config/5efabea4
  const secretConfigPath = `/config/${UUID.slice(0, 8)}`;
  if (url.pathname === secretConfigPath) {
    const vlsURL = `vless://${UUID}@${DOMAIN}:443?encryption=none&security=tls&sni=${DOMAIN}&fp=chrome&type=ws&host=${DOMAIN}&path=${encodeURIComponent(WSPATH)}#ApplyBuild-VLESS`;
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(Buffer.from(vlsURL).toString('base64'));
    return;
  }

  // 3. 其他所有未知请求，统一返回 404，模拟正常的严格 API
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: "Not Found", code: 404 }));
});

// ================= VLESS 核心代理逻辑 =================
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  // 严格校验路径，只有访问伪装路径才允许升级为 WS，防止主动探测
  const reqUrl = (req.url || '').split('?')[0];
  if (reqUrl !== WSPATH) {
    ws.close(1008, 'Policy Violation');
    return;
  }

  ws.once('message', (msg) => {
    try {
      const data = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      // VLESS 首包最少 22 字节校验
      if (data.length < 22 || data[0] !== 0) return ws.close();

      // 校验 UUID
      const id = data.slice(1, 17);
      if (!id.every((v, i) => v === parseInt(uuidClean.substr(i * 2, 2), 16))) {
        return ws.close();
      }

      // 解析 VLESS 协议头部
      let offset = 17;
      offset += data[offset] + 1; // 跳过 optLength
      
      const cmd = data[offset++];
      if (cmd !== 1) return ws.close(); // 只支持 TCP 转发 (0x01)

      const port = data.readUInt16BE(offset);
      offset += 2;

      const atyp = data[offset++];
      let host = '';

      // 解析目标地址
      if (atyp === 1) {
        host = data.slice(offset, offset + 4).join('.');
        offset += 4;
      } else if (atyp === 2) {
        const hostLen = data[offset++];
        host = data.slice(offset, offset + hostLen).toString('utf8');
        offset += hostLen;
      } else if (atyp === 3) {
        let ipv6 = [];
        for (let i = 0; i < 8; i++) ipv6.push(data.readUInt16BE(offset + i * 2).toString(16));
        host = ipv6.join(':');
        offset += 16;
      } else {
        return ws.close();
      }

      // 发送握手响应
      ws.send(new Uint8Array([data[0], 0]));

      // 提取客户端首发数据
      const payload = data.slice(offset);

      // 建立目标连接
      const duplex = createWebSocketStream(ws);
      const tcp = net.connect({ host, port }, () => {
        if (payload.length > 0) tcp.write(payload);
        duplex.pipe(tcp).pipe(duplex);
      });

      // 异常拦截：防止网络波动导致 Node 进程崩溃
      tcp.on('error', () => ws.close());
      tcp.on('close', () => ws.close());
      duplex.on('error', () => tcp.destroy());

    } catch (err) {
      ws.close(); // 遇到任何解析错误，静默断开
    }
  });
});

// 绑定 0.0.0.0，启动服务
server.listen(PORT, '0.0.0.0', () => {
  // 伪装的启动日志
  console.log(`[INFO] Telemetry Core initialized on port ${PORT}`);
  console.log(`[INFO] Database connection: OK`);
  console.log(`[INFO] Ready to receive telemetry data streams`);
});
