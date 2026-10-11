import path from 'node:path';
const integer=(name,fallback,min,max)=>{const v=Number(process.env[name]??fallback);if(!Number.isInteger(v)||v<min||v>max)throw Error(`Invalid ${name}`);return v;};
const secret=(name,min)=>{const v=process.env[name]?.trim();if(!v||v.length<min)throw Error(`Missing ${name}`);return v;};
const dataRoot=path.resolve(process.env.DATA_ROOT||'/app/data');
export const config=Object.freeze({
  port:integer('PORT',3003,1,65535),dataRoot,
  profileDir:path.join(dataRoot,'profile'),stateDir:path.join(dataRoot,'state'),
  uploadDir:path.join(dataRoot,'uploads'),downloadDir:path.join(dataRoot,'downloads'),logDir:path.join(dataRoot,'logs'),
  adminKey:secret('ADMIN_KEY',5),sessionSecret:secret('SESSION_SECRET',32),
  cookieSecure:process.env.COOKIE_SECURE==='true',
  chatgptUrl:process.env.CHATGPT_URL||'https://chatgpt.com/',
  upstreamProxy:process.env.UPSTREAM_PROXY==='none'?'':(process.env.UPSTREAM_PROXY||'http://127.0.0.1:7890'),
  publicHost:process.env.PUBLIC_HOST||'',
  challengePort:integer('CHALLENGE_PORT',8080,1,65535),
  acmeEnabled:process.env.ACME_ENABLED==='true',
  httpsRedirect:process.env.HTTPS_REDIRECT==='true',
  streamMaxFps:integer('STREAM_MAX_FPS',60,30,120),
  streamMaxWidth:integer('STREAM_MAX_WIDTH',8192,3840,8192),
  streamMaxHeight:integer('STREAM_MAX_HEIGHT',4320,2160,4320),
  viewportWidth:1280,viewportHeight:800,
  maxActiveSessions:integer('MAX_ACTIVE_SESSIONS',12,1,12),
  sessionIdleMinutes:integer('SESSION_IDLE_MINUTES',60,5,1440),
  maxUploadBytes:integer('MAX_UPLOAD_MB',500,1,2048)*1024*1024,
  downloadTtlMs:integer('DOWNLOAD_TTL_MINUTES',60,5,1440)*60000,
  logRetentionDays:integer('LOG_RETENTION_DAYS',7,1,365),
});
