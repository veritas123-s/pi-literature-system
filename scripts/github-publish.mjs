// Uses an existing credential only in memory. No authentication material is written.
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
const repo='pi-literature-system';
function git(args,input){const r=spawnSync('git',args,{input,encoding:'utf8',env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}});if(r.status!==0)throw new Error('Git operation failed: '+args[0]);return r.stdout;}
const response=git(['credential','fill'],'protocol=https\nhost=github.com\n\n');const credential=Object.fromEntries(response.trim().split('\n').map(line=>{const p=line.indexOf('=');return [line.slice(0,p),line.slice(p+1)];}));if(!credential.password)throw new Error('GitHub credential unavailable');
async function api(url,method='GET',body){const r=await fetch('https://api.github.com'+url,{method,headers:{Authorization:'Bearer '+credential.password,Accept:'application/vnd.github+json','User-Agent':'Pi-Literature-Setup','X-GitHub-Api-Version':'2022-11-28'},body:body?JSON.stringify(body):undefined});const text=await r.text();if(!r.ok)throw new Error('GitHub API '+r.status+' '+url);return text?JSON.parse(text):null;}
const user=await api('/user');if(user.login!=='veritas123-s')throw new Error('Unexpected GitHub owner');
let remote;try{remote=await api(`/repos/${user.login}/${repo}`);}catch(e){if(!String(e).includes('404'))throw e;remote=await api('/user/repos','POST',{name:repo,description:'Pi 医学与生命科学文献调研系统',private:false,auto_init:false});}
if(!existsSync('.git'))git(['init','-b','main']);
git(['add','package.json','package-lock.json','tsconfig.json','.gitignore','AGENTS.md','README.md','VALIDATION.md','config.example.json','src','web/src','web/index.html','web/vite.config.ts','web/README.md','test','scripts','docs','deploy','.github']);
const staged=git(['diff','--cached','--name-only']).trim().split('\n').filter(Boolean);if(staged.some(p=>/^(work|runtime|data|node_modules)\//.test(p)||/config\.local|\.env$|\.sqlite/.test(p)))throw new Error('Private runtime file in staged export');
if(staged.length)git(['-c','user.name=Zeus','-c','user.email=zeus@users.noreply.github.com','commit','-m','Implement Pi literature research system']);
if(!git(['remote']).split('\n').includes('origin'))git(['remote','add','origin',remote.clone_url]);
git(['push','-u','origin','main']);
try{await api(`/repos/${user.login}/${repo}/pages`);}catch(e){if(!String(e).includes('404'))throw e;await api(`/repos/${user.login}/${repo}/pages`,'POST',{build_type:'workflow'});}
try{await api(`/repos/${user.login}/${repo}/actions/variables/RESEARCH_API_URL`);}catch(e){if(!String(e).includes('404'))throw e;await api(`/repos/${user.login}/${repo}/actions/variables`,'POST',{name:'RESEARCH_API_URL',value:'https://122.51.44.155/literature'});}
await api(`/repos/${user.login}/${repo}/actions/workflows/pages.yml/dispatches`,'POST',{ref:'main'});
console.log(JSON.stringify({repository:remote.html_url,page:`https://${user.login}.github.io/${repo}/`,commit:git(['rev-parse','HEAD']).trim(),deployment:'dispatched'}));
