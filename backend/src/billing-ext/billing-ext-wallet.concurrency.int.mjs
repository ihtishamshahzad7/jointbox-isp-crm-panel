import { Client } from 'pg';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs'; import os from 'os';
const PGBIN='/usr/lib/postgresql/16/bin'; const WORK=fs.mkdtempSync(os.tmpdir()+'/d2-'); const PGDATA=WORK+'/data'; const SOCK=WORK+'/sock'; const PORT=55470;
fs.mkdirSync(PGDATA,{recursive:true}); fs.mkdirSync(SOCK,{recursive:true});
spawnSync('chown',['-R','postgres',WORK]);
const run=(c,a)=>spawnSync('sudo',['-u','postgres',PGBIN+'/'+c,...a],{stdio:'ignore'});
run('initdb',['-D',PGDATA,'-A','trust','-U','postgres']);
run('pg_ctl',['-D',PGDATA,'-o',`-p ${PORT} -k ${SOCK} -c listen_addresses=127.0.0.1 -c max_connections=400`,'-w','start']);
const url=`postgresql://postgres@127.0.0.1:${PORT}/postgres`;
const sql=async(q,p)=>{const c=new Client({connectionString:url});await c.connect();const r=await c.query(q,p);await c.end();return r;};
try{
  await sql('CREATE TABLE bal(id int primary key, balance double precision)');
  await sql('INSERT INTO bal VALUES (1,0)');
  // 200 concurrent atomic increments of +1 → expect 200
  const N=100;
  await Promise.all(Array.from({length:N},async()=>{
    const c=new Client({connectionString:url});await c.connect();
    await c.query('UPDATE bal SET balance = balance + 1 WHERE id=1'); await c.end();
  }));
  const atomic=(await sql('SELECT balance FROM bal WHERE id=1')).rows[0].balance;
  // Demonstrate the OLD read-modify-write race on a second row
  await sql('INSERT INTO bal VALUES (2,0)');
  await Promise.all(Array.from({length:N},async()=>{
    const c=new Client({connectionString:url});await c.connect();
    const cur=(await c.query('SELECT balance FROM bal WHERE id=2')).rows[0].balance;
    await c.query('UPDATE bal SET balance = $1 WHERE id=2',[cur+1]); await c.end();
  }));
  const rmw=(await sql('SELECT balance FROM bal WHERE id=2')).rows[0].balance;
  console.log(`atomic increment final = ${atomic} (expected ${N}) → ${atomic===N?'CORRECT':'WRONG'}`);
  console.log(`read-modify-write final = ${rmw} (expected ${N}) → ${rmw<N?'LOST UPDATES (demonstrates the bug the fix avoids)':'no race observed'}`);
}finally{ run('pg_ctl',['-D',PGDATA,'-m','immediate','stop']); fs.rmSync(WORK,{recursive:true,force:true}); }
