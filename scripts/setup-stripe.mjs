/** Idempotent live catalog setup. Never creates a charge or subscription. */
import Stripe from 'stripe';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const accountId = 'acct_1UQElt24SyhXpvZG';
const deployment = 'prod:energetic-partridge-813';
const webhookUrl = 'https://energetic-partridge-813.convex.site/stripe/webhook';
const outputFile = '.env.stripe.billing';
const events = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed',
  'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.finalization_failed', 'customer.deleted'];
const catalog = [
  {plan:'starter',name:'AdChecked Starter',description:'One advertiser workspace, 5 publisher teams and 250 creative reviews per calendar month.',prices:[['month',59900],['year',599000]]},
  {plan:'growth',name:'AdChecked Growth',description:'One advertiser workspace, 25 publisher teams and 1,000 creative reviews per calendar month.',prices:[['month',199900],['year',1999000]]},
  {plan:'enterprise',name:'AdChecked Enterprise',description:'Advertiser software subscription with publisher and review allowances agreed with AdChecked. Starting monthly price; annual terms by agreement.',prices:[['month',449900]]},
];

function fail(message) { throw new Error(message); }
function save(values) { writeFileSync(outputFile, Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')+'\n', {mode:0o600}); chmodSync(outputFile, 0o600); }
async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!/^(sk|rk)_live_/.test(key ?? '')) fail('Provide the AdChecked live key in an ignored environment file, then use node --env-file=.env.stripe scripts/setup-stripe.mjs.');
  const stripe = new Stripe(key, {maxNetworkRetries:2,timeout:20000});
  const account = await stripe.accounts.retrieve();
  if (account.id !== accountId) fail('Wrong Stripe account. No changes made. Use AdChecked acct_1UQElt24SyhXpvZG.');
  const values = {STRIPE_SECRET_KEY:key, STRIPE_BILLING_MODE:'live'};
  if (existsSync(outputFile)) {
    for (const line of readFileSync(outputFile,'utf8').split('\n')) {
      const i=line.indexOf('=');
      if(i>0 && line.startsWith('STRIPE_') && !line.startsWith('STRIPE_SECRET_KEY=')) values[line.slice(0,i)]=line.slice(i+1);
    }
  }
  values.STRIPE_BILLING_MODE='live';
  const portalProducts=[];
  const productDirectory=await stripe.products.list({limit:100});
  if(productDirectory.has_more) fail('Product catalog needs explicit pagination before setup.');
  for(const entry of catalog) {
    const candidates=productDirectory.data.filter(p=>p.id===`adchecked_${entry.plan}` || p.name===entry.name);
    if(candidates.length>1) fail(`Duplicate product for ${entry.name}. Review before continuing.`);
    let product=candidates[0];
    const id=product?.id ?? `adchecked_${entry.plan}`;
    const definition={name:entry.name,description:entry.description,tax_code:'txcd_10103001',metadata:{adchecked_plan:entry.plan}};
    if(!product) product=await stripe.products.create({id,...definition},{idempotencyKey:`adchecked-product-${entry.plan}-v1`});
    else if(product.deleted || !product.active || (product.metadata.adchecked_plan && product.metadata.adchecked_plan!==entry.plan)) fail(`Unexpected product ${id}. Review before continuing.`);
    else product=await stripe.products.update(id,definition);
    const prices=[];
    for(const [interval,amount] of entry.prices) {
      const lookup=`adchecked_${entry.plan}_usd_${interval}_v1`;
      const matches=await stripe.prices.list({lookup_keys:[lookup],limit:2});
      if(matches.data.length>1) fail(`Multiple prices for ${lookup}`);
      let price=matches.data[0];
      if(!price) {
        const directory=await stripe.prices.list({product:id,active:true,limit:100});
        if(directory.has_more) fail(`Price directory for ${id} needs explicit pagination.`);
        const candidates=directory.data.filter(p=>p.unit_amount===amount && p.currency==='usd' && p.tax_behavior==='exclusive' && p.recurring?.interval===interval && p.recurring?.interval_count===1 && !p.lookup_key);
        if(candidates.length>1) fail(`Duplicate prices for ${lookup}. Review before continuing.`);
        if(candidates[0]) price=await stripe.prices.update(candidates[0].id,{lookup_key:lookup});
      }
      if(!price) price=await stripe.prices.create({product:id,lookup_key:lookup,currency:'usd',unit_amount:amount,tax_behavior:'exclusive',recurring:{interval},metadata:{adchecked_plan:entry.plan}}, {idempotencyKey:lookup});
      if(!price.active || !price.livemode || price.product!==id || price.unit_amount!==amount || price.currency!=='usd' || price.tax_behavior!=='exclusive' || price.recurring?.interval!==interval || price.recurring?.interval_count!==1) fail(`Price ${lookup} differs from the published offer. Review before continuing.`);
      prices.push(price.id);
      values[`STRIPE_PRICE_${entry.plan.toUpperCase()}_${interval.toUpperCase()}`]=price.id;
      console.log(`${entry.name}: USD ${amount/100}/${interval} (${price.id})`);
    }
    if(!product.default_price) await stripe.products.update(id,{default_price:prices[0]});
    if(entry.plan!=='enterprise') portalProducts.push({product:id,prices});
  }
  // Persist each new secret immediately so interrupted setup can be resumed.
  save(values);
  const endpoints=await stripe.webhookEndpoints.list({limit:100});
  if(endpoints.has_more) fail('Webhook directory needs explicit pagination before setup.');
  const matches=endpoints.data.filter(e=>e.url===webhookUrl);
  if(matches.length>1) fail('Duplicate AdChecked webhook endpoints need review.');
  let endpoint=matches[0];
  if(!endpoint) {
    endpoint=await stripe.webhookEndpoints.create({url:webhookUrl,enabled_events:events,api_version:Stripe.API_VERSION,description:'AdChecked subscription access synchronization',metadata:{application:'adchecked'}},{idempotencyKey:'adchecked-billing-webhook-v1'});
    values.STRIPE_WEBHOOK_SECRET=endpoint.secret;
    save(values);
  } else {
    if(!values.STRIPE_WEBHOOK_SECRET) fail('The webhook already exists. Save its signing secret as STRIPE_WEBHOOK_SECRET in .env.stripe.billing before resuming.');
    await stripe.webhookEndpoints.update(endpoint.id,{enabled_events:events,disabled:false});
  }
  const configs=await stripe.billingPortal.configurations.list({limit:100});
  if(configs.has_more) fail('Portal configuration directory needs explicit pagination.');
  const existing=configs.data.filter(c=>c.metadata?.application==='adchecked');
  if(existing.length>1) fail('Duplicate AdChecked portal configurations need review.');
  const configuration={name:'AdChecked billing',business_profile:{headline:'Manage your AdChecked subscription'},default_return_url:'https://app.adchecked.com/client/plan',metadata:{application:'adchecked'},features:{customer_update:{enabled:true,allowed_updates:['email','address','name']},invoice_history:{enabled:true},payment_method_update:{enabled:true},subscription_cancel:{enabled:true,mode:'at_period_end'},subscription_update:{enabled:true,default_allowed_updates:['price'],proration_behavior:'always_invoice',products:portalProducts}}};
  const portal=existing[0]?await stripe.billingPortal.configurations.update(existing[0].id,{...configuration,active:true}):await stripe.billingPortal.configurations.create(configuration,{idempotencyKey:'adchecked-billing-portal-v1'});
  values.STRIPE_PORTAL_CONFIGURATION=portal.id;
  save(values);
  if(process.argv.includes('--configure-convex')) {
    for(const [name,value] of Object.entries(values)) {
      const result=spawnSync('pnpm',['exec','convex','env','set',name],{env:{...process.env,CONVEX_DEPLOYMENT:deployment},input:value+'\n',encoding:'utf8'});
      if(result.status!==0) fail(`Could not configure ${name} in Convex. Credentials remain in the private ignored file.`);
      console.log(`Configured ${name} in production Convex.`);
    }
  }
  console.log(`Live catalog and portal ready. Account charges enabled: ${account.charges_enabled}; payouts enabled: ${account.payouts_enabled}.`);
  console.log(`Signing secret saved privately in ${outputFile}. Webhook: ${endpoint.id}. No payments were made.`);
}
main().catch(error=>{console.error(error.type ? `Stripe setup failed (${error.type}, ${error.code??'request_error'}). Inspect the account configuration; no provider body or credentials are logged.`:error.message);process.exitCode=1;});
