import {readFileSync} from 'node:fs';
import path from 'node:path';
import type {WorkerConfig} from '../shared/types.ts';
import {ensureFinitePositive} from '../shared/util.ts';
export function loadConfig(file=process.env.PI_LITERATURE_CONFIG??'config.local.json'):WorkerConfig {
  const config=JSON.parse(readFileSync(file,'utf8')) as WorkerConfig;
  if(!config.dataDir||!config.modelProfiles||!Object.keys(config.modelProfiles).length)throw new Error('Worker dataDir and model profiles required');config.dataDir=path.resolve(path.dirname(file),config.dataDir);
  for(const [id,p] of Object.entries(config.modelProfiles)){if(!p.provider||!p.model)throw new Error('Model profile incomplete: '+id);for(const field of ['contextWindow','maxOutputTokens'] as const)ensureFinitePositive(p[field],field);if(p.provider!=='codex-cli'&&(!p.baseUrl||!p.apiKeyEnv||!process.env[p.apiKeyEnv]))throw new Error('Model API environment is not configured: '+id);}
  for(const field of ['maxTokens','maxRequests','maxMinutes'] as const)ensureFinitePositive(config.defaultBudget[field],field);config.maxConcurrency=Math.min(3,ensureFinitePositive(config.maxConcurrency??3,'maxConcurrency'));
  if(config.cloudUrl){const url=new URL(config.cloudUrl);if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Remote cloud requires HTTPS');}
  return config;
}
