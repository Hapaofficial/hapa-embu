#!/usr/bin/env node
// One-off, local-only migration: moves legacy base64 documents embedded in
// upgrade_applications.details into the secure private-document pipeline
// (sanitized via sharp, stored via the storage provider, metadata row created)
// and removes the base64 payloads from details. Sensitive text fields are also
// moved into the encrypted sensitive_details envelope.
//
// SAFETY:
//   • NEVER runs automatically. Requires explicit --confirm flag.
//   • Refuses to run in production or against any non-local database
//     (only host "helium" / DATABASE_URL, never RENDER_DATABASE_URL).
//   • Idempotent: applications without base64/sensitive plaintext are skipped.
//
// Usage: node scripts/migrate-legacy-documents.js [--dry-run] --confirm
const {Pool}=require('pg');
const crypto=require('crypto');
const docStorage=require('../lib/documentStorage');
const fieldCrypto=require('../lib/fieldCrypto');
const {sanitizeImage}=require('../lib/imagePipeline');

const CONFIRM=process.argv.includes('--confirm');
const DRY=process.argv.includes('--dry-run');
const SENSITIVE=['nationalId','drivingLicenceNumber','psvLicenceNumber','insurancePolicyNumber','businessRegNumber','kraPin'];

(async()=>{
 if(process.env.NODE_ENV==='production'){console.error('Refusing to run in production.');process.exit(1);}
 const url=process.env.DATABASE_URL||'';
 if(!url){console.error('DATABASE_URL is not set. Aborting.');process.exit(1);}
 let host='';try{host=new URL(url).hostname;}catch(e){console.error('Unparseable DATABASE_URL. Aborting.');process.exit(1);}
 const allowed=['helium','localhost','127.0.0.1'];
 if(!allowed.includes(host)){console.error(`Refusing: DATABASE_URL host "${host}" is not a local database (allowed: ${allowed.join(', ')}).`);process.exit(1);}
 if(!CONFIRM&&!DRY){console.error('Add --dry-run to preview or --confirm to migrate. Nothing done.');process.exit(1);}
 if(!fieldCrypto.available()){console.error('DOCUMENT_ENCRYPTION_KEY not configured. Aborting.');process.exit(1);}
 const pool=new Pool({connectionString:url});
 const report={apps:0,docsMigrated:0,docsFailed:0,sensitiveMoved:0,skipped:0};
 try{
  const apps=(await pool.query(`SELECT id,user_id,type,details,sensitive_details FROM upgrade_applications ORDER BY created_at`)).rows;
  for(const a of apps){
   const det=a.details||{};
   const b64Keys=Object.keys(det).filter(k=>typeof det[k]==='string'&&det[k].startsWith('data:'));
   const sensKeys=Object.keys(det).filter(k=>SENSITIVE.includes(k)&&String(det[k]??'').trim()!=='');
   if(!b64Keys.length&&!sensKeys.length){report.skipped++;continue;}
   report.apps++;
   console.log(`Application ${a.id} (${a.type}): ${b64Keys.length} embedded doc(s), ${sensKeys.length} sensitive field(s)`);
   if(DRY&&!CONFIRM)continue;
   const newDet={...det};
   for(const k of b64Keys){
    try{
     const b64=det[k].split(',')[1]||'';
     const img=await sanitizeImage(Buffer.from(b64,'base64'));
     const docId=crypto.randomUUID();
     const objectKey=`upgrades/${a.user_id}/${a.id}/${docId}.jpg`;
     await docStorage.putObject(objectKey,img.buffer,img.mimeType);
     await pool.query(`INSERT INTO private_documents(id,user_id,upgrade_application_id,application_type,document_type,storage_provider,object_key,mime_type,size_bytes,width,height,sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [docId,a.user_id,a.id,a.type,k,docStorage.MODE,objectKey,img.mimeType,img.sizeBytes,img.width,img.height,img.sha256]);
     await pool.query(`INSERT INTO document_access_log(document_id,actor_id,action,ip_address,user_agent) VALUES($1,$2,'upload','migration','migrate-legacy-documents')`,[docId,a.user_id]);
     delete newDet[k];report.docsMigrated++;
    }catch(e){console.error(`  doc "${k}" failed: ${e.message}`);report.docsFailed++;}
   }
   let env=a.sensitive_details;
   if(sensKeys.length){
    let prev={};try{prev=env?fieldCrypto.decryptFields(env):{};}catch(e){}
    const add={};sensKeys.forEach(k=>{add[k]=det[k];delete newDet[k];});
    env=fieldCrypto.encryptFields({...prev,...add});
    report.sensitiveMoved+=sensKeys.length;
   }
   await pool.query(`UPDATE upgrade_applications SET details=$2,sensitive_details=$3,updated_at=NOW() WHERE id=$1`,[a.id,newDet,env]);
  }
  console.log('\nMigration report:',JSON.stringify(report,null,1));
 }finally{await pool.end();}
})().catch(e=>{console.error(e);process.exit(1);});
