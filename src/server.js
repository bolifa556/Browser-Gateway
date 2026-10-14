import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { WebSocketServer } from 'ws';
import { BrowserManager } from './browser-manager.js';
import { config } from './config.js';
import { Logger } from './logger.js';
import { cookie, parseCookies, safeEqual, seal, sessionId, unseal } from './security.js';
import { installVisibilityLease } from './visibility-lease.js';
import { StateStore } from './state-store.js';
import {CertificateManager,createGateway} from './tls.js';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(sourceDirectory, '../public');
for (const directory of [
  config.dataRoot,
  config.profileDir,
  config.stateDir,
  config.uploadDir,
  config.downloadDir,
  config.logDir,
  path.join(config.dataRoot, 'home'),
  path.join(config.dataRoot, 'tmp'),
  path.join(config.dataRoot, 'cache'),
  path.join(config.dataRoot, 'config'),
]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

const logger = new Logger(config.logDir, config.logRetentionDays);
const stateStore = new StateStore(config.stateDir, logger);
const browserManager = new BrowserManager(config, stateStore, logger);
const certificates=new CertificateManager(config,logger);

const ROLE_COOKIE = 'gptw_role';
const SESSION_COOKIE = 'gptw_session';
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function readPrincipalFromCookieHeader(header, encrypted = false) {
  const cookies = parseCookies(header);
  const suffix = encrypted && cookies[`${SESSION_COOKIE}_https`] ? '_https' : '';
  const role = unseal(cookies[`${ROLE_COOKIE}${suffix}`], config.sessionSecret);
  const sid = unseal(cookies[`${SESSION_COOKIE}${suffix}`], config.sessionSecret);
  if (!sid || (role !== 'member' && role !== 'admin')) return null;
  return {
    role,
    sid,
    sessionKey: `${role}:${sid}`,
  };
}

function readPrincipal(request) {
  const principal = readPrincipalFromCookieHeader(request.headers.cookie || '', Boolean(request.socket.encrypted));
  if (!principal) return null;
  const tab = request.headers['x-gpt-tab'] || new URL(request.url, 'http://localhost').searchParams.get('tab');
  if (typeof tab === 'string' && /^[a-z0-9-]{8,80}$/i.test(tab)) principal.sessionKey += `:${tab}`;
  return principal;
}

function setAuthenticatedCookies(request, response, role) {
  const current = readPrincipal(request);
  const sid = current?.sid || sessionId();
  const suffix = request.socket.encrypted ? '_https' : '';
  const options = {
    maxAge: COOKIE_MAX_AGE_SECONDS,
    secure: config.cookieSecure || Boolean(request.socket.encrypted),
    sameSite: 'Strict',
    httpOnly: true,
  };
  response.setHeader('Set-Cookie', [
    cookie(`${ROLE_COOKIE}${suffix}`, seal(role, config.sessionSecret), options),
    cookie(`${SESSION_COOKIE}${suffix}`, seal(sid, config.sessionSecret), options),
  ]);
}

function requirePrincipal(request, response, next) {
  const principal = readPrincipal(request);
  if (!principal) return response.status(401).json({ error: 'Authentication required' });
  request.principal = principal;
  next();
}

function requireAdmin(request,response,next){
  const principal=readPrincipal(request);
  if(principal?.role!=='admin')return response.status(403).json({error:'管理员权限必需'});
  request.principal=principal;next();
}
function requireSameOrigin(request,response,next){
  try{if(new URL(request.headers.origin).host!==request.headers.host)throw Error();}
  catch{return response.status(403).json({error:'登录模式切换必须从本站管理员页面发起'});}
  if(!request.is('application/json'))return response.status(415).json({error:'JSON request required'});
  next();
}

function safeUploadFilename(value) {
  let decoded=String(value||'file');
  if([...decoded].every(c=>c.charCodeAt(0)<=255)){
    const utf8=Buffer.from(decoded,'latin1').toString('utf8');if(!utf8.includes('\ufffd'))decoded=utf8;
  }
  const cleaned = decoded
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 180)
    .trim();
  return cleaned || 'file';
}

