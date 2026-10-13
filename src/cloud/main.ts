import {buildServer, type CloudConfig} from './server.js';
const env=process.env;
const config:CloudConfig={
  dataDir:env.CLOUD_DATA_DIR??'./data/cloud',host:env.CLOUD_HOST??'127.0.0.1',port:Number(env.CLOUD_PORT??8787),
  publicUrl:env.CLOUD_PUBLIC_URL,webUrl:env.CLOUD_WEB_URL,
  githubClientId:env.GITHUB_CLIENT_ID,githubClientSecret:env.GITHUB_CLIENT_SECRET,
  allowGithubLogins:(env.GITHUB_ALLOWED_LOGINS??'').split(',').map(x=>x.trim()).filter(Boolean),
  devAuth:env.CLOUD_DEV_AUTH==='true',devOwnerId:env.CLOUD_DEV_OWNER_ID,
  leaseMs:Number(env.CLOUD_LEASE_MS??60000),sessionMs:Number(env.CLOUD_SESSION_MS??3600000),
};
if(!Number.isSafeInteger(config.port)||config.port!<1||config.port!>65535)throw new Error('Invalid CLOUD_PORT');
if(config.host!=='127.0.0.1'&&config.host!=='localhost'&&config.host!=='::1'&&(!config.githubClientId||!config.githubClientSecret||!config.allowGithubLogins?.length))throw new Error('Public bind requires GitHub OAuth credentials and an allowlist');
const app=await buildServer(config);
await app.listen({host:config.host,port:config.port!});
console.log(`Pi literature cloud listening on ${config.host}:${config.port}`);
let closing=false;
for(const event of ['SIGTERM','SIGINT'] as const)process.on(event,()=>{if(closing)return;closing=true;void app.close().then(()=>process.exit(0));});
