// 아주 작은 WebSocket 서버 구현 (외부 패키지 없이 Node 내장 모듈만 사용).
// RFC 6455의 핵심 부분(핸드셰이크, 텍스트 프레임 송수신, ping/pong, close)만 구현했다.
// 'ws' 라이브러리와 거의 같은 모양의 API(on('connection'), ws.send, ws.on('message'), ws.ping 등)를
// 제공해서, 서버 쪽 게임 로직 코드는 그대로 재사용할 수 있게 했다.

const crypto = require("crypto");
const { EventEmitter } = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function tryParseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0],
    b1 = buf[1];
  const fin = !!(b0 & 0x80);
  const opcode = b0 & 0x0f;
  const masked = !!(b1 & 0x80);
  let len = b1 & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }

  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.slice(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + len) return null;
  let payload = buf.slice(offset, offset + len);
  if (masked) {
    const unmasked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
    payload = unmasked;
  }
  return { fin, opcode, payload, total: offset + len };
}

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = WSConnection.OPEN;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];

    socket.on("data", (d) => this._handleData(d));
    socket.on("close", () => {
      this.readyState = WSConnection.CLOSED;
      this.emit("close");
    });
    socket.on("error", () => {
      try {
        socket.destroy();
      } catch (e) {}
    });
  }

  _handleData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (true) {
      let frame;
      try {
        frame = tryParseFrame(this._buffer);
      } catch (e) {
        this.terminate();
        return;
      }
      if (!frame) break;
      this._buffer = this._buffer.slice(frame.total);
      this._onFrame(frame);
    }
  }

  _onFrame(frame) {
    if (frame.opcode === 0x8) {
      this.close();
      return;
    }
    if (frame.opcode === 0x9) {
      this._sendFrame(0xa, frame.payload);
      return;
    }
    if (frame.opcode === 0xa) {
      this.emit("pong");
      return;
    }
    if (frame.opcode === 0x1 || frame.opcode === 0x2) {
      if (!frame.fin) {
        this._fragments = [frame.payload];
        return;
      }
      this.emit("message", frame.payload.toString("utf8"));
      return;
    }
    if (frame.opcode === 0x0) {
      this._fragments.push(frame.payload);
      if (frame.fin) {
        const full = Buffer.concat(this._fragments);
        this._fragments = [];
        this.emit("message", full.toString("utf8"));
      }
      return;
    }
  }

  send(data) {
    if (this.readyState !== WSConnection.OPEN) return;
    this._sendFrame(0x1, Buffer.from(String(data), "utf8"));
  }

  ping() {
    if (this.readyState !== WSConnection.OPEN) return;
    this._sendFrame(0x9, Buffer.alloc(0));
  }

  _sendFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (e) {}
  }

  close() {
    if (this.readyState === WSConnection.CLOSED) return;
    try {
      this._sendFrame(0x8, Buffer.alloc(0));
    } catch (e) {}
    this.readyState = WSConnection.CLOSED;
    try {
      this.socket.end();
    } catch (e) {}
    this.emit("close");
  }

  terminate() {
    this.readyState = WSConnection.CLOSED;
    try {
      this.socket.destroy();
    } catch (e) {}
  }
}
WSConnection.OPEN = 1;
WSConnection.CLOSED = 3;
WSConnection.prototype.OPEN = 1;
WSConnection.prototype.CLOSED = 3;

class WSServer extends EventEmitter {
  constructor(opts) {
    super();
    this.clients = new Set();
    this._attach(opts.server);
  }

  _attach(server) {
    server.on("upgrade", (req, socket, head) => {
      if ((req.headers["upgrade"] || "").toLowerCase() !== "websocket") {
        socket.destroy();
        return;
      }
      const key = req.headers["sec-websocket-key"];
      if (!key) {
        socket.destroy();
        return;
      }
      const accept = crypto
        .createHash("sha1")
        .update(key + GUID)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Accept: " +
          accept +
          "\r\n\r\n"
      );
      const conn = new WSConnection(socket);
      this.clients.add(conn);
      conn.on("close", () => this.clients.delete(conn));
      this.emit("connection", conn, req);
      if (head && head.length) conn._handleData(head);
    });
  }
}

module.exports = { WSServer, WSConnection };
