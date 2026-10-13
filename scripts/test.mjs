import {mkdirSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const temporary=path.resolve('work/tmp');mkdirSync(temporary,{recursive:true});
const files=readdirSync('test').filter(name=>name.endsWith('.test.ts')).map(name=>'test/'+name);
const result=spawnSync(process.execPath,['--import','tsx','--test',...files],{stdio:'inherit',env:{...process.env,TEMP:temporary,TMP:temporary},windowsHide:true});process.exit(result.status??1);
