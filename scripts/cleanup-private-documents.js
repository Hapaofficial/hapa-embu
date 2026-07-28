#!/usr/bin/env node
// Retention cleanup for private documents.
//
// Retention model (documented, enforced only by this script — never automatic):
//   • active documents          — kept while the application exists (no retention_until)
//   • replaced/removed docs     — retention_until set to +30 days at transition time
//   • this script deletes stored FILES for replaced/removed documents whose
//     retention_until has passed, and marks the row file_purged via removed_at.
//   • database rows and document_access_log entries are NEVER deleted (audit trail).
//
// Usage:
//   npm run cleanup-private-documents            # dry run (default, prints plan)
//   npm run cleanup-private-documents -- --apply # actually delete stored files
//
// Safety: refuses to run when DATABASE_URL is unset. Never touches active documents.
const {Pool}=require('pg');
const docStorage=require('../lib/documentStorage');

const APPLY=process.argv.includes('--apply');

// Strict local-only guard: refuse anything that is not the local dev database.
function assertLocalDb(url){
 if(!url){console.error('DATABASE_URL is not set. Aborting.');process.exit(1);}
 if(process.env.NODE_ENV==='production'){console.error('Refusing to run in production.');process.exit(1);}
 let host='';try{host=new URL(url).hostname;}catch(e){console.error('Unparseable DATABASE_URL. Aborting.');process.exit(1);}
 const allowed=['helium','localhost','127.0.0.1'];
 if(!allowed.includes(host)){console.error(`Refusing: DATABASE_URL host "${host}" is not a local database (allowed: ${allowed.join(', ')}).`);process.exit(1);}
}

(async()=>{
 assertLocalDb(process.env.DATABASE_URL);
 const pool=new Pool({connectionString:process.env.DATABASE_URL});
 try{
  const r=await pool.query(`SELECT id,object_key,status,retention_until FROM private_documents
   WHERE status IN('replaced','removed') AND retention_until IS NOT NULL AND retention_until < NOW()
   ORDER BY retention_until ASC`);
  console.log(`Mode: ${APPLY?'APPLY':'DRY RUN'} | storage: ${docStorage.MODE}`);
  console.log(`${r.rowCount} document file(s) past retention.`);
  for(const d of r.rows){
   if(!APPLY){console.log(`[dry-run] would delete file for ${d.id} (${d.status}, retention ended ${d.retention_until.toISOString()})`);continue;}
   try{
    await docStorage.deleteObject(d.object_key);
    await pool.query(`UPDATE private_documents SET updated_at=NOW(),removed_at=COALESCE(removed_at,NOW()) WHERE id=$1`,[d.id]);
    console.log(`deleted file for ${d.id}`);
   }catch(e){console.error(`failed for ${d.id}: ${e.message}`);}
  }
  if(!APPLY&&r.rowCount)console.log('Re-run with --apply to delete these files. Rows and audit logs are kept.');
 }finally{await pool.end();}
})().catch(e=>{console.error(e);process.exit(1);});
