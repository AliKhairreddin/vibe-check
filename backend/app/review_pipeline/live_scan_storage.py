from __future__ import annotations

import hashlib
import json
import threading
import unicodedata
from pathlib import Path
from typing import Any, Literal

from .models import LiveScanDay, ResultStatus, normalize_result_status
from .storage import (
    JOB_DATA_DIR,
    _convex_call,
    convex_enabled,
    get_status,
    list_reviews,
    now_ms,
    read_json,
    write_json,
)

ReviewKind = Literal['creative','copy']
CLAIM_LEASE_MS = 15 * 60 * 1000
_local_lock=threading.Lock()


def exact_creative_key(value:str)->str:
    return value


def normalize_primary_text(value:str)->str:
    return ' '.join(unicodedata.normalize('NFKC', value).split()).strip()


def primary_text_key(value:str)->str:
    normalized=normalize_primary_text(value)
    return hashlib.sha256(normalized.encode('utf-8')).hexdigest()


def live_review_job_id(kind:ReviewKind, key:str)->str:
    return hashlib.sha256(f'live-scan:{kind}:{key}'.encode('utf-8')).hexdigest()[:32]


def _local_claims_path()->Path:
    return JOB_DATA_DIR/'live_scans'/'claims.json'


def _local_day_path(observation_date:str)->Path:
    return JOB_DATA_DIR/'live_scans'/'days'/f'{observation_date}.json'


def _read_local_claims()->dict[str, dict[str, Any]]:
    path=_local_claims_path()
    if not path.exists():
        return {}
    try:
        value=read_json(path)
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _claim_id(kind:ReviewKind, key:str)->str:
    return f'{kind}:{key}'


def _review_state(job_id:str, fallback:dict[str, Any])->dict[str, Any]:
    try:
        review=get_status(job_id)
    except FileNotFoundError:
        return {
            '_review_missing':True,
            'job_id':job_id,
            'message':'',
            'progress':100 if fallback.get('status') == 'complete' else 0,
            'result':fallback.get('result'),
            'status':fallback.get('status','waiting_media'),
        }
    return {
        '_review_missing':False,
        'job_id':job_id,
        'message':review.message,
        'progress':review.progress,
        'result':fallback.get('result'),
        'status':review.status.value,
    }


def claim_live_review(
    kind:ReviewKind,
    key:str,
    display_name:str,
    *,
    start_review:bool,
)->dict[str, Any]:
    job_id=live_review_job_id(kind, key)
    remote=_convex_call('mutation','liveScans:claimReview',{
        'kind':kind,
        'key':key,
        'displayName':display_name,
        'jobId':job_id,
        'startReview':start_review,
    })
    if remote is not None:
        return remote

    with _local_lock:
        claims=_read_local_claims()
        claim_key=_claim_id(kind, key)
        claim=claims.get(claim_key)
        now=now_ms()
        if claim is None and kind == 'creative':
            for review in list_reviews(100):
                if (
                    review.status.value == 'complete'
                    and review.report_ready
                    and review.has_creative
                    and review.file_name == key
                ):
                    claim={
                        'created_at':now,
                        'display_name':display_name,
                        'job_id':review.job_id,
                        'key':key,
                        'kind':kind,
                        'result':review.overall_status,
                        'status':'complete',
                        'updated_at':now,
                    }
                    claims[claim_key]=claim
                    write_json(_local_claims_path(), claims)
                    break

        if claim is None:
            status='claiming' if start_review else 'waiting_media'
            claim={
                'created_at':now,
                'display_name':display_name,
                'job_id':job_id,
                'key':key,
                'kind':kind,
                'lease_expires_at':now + CLAIM_LEASE_MS if start_review else None,
                'status':status,
                'updated_at':now,
            }
            claims[claim_key]=claim
            write_json(_local_claims_path(), claims)
            return {
                'job_id':job_id,
                'needs_media':status == 'waiting_media',
                'result':None,
                'should_submit':start_review,
                'status':status,
            }

        state=_review_state(claim['job_id'], claim)
        lease_expired=int(claim.get('lease_expires_at') or 0) <= now
        can_start=(
            state['status'] == 'failed'
            or (state['status'] == 'claiming' and lease_expired)
            or (state['status'] == 'complete' and state.get('_review_missing'))
            or (start_review and state['status'] == 'waiting_media')
        )
        if can_start and not start_review:
            claim.update({
                'display_name':display_name,
                'job_id':job_id,
                'lease_expires_at':None,
                'result':None,
                'status':'waiting_media',
                'updated_at':now,
            })
            write_json(_local_claims_path(),claims)
            return {
                'job_id':job_id,
                'needs_media':True,
                'result':None,
                'should_submit':False,
                'status':'waiting_media',
            }
        if can_start:
            claim.update({
                'display_name':display_name,
                'job_id':job_id,
                'lease_expires_at':now + CLAIM_LEASE_MS,
                'result':None,
                'status':'claiming',
                'updated_at':now,
            })
            write_json(_local_claims_path(), claims)
            return {
                'job_id':job_id,
                'needs_media':False,
                'result':None,
                'should_submit':True,
                'status':'claiming',
            }
        return {
            'job_id':claim['job_id'],
            'needs_media':state['status'] == 'waiting_media',
            'result':state.get('result'),
            'should_submit':False,
            'status':state['status'],
        }