const uploadStorage = multer.diskStorage({
  destination(request, _file, callback) {
    callback(null, request.uploadDirectory);
  },
  filename(request, file, callback) {
    request.uploadNameCounts ||= new Map();
    const original = safeUploadFilename(file.originalname);
    file.originalname = original;
    const count = (request.uploadNameCounts.get(original) || 0) + 1;
    request.uploadNameCounts.set(original, count);
    if (count === 1) return callback(null, original);
    const extension = path.extname(original);
    const stem = path.basename(original, extension);
    callback(null, `${stem}-${count}${extension}`);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: {
    files: 10,
    fileSize: config.maxUploadBytes,
    fields: 10,
  },
});

const app = express();
app.disable('x-powered-by');
app.use((request,response,next)=>{
  if(config.httpsRedirect&&certificates.ready&&!request.socket.encrypted&&request.path!=='/healthz'){
    response.redirect(308,`https://${config.publicHost}:${config.port}${request.originalUrl}`);return;
  }
  next();
});
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  next();
});
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use('/assets', express.static(publicDirectory, { index: false, maxAge: 0, immutable: false }));

app.get('/favicon.ico', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.redirect(302, '/assets/favicon.svg?v=1.3.9');
});

app.get('/healthz', (_request, response) => {
  response.json({ ok: true, browser: Boolean(browserManager.context||browserManager.nativeLogin&&!browserManager.nativeLogin.exited), mode:browserManager.mode, version: '1.4.2', transport: 'lossless-qoi' });
});

app.get('/', (request, response) => {
  const principal = readPrincipal(request);
  response.setHeader('Cache-Control', 'no-store');
  setAuthenticatedCookies(request, response, principal?.role || 'member');
  response.sendFile(path.join(publicDirectory, 'index.html'));
});

app.get('/admin', (request, response) => {
  const principal = readPrincipal(request);
  response.setHeader('Cache-Control', 'no-store');
  if (principal?.role !== 'admin') return response.sendFile(path.join(publicDirectory, 'admin-login.html'));
  response.sendFile(path.join(publicDirectory, 'index.html'));
});

app.get('/admin/signin',(request,response)=>{
  response.setHeader('Cache-Control','no-store');
  response.sendFile(path.join(publicDirectory,readPrincipal(request)?.role==='admin'?'native-login.html':'admin-login.html'));
});

app.post('/auth/admin', (request, response) => {
  if (!safeEqual(request.body?.code || '', config.adminKey)) {
    return response.redirect(`${request.body?.returnTo==='/admin/signin'?'/admin/signin':'/admin'}?error=1`);
  }
  setAuthenticatedCookies(request, response, 'admin');
  response.redirect(request.body?.returnTo==='/admin/signin'?'/admin/signin':'/admin');
});

app.get('/api/native-login',requireAdmin,(request,response)=>{
  response.setHeader('Cache-Control','no-store');
  response.json({mode:browserManager.mode,owned:browserManager.nativeLogin?.ownerSid===request.principal.sid,connected:Boolean(browserManager.nativeLogin?.clients.size)});
});
app.post('/api/native-login/start',requireAdmin,requireSameOrigin,express.json({limit:'2kb'}),async(request,response,next)=>{
  try{
    if(!request.headers['x-gpt-tab']||request.body?.confirm!==true)return response.status(400).json({error:'请在手动登录页确认开始'});
    const result=await browserManager.startNativeLogin(request.principal.sessionKey,request.principal.sid,request.body.viewport||{});
    response.json({ok:true,...result});
  }catch(error){next(error);}
});
app.post('/api/native-login/finish',requireAdmin,requireSameOrigin,express.json({limit:'2kb'}),async(request,response,next)=>{
  try{await browserManager.finishNativeLogin(request.principal.sid);response.json({ok:true,mode:browserManager.mode});}catch(error){next(error);}
});

app.post(
  '/api/upload',
  requirePrincipal,
  async (request, response, next) => {
    const sessionHash = crypto.createHash('sha256').update(request.principal.sessionKey).digest('hex').slice(0, 24);
    request.uploadDirectory = path.join(config.uploadDir, sessionHash, crypto.randomUUID());
    await fsp.mkdir(request.uploadDirectory, { recursive: true, mode: 0o700 });
    next();
  },
  upload.array('files', 10),
  async (request, response, next) => {
    try {
      const files = request.files || [];
      const method = await browserManager.applyUploadedFiles(
        request.principal.sessionKey,
        files,
        request.body?.chooserId || '',
        { x: request.body?.x, y: request.body?.y, mode: request.body?.mode },
      );
      response.json({ ok: true, method });
    } catch (error) {
      next(error);
    } finally {
      const directory = request.uploadDirectory;
      setTimeout(() => void fsp.rm(directory, { recursive: true, force: true }), 15*60_000).unref?.();
    }
  },
);

app.get('/api/download/:token', requirePrincipal, (request, response) => {
  const entry = browserManager.takeDownload(request.params.token, request.principal.sessionKey);
  if (!entry) return response.status(404).send('Download is unavailable or expired');
  response.download(entry.path, entry.filename, (error) => {
    void fsp.rm(entry.path, { force: true });
    if (error && !response.headersSent) response.status(500).end();
  });
});

