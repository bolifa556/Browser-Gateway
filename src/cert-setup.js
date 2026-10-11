import {config} from './config.js';
import {Logger} from './logger.js';
import {CertificateManager} from './tls.js';
const cert=new CertificateManager(config,new Logger(config.logDir,config.logRetentionDays));
await cert.start();
for(let i=0;i<300&&!cert.ready;i++)await new Promise(r=>setTimeout(r,1000));
await cert.stop();process.exit(cert.ready?0:1);