def mark_live_review_queued(kind:ReviewKind, key:str, job_id:str)->None:
    remote=_convex_call('mutation','liveScans:markReviewQueued',{
        'kind':kind,
        'key':key,
        'jobId':job_id,
    })
    if remote is not None or convex_enabled():
        return
    with _local_lock:
        claims=_read_local_claims()
        claim=claims.get(_claim_id(kind,key))
        if claim and claim.get('job_id') == job_id:
            claim.update({'lease_expires_at':None,'status':'queued','updated_at':now_ms()})
            write_json(_local_claims_path(), claims)


def finish_live_review(
    kind:ReviewKind,
    key:str,
    job_id:str,
    *,
    status:Literal['complete','failed'],
    result:ResultStatus|None=None,
)->dict[str, Any]|None:
    args:dict[str, Any]={
        'kind':kind,
        'key':key,
        'jobId':job_id,
        'status':status,
    }
    if result:
        args['result']=result
    remote=_convex_call('mutation','liveScans:finishReview',args)
    if remote is not None or convex_enabled():
        return remote
    with _local_lock:
        claims=_read_local_claims()
        claim=claims.get(_claim_id(kind,key))
        if not claim or claim.get('job_id') != job_id:
            return None
        claim.update({
            'lease_expires_at':None,
            'result':result,
            'status':status,
            'updated_at':now_ms(),
        })
        write_json(_local_claims_path(), claims)
        return {
            'display_name':claim['display_name'],
            'job_id':job_id,
            'key':key,
            'kind':kind,
            'result':result,
            'status':status,
        }


def release_live_review(kind:ReviewKind, key:str, job_id:str, message:str)->None:
    remote=_convex_call('mutation','liveScans:releaseReview',{
        'kind':kind,
        'key':key,
        'jobId':job_id,
        'message':message[:500],
    })
    if remote is not None or convex_enabled():
        return
    finish_live_review(kind,key,job_id,status='failed')


