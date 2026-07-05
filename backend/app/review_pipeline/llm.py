from __future__ import annotations
import json, os, re, httpx
from .models import ComplianceReport
from .prompts import SYSTEM_PROMPT, build_user_prompt

def parse_report_json(text:str)->ComplianceReport:
    try: data=json.loads(text)
    except json.JSONDecodeError:
        m=re.search(r'\{.*\}', text, re.S)
        if not m: raise
        data=json.loads(m.group(0))
    return ComplianceReport.model_validate(data)

async def review_with_openrouter(evidence:dict, model:str|None=None)->ComplianceReport:
    key=os.getenv('OPENROUTER_API_KEY')
    if not key:
        return ComplianceReport(overall_status='needs_review', summary='OpenRouter API key is not configured; generated placeholder report.', limitations=['Set OPENROUTER_API_KEY to enable LLM compliance review.'])
    payload={'model': model or os.getenv('OPENROUTER_MODEL','openai/gpt-4o-mini'), 'messages':[{'role':'system','content':SYSTEM_PROMPT},{'role':'user','content':build_user_prompt(evidence)}], 'response_format': {'type':'json_object'}}
    async with httpx.AsyncClient(timeout=120) as client:
        r=await client.post('https://openrouter.ai/api/v1/chat/completions', headers={'Authorization':f'Bearer {key}','Content-Type':'application/json'}, json=payload)
        r.raise_for_status(); content=r.json()['choices'][0]['message']['content']
    return parse_report_json(content)
