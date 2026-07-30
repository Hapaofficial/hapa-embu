// M-Pesa Daraja adapter — mock | sandbox | live.
// - mock: no credentials; simulates STK push + callback locally. Clearly
//   labelled; never used to claim a real payment happened.
// - sandbox/live: official Safaricom Daraja endpoints. Requires
//   MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY,
//   MPESA_CALLBACK_URL. Live additionally requires Owner authorization via the
//   compliance setting mpesa_live_authorized=true.
// No secrets are ever logged.
const crypto=require('crypto');

const MODE=()=>String(process.env.MPESA_MODE||'mock').toLowerCase();
const BASE={sandbox:'https://sandbox.safaricom.co.ke',live:'https://api.safaricom.co.ke'};

function configured(){
 return!!(process.env.MPESA_CONSUMER_KEY&&process.env.MPESA_CONSUMER_SECRET&&process.env.MPESA_SHORTCODE&&process.env.MPESA_PASSKEY&&process.env.MPESA_CALLBACK_URL);
}
function status(){
 const m=MODE();
 if(m==='mock')return{mode:'mock',ready:true,note:'Simulated payments only — no real money moves.'};
 return{mode:m,ready:configured(),note:configured()?'Daraja credentials configured':'Missing Daraja credentials (MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY, MPESA_CALLBACK_URL)'};
}

let tokenCache={t:null,exp:0};
async function accessToken(){
 if(tokenCache.t&&Date.now()<tokenCache.exp-60000)return tokenCache.t;
 const auth=Buffer.from(process.env.MPESA_CONSUMER_KEY+':'+process.env.MPESA_CONSUMER_SECRET).toString('base64');
 const r=await fetch(BASE[MODE()]+'/oauth/v1/generate?grant_type=client_credentials',{headers:{Authorization:'Basic '+auth}});
 if(!r.ok)throw new Error('Daraja auth failed ('+r.status+')');
 const d=await r.json();
 tokenCache={t:d.access_token,exp:Date.now()+Number(d.expires_in||3599)*1000};
 return tokenCache.t;
}

// Initiate an STK push. Returns {mode, checkoutRequestId, merchantRequestId}.
// In mock mode the caller receives a simulate() function to fire the callback.
async function stkPush({phone,amount,reference,description}){
 const m=MODE();
 if(m==='mock'){
  const checkoutRequestId='mock_ws_CO_'+crypto.randomBytes(10).toString('hex');
  return{mode:'mock',checkoutRequestId,merchantRequestId:'mock_'+crypto.randomBytes(6).toString('hex'),
   mockCallback:(success=true)=>({Body:{stkCallback:{MerchantRequestID:'mock',CheckoutRequestID:checkoutRequestId,
    ResultCode:success?0:1032,ResultDesc:success?'The service request is processed successfully.':'Request cancelled by user',
    CallbackMetadata:success?{Item:[{Name:'Amount',Value:Number(amount)},{Name:'MpesaReceiptNumber',Value:'MOCK'+crypto.randomBytes(4).toString('hex').toUpperCase()},{Name:'PhoneNumber',Value:Number(String(phone).replace(/\D/g,''))}]}:undefined}}})};
 }
 if(!configured())throw Object.assign(new Error('M-Pesa is not configured'),{statusCode:503});
 const ts=new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14);
 const password=Buffer.from(process.env.MPESA_SHORTCODE+process.env.MPESA_PASSKEY+ts).toString('base64');
 const r=await fetch(BASE[m]+'/mpesa/stkpush/v1/processrequest',{method:'POST',
  headers:{Authorization:'Bearer '+await accessToken(),'Content-Type':'application/json'},
  body:JSON.stringify({BusinessShortCode:process.env.MPESA_SHORTCODE,Password:password,Timestamp:ts,
   TransactionType:'CustomerPayBillOnline',Amount:Math.max(1,Math.round(Number(amount))),
   PartyA:String(phone).replace(/\D/g,''),PartyB:process.env.MPESA_SHORTCODE,PhoneNumber:String(phone).replace(/\D/g,''),
   CallBackURL:process.env.MPESA_CALLBACK_URL,AccountReference:String(reference).slice(0,12),TransactionDesc:String(description||'HAPA ride').slice(0,13)})});
 const d=await r.json().catch(()=>({}));
 if(!r.ok||String(d.ResponseCode)!=='0')throw Object.assign(new Error('STK push failed: '+(d.errorMessage||d.ResponseDescription||r.status)),{statusCode:502});
 return{mode:m,checkoutRequestId:d.CheckoutRequestID,merchantRequestId:d.MerchantRequestID};
}

// Parse a Daraja STK callback body into a normalized result.
function parseCallback(body){
 const cb=body&&body.Body&&body.Body.stkCallback;
 if(!cb||!cb.CheckoutRequestID)return null;
 const items=((cb.CallbackMetadata||{}).Item)||[];
 const get=n=>{const i=items.find(x=>x.Name===n);return i?i.Value:null;};
 return{checkoutRequestId:cb.CheckoutRequestID,resultCode:Number(cb.ResultCode),resultDesc:String(cb.ResultDesc||''),
  success:Number(cb.ResultCode)===0,receipt:get('MpesaReceiptNumber'),amount:get('Amount'),phone:get('PhoneNumber')};
}

module.exports={MODE,status,configured,stkPush,parseCallback};