def observe_live_account(
    *,
    account_id:str,
    account_name:str,
    observation_date:str,
    observed_at:int,
    source_url:str|None,
    observed_ad_ids:list[str],
    creatives:list[dict[str, Any]],
    copies:list[dict[str, Any]],
)->dict[str, Any]:
    args={
        'accountId':account_id,
        'accountName':account_name,
        'observationDate':observation_date,
        'observedAt':observed_at,
        'observedAdIds':observed_ad_ids,
        'creatives':[
            {
                'creativeKey':value['creative_key'],
                'creativeName':value['creative_name'],
                'adIds':value['ad_ids'],
                'adCount':value['ad_count'],
                'campaignNames':value['campaign_names'],
                'adSetNames':value['ad_set_names'],
                'deliveryStatuses':value['delivery_statuses'],
            }
            for value in creatives
        ],
        'copies':[
            {
                'copyKey':value['copy_key'],
                'creativeKey':value['creative_key'],
                'creativeName':value['creative_name'],
                'primaryText':value['primary_text'],
                'adIds':value['ad_ids'],
                'adCount':value['ad_count'],
            }
            for value in copies
        ],
    }
    if source_url:
        args['sourceUrl']=source_url
    remote=_convex_call('mutation','liveScans:observe',args)
    if remote is not None:
        return remote

    with _local_lock:
        path=_local_day_path(observation_date)
        try:
            day=read_json(path) if path.exists() else {'accounts':{}}
        except (OSError,ValueError):
            day={'accounts':{}}
        accounts=day.setdefault('accounts',{})
        account=accounts.setdefault(account_id,{
            'account_id':account_id,
            'account_name':account_name,
            'first_observed_at':observed_at,
            'last_observed_at':observed_at,
            'scan_count':0,
            'source_url':source_url,
            'creatives':{},
            'copies':{},
        })
        account.update({
            'account_name':account_name,
            'last_observed_at':max(account['last_observed_at'],observed_at),
            'scan_count':account['scan_count'] + 1,
            'source_url':source_url or account.get('source_url'),
        })
        observed=set(observed_ad_ids)
        live_creative_by_ad={
            ad_id:value['creative_key']
            for value in creatives
            for ad_id in value['ad_ids']
        }
        live_copy_keys_by_ad:dict[str,set[str]]={}
        for value in copies:
            for ad_id in value['ad_ids']:
                live_copy_keys_by_ad.setdefault(ad_id,set()).add(value['copy_key'])
        for existing in account['creatives'].values():
            existing['ad_ids']=[
                ad_id
                for ad_id in existing['ad_ids']
                if (
                    ad_id not in observed
                    or live_creative_by_ad.get(ad_id) == existing['creative_key']
                )
            ]
            existing['ad_count']=len(existing['ad_ids'])
        for existing in account['copies'].values():
            retained=[]
            for ad_id in existing['ad_ids']:
                if ad_id not in observed:
                    retained.append(ad_id)
                    continue
                live_creative_key=live_creative_by_ad.get(ad_id)
                if live_creative_key != existing['creative_key']:
                    continue
                captured_copy_keys=live_copy_keys_by_ad.get(ad_id)
                if captured_copy_keys is None or existing['copy_key'] in captured_copy_keys:
                    retained.append(ad_id)
            existing['ad_ids']=retained
            existing['ad_count']=len(retained)
        for value in creatives:
            existing=account['creatives'].get(value['creative_key'])
            if existing:
                for field in ('ad_ids','campaign_names','ad_set_names','delivery_statuses'):
                    existing[field]=list(dict.fromkeys([*existing[field],*value[field]]))
                existing['ad_count']=len(existing['ad_ids'])
                existing['last_observed_at']=max(existing['last_observed_at'],observed_at)
            else:
                account['creatives'][value['creative_key']]={
                    **value,
                    'first_observed_at':observed_at,
                    'last_observed_at':observed_at,
                }
        for value in copies:
            local_key=f"{value['creative_key']}:{value['copy_key']}"
            existing=account['copies'].get(local_key)
            if existing:
                existing['ad_ids']=list(dict.fromkeys([*existing['ad_ids'],*value['ad_ids']]))
                existing['ad_count']=len(existing['ad_ids'])
                existing['last_observed_at']=max(existing['last_observed_at'],observed_at)
            else:
                account['copies'][local_key]={
                    **value,
                    'first_observed_at':observed_at,
                    'last_observed_at':observed_at,
                }
        write_json(path,day)
    return {
        'account_id':account_id,
        'observation_date':observation_date,
        'observed_at':observed_at,
    }


