// HAPA finance reconciliation alerts.
//
// Raised when monthly statement generation fails its loud reconciliation
// check (opening + period movements must equal closing). One alert per
// driver/period stays open while unresolved (DB partial-unique dedup);
// repeated failed attempts bump `attempts` and refresh the detail instead
// of creating duplicates.
//
// RESOLUTION POLICY (documented, tested):
//   When a later regeneration for the same driver/period succeeds, the
//   unresolved alert is AUTO-RESOLVED (`resolution='auto_resolved_by_successful_regeneration'`)
//   and the successful regeneration event is linked in the alert timeline.
//   The historical alert row and its full timeline are always kept.
//   Owners may also resolve/dismiss manually (audited) at any time.
//
// EXTERNAL NOTIFIER: an adapter stub only. It reports honestly whether a
// real provider is configured via FINANCE_ALERTS_ENABLED, FINANCE_ALERT_EMAIL
// and FINANCE_ALERT_WEBHOOK_ENABLED. No delivery is ever claimed unless a
// real provider is wired in. No secret values live in code.
//
// Alerts never contain passwords, JWTs, private documents, payment
// credentials or exact GPS coordinates — only accounting references/amounts.
'use strict';
const crypto=require('crypto');

const newCorrelationId=()=>'FA-'+crypto.randomBytes(6).toString('hex').toUpperCase();

// External notification adapter (stub — honest about non-configuration).
function notifierStatus(){
 const enabled=['1','true','yes','on'].includes(String(process.env.FINANCE_ALERTS_ENABLED||'').toLowerCase());
 const email=String(process.env.FINANCE_ALERT_EMAIL||'').trim();
 const webhook=['1','true','yes','on'].includes(String(process.env.FINANCE_ALERT_WEBHOOK_ENABLED||'').toLowerCase());
 return{
  enabled,
  channels:{email:email?'configured_env_only_no_provider_wired':'not_configured',webhook:webhook?'enabled_env_only_no_provider_wired':'not_configured'},
  note:'External delivery adapter stub: no email/Slack/SMS provider is wired. Nothing was sent externally.'
 };
}
async function notify(alert){ // returns an honest delivery report; never fakes success
 const st=notifierStatus();
 return{delivered:false,status:st.enabled?'no_provider_configured':'disabled',detail:st};
}

// Raise (or bump) the deduplicated alert for one driver/period.
// `q` may be a pool-level query fn — must NOT run inside the transaction that
// is being rolled back, or the alert itself would vanish.
async function raiseReconciliationAlert(q,{driverId,statementId,statementReference,periodYear,periodMonth,detail,isDrill}){
 const corr=newCorrelationId();
 const row=(await q(`INSERT INTO finance_alerts(alert_type,severity,status,driver_user_id,statement_id,statement_reference,driver_account_reference,period_year,period_month,correlation_id,detail,is_drill)
   VALUES('statement_reconciliation','critical','open',$1,$2,$3,$4,$5,$6,$7,$8,$9)
   ON CONFLICT (alert_type,driver_user_id,period_year,period_month) WHERE status IN('open','acknowledged','investigating')
   DO UPDATE SET attempts=finance_alerts.attempts+1,last_attempt_at=NOW(),updated_at=NOW(),
    detail=EXCLUDED.detail,statement_id=COALESCE(EXCLUDED.statement_id,finance_alerts.statement_id),
    statement_reference=COALESCE(EXCLUDED.statement_reference,finance_alerts.statement_reference)
   RETURNING *`,
  [driverId,statementId||null,statementReference||null,'DRV-'+String(driverId).slice(0,8).toUpperCase(),
   periodYear,periodMonth,corr,JSON.stringify(detail||{}),!!isDrill])).rows[0];
 const isNew=row.attempts===1;
 await q(`INSERT INTO finance_alert_events(alert_id,event,note,data) VALUES($1,$2,$3,$4)`,
  [row.id,isNew?'raised':'reattempt_failed',isNew?'Statement reconciliation failed':'Repeated generation attempt failed for the same unresolved imbalance',
   JSON.stringify({correlation_id:corr,attempt:row.attempts,detail:detail||{}})]);
 const delivery=await notify(row);
 await q(`INSERT INTO finance_alert_events(alert_id,event,note,data) VALUES($1,'external_notification',$2,$3)`,
  [row.id,delivery.delivered?'Delivered':'Not delivered: '+delivery.status,JSON.stringify(delivery)]);
 return{alert:row,correlationId:corr,delivery};
}

// Auto-resolve on successful regeneration for the same driver/period.
// Keeps history; links the successful statement in the timeline.
async function resolveOnSuccessfulRegeneration(q,{driverId,periodYear,periodMonth,statementId,statementReference}){
 const rows=(await q(`UPDATE finance_alerts SET status='resolved',resolved_at=NOW(),updated_at=NOW(),
   resolution='auto_resolved_by_successful_regeneration'
  WHERE alert_type='statement_reconciliation' AND driver_user_id=$1 AND period_year=$2 AND period_month=$3
   AND status IN('open','acknowledged','investigating') RETURNING id`,[driverId,periodYear,periodMonth])).rows;
 for(const r of rows)
  await q(`INSERT INTO finance_alert_events(alert_id,event,note,data) VALUES($1,'auto_resolved','A later statement regeneration reconciled successfully',$2)`,
   [r.id,JSON.stringify({statement_id:statementId||null,statement_reference:statementReference||null})]);
 return rows.length;
}

module.exports={raiseReconciliationAlert,resolveOnSuccessfulRegeneration,notify,notifierStatus,newCorrelationId};