app.use((error, request, response, _next) => {
  logger.warn('http_request_failed', {
    route: request.path,
    error,
  });
  if (request.uploadDirectory) {
    void fsp.rm(request.uploadDirectory, { recursive: true, force: true });
  }
  const status = error instanceof multer.MulterError ? 400 : 500;
  response.status(status).json({ error: error.message || 'Request failed' });
});

const gateway=createGateway(app,certificates,config),server=gateway.server;
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024,
  // Lossless QOI preserves text edges, but scrolling repeats large glyph/tile
  // patterns. Native WebSocket DEFLATE compresses those bytes without changing
  // pixels or making the WASM decoder/client input wait for another JS codec.
  perMessageDeflate:{threshold:1024,serverNoContextTakeover:false,clientNoContextTakeover:true,
    concurrencyLimit:16,zlibDeflateOptions:{level:6,memLevel:9},zlibInflateOptions:{chunkSize:64*1024}},
});
function upgrade(request, socket, head) {
  let pathname;
  try {
    pathname = new URL(request.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== '/ws' && pathname !== '/ws/login') {
    socket.destroy();
    return;
  }
  const principal = readPrincipal(request);
  if (!principal) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if(pathname==='/ws/login'&&principal.role!=='admin'){
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;
  }
  if(request.headers.origin){
    try{if(new URL(request.headers.origin).host!==request.headers.host){socket.destroy();return;}}catch{socket.destroy();return;}
  }
  request.principal = principal;
  request.nativeLogin=pathname==='/ws/login';
  websocketServer.handleUpgrade(request, socket, head, (websocket) => {
    websocketServer.emit('connection', websocket, request);
  });
}
gateway.plain.on('upgrade',upgrade);gateway.secure.on('upgrade',upgrade);

websocketServer.on('connection', (socket, request) => {
  const principal = request.principal;
  let session = null;
  installVisibilityLease(socket);
  socket.on('background-idle',()=>session?.removeClient(socket));
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  void Promise.resolve().then(()=>request.nativeLogin?browserManager.getNativeLogin(principal.sessionKey,principal.sid):browserManager.getOrCreateSession(principal.sessionKey, principal.role))
    .then(async(created) => {
      if(!request.nativeLogin&&socket.readyState===1&&created.clients.size){
        // A duplicated tab clones sessionStorage. A genuine reload's old socket
        // closes shortly; a still-live tab needs its own page and input target.
        await new Promise(resolve=>setTimeout(resolve,100));
        if(socket.readyState===1&&created.clients.size){
          const tab=crypto.randomUUID();
          stateStore.update(`${principal.role}:${principal.sid}:${tab}`,{lastUrl:created.page?.url()||config.chatgptUrl,role:principal.role});
          socket.send(JSON.stringify({type:'tab-conflict',tab}));socket.close(1008,'Duplicate tab');return;
        }
      }
      session = created;
      if(socket.readyState===1)created.addClient(socket);
    })
    .catch((error) => {
      if(browserManager.mode==='normal'||request.nativeLogin)logger.warn('websocket_session_failed', { role: principal.role, error });
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'fatal', message: error.message }));
        socket.close(1013, 'Session unavailable');
      }
    });

  socket.on('message', (message, isBinary) => {
    if (!isBinary && session) void session.handleMessage(message, socket);
  });
  socket.on('close', () => session?.removeClient(socket));
  socket.on('error', () => session?.removeClient(socket));
});

const heartbeat = setInterval(() => {
  for (const socket of websocketServer.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);
heartbeat.unref?.();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  browserManager.stopping=true;
  logger.info('shutdown_started', { signal });
  clearInterval(heartbeat);
  for(const socket of websocketServer.clients)socket.terminate();
  websocketServer.close();
  await gateway.close();
  await browserManager.stop();
  await certificates.stop();
  logger.info('shutdown_complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGUSR2', () => browserManager.diagnoseNetwork());
process.on('uncaughtException', (error) => {
  logger.error('uncaught_exception', { error });
  setTimeout(() => process.exit(1), 100).unref?.();
});
process.on('unhandledRejection', (error) => {
  logger.error('unhandled_rejection', { error });
});

try {
  await certificates.start();
  await gateway.start();
  await browserManager.start();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', resolve);
  });
  logger.info('server_listening', { port: config.port });
} catch (error) {
  logger.error('startup_failed', { error });
  await browserManager.stop().catch(() => {});
  process.exit(1);
}