def get_live_scan_day(observation_date:str)->LiveScanDay:
    remote=_convex_call('query','liveScans:getDay',{'observationDate':observation_date})
    if remote is not None:
        return LiveScanDay.model_validate(remote)
    path=_local_day_path(observation_date)
    if not path.exists():
        return LiveScanDay(
            observation_date=observation_date,
            totals={
                'accounts_observed':0,
                'copy_variants':0,
                'live_ads':0,
                'outcomes':{'green':0,'amber':0,'red':0},
                'pending':0,
                'unique_creatives':0,
            },
        )
    day=read_json(path)
    claims=_read_local_claims()
    public_accounts=[]
    creative_keys=set()
    copy_keys=set()
    live_ad_keys=set()
    states={}
    for account in day.get('accounts',{}).values():
        creative_rows=[]
        for creative in account.get('creatives',{}).values():
            if not creative['ad_count']:
                continue
            creative_keys.add(creative['creative_key'])
            for ad_id in creative['ad_ids']:
                live_ad_keys.add(f"{account['account_id']}:{ad_id}")
            claim=claims.get(_claim_id('creative',creative['creative_key']),{
                'job_id':None,
                'status':'waiting_media',
            })
            review=_review_state(claim.get('job_id') or '',claim) if claim.get('job_id') else {
                'job_id':None,'message':'','progress':0,'result':None,'status':'waiting_media',
            }
            states[f"creative:{creative['creative_key']}"]=review
            copy_rows=[]
            for copy in account.get('copies',{}).values():
                if copy['creative_key'] != creative['creative_key'] or not copy['ad_count']:
                    continue
                copy_keys.add(copy['copy_key'])
                copy_claim=claims.get(_claim_id('copy',copy['copy_key']),{
                    'job_id':None,'status':'not_submitted',
                })
                copy_review=(
                    _review_state(copy_claim.get('job_id') or '',copy_claim)
                    if copy_claim.get('job_id')
                    else {'job_id':None,'message':'','progress':0,'result':None,'status':'not_submitted'}
                )
                states[f"copy:{copy['copy_key']}"]=copy_review
                copy_rows.append({
                    'ad_count':copy['ad_count'],
                    'ad_ids':copy['ad_ids'],
                    'copy_key':copy['copy_key'],
                    'first_observed_at':copy['first_observed_at'],
                    'last_observed_at':copy['last_observed_at'],
                    'primary_text':copy['primary_text'],
                    'review':copy_review,
                })
            creative_rows.append({
                'ad_count':creative['ad_count'],
                'ad_ids':creative['ad_ids'],
                'ad_set_names':creative['ad_set_names'],
                'campaign_names':creative['campaign_names'],
                'copies':copy_rows,
                'creative_key':creative['creative_key'],
                'creative_name':creative['creative_name'],
                'delivery_statuses':creative['delivery_statuses'],
                'first_observed_at':creative['first_observed_at'],
                'last_observed_at':creative['last_observed_at'],
                'review':review,
            })
        public_accounts.append({
            'account_id':account['account_id'],
            'account_name':account['account_name'],
            'creatives':creative_rows,
            'first_observed_at':account['first_observed_at'],
            'last_observed_at':account['last_observed_at'],
            'live_ad_count':len({
                ad_id for creative in creative_rows for ad_id in creative['ad_ids']
            }),
            'scan_count':account['scan_count'],
            'source_url':account.get('source_url'),
        })
    outcomes={'green':0,'amber':0,'red':0}
    pending=0
    for state in states.values():
        result=normalize_result_status(state.get('result'))
        if result in outcomes:
            outcomes[result] += 1
        elif state.get('status') != 'failed':
            pending += 1
    return LiveScanDay.model_validate({
        'accounts':sorted(public_accounts,key=lambda value:value['last_observed_at'],reverse=True),
        'observation_date':observation_date,
        'totals':{
            'accounts_observed':len(public_accounts),
            'copy_variants':len(copy_keys),
            'live_ads':len(live_ad_keys),
            'outcomes':outcomes,
            'pending':pending,
            'unique_creatives':len(creative_keys),
        },
    })
