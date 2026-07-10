from __future__ import annotations
import json, os, re
from typing import Any

import httpx
from .models import ComplianceReport
from .prompts import SYSTEM_PROMPT, build_user_prompt

STATUS_ALIASES = {
    'approved': 'pass',
    'clear': 'pass',
    'compliant': 'pass',
    'ok': 'pass',
    'pass': 'pass',
    'passed': 'pass',
    'safe': 'pass',
    'uncertain': 'needs_review',
    'manual_review': 'needs_review',
    'needs human review': 'needs_review',
    'needs_human_review': 'needs_review',
    'needs review': 'needs_review',
    'needs_review': 'needs_review',
    'possible_issue': 'needs_review',
    'possible issue': 'needs_review',
    'review': 'needs_review',
    'fail': 'likely_violation',
    'failed': 'likely_violation',
    'high_risk': 'likely_violation',
    'high risk': 'likely_violation',
    'likely violation': 'likely_violation',
    'likely_violation': 'likely_violation',
    'non compliant': 'likely_violation',
    'non-compliant': 'likely_violation',
    'non_compliant': 'likely_violation',
    'not compliant': 'likely_violation',
    'rejected': 'likely_violation',
    'violation': 'likely_violation',
    'violates': 'likely_violation',
}

SOURCE_ALIASES = {
    'audio': 'audio',
    'voiceover': 'audio',
    'voice over': 'audio',
    'transcript': 'audio',
    'audio transcript': 'audio',
    'onscreen': 'onscreen_text',
    'on screen': 'onscreen_text',
    'onscreen text': 'onscreen_text',
    'on-screen text': 'onscreen_text',
    'onscreen_text': 'onscreen_text',
    'ocr': 'onscreen_text',
    'text': 'onscreen_text',
    'visual': 'visual',
    'image': 'visual',
    'frame': 'visual',
    'ad copy': 'ad_copy',
    'ad_copy': 'ad_copy',
    'submitted ad copy': 'ad_copy',
    'submitted_ad_copy': 'ad_copy',
    'platform copy': 'ad_copy',
    'platform caption': 'ad_copy',
    'social caption': 'ad_copy',
    'copy': 'ad_copy',
    'caption': 'ad_copy',
    'policy': 'policy',
    'guideline': 'policy',
}

REPORT_CONTAINER_KEYS = (
    'policy_compliance',
    'compliance_report',
    'complianceReport',
    'report',
    'result',
    'analysis',
)

FINDING_LIST_KEYS = (
    'findings',
    'issues',
    'violations',
    'risks',
    'recommendations',
    'review',
)

STATUS_KEYS = (
    'overall_status',
    'overallStatus',
    'status',
    'overall',
    'overall_compliance',
    'overallCompliance',
    'compliance',
    'result',
    'verdict',
)

MISSING_VERDICT_LIMITATION = (
    'The model response did not include a recognized explicit compliance verdict '
    'or any findings; the result was set to needs_review for human review.'
)


def _load_json(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r'\{.*\}', text, re.S)
        if not m:
            raise
        return json.loads(m.group(0))


def _clean_token(value: Any) -> str:
    return re.sub(r'[\s-]+', ' ', str(value).strip().lower())


def _status_from_value(value: Any) -> str | None:
    if isinstance(value, bool):
        return 'pass' if value else 'likely_violation'
    if value is None:
        return None

    cleaned = _clean_token(value)
    if cleaned in STATUS_ALIASES:
        return STATUS_ALIASES[cleaned]
    underscored = cleaned.replace(' ', '_')
    if underscored in STATUS_ALIASES:
        return STATUS_ALIASES[underscored]
    if 'non compliant' in cleaned or 'not compliant' in cleaned or 'violation' in cleaned:
        return 'likely_violation'
    if 'review' in cleaned or 'uncertain' in cleaned or 'possible' in cleaned:
        return 'needs_review'
    if 'compliant' in cleaned or 'pass' in cleaned or 'approved' in cleaned:
        return 'pass'
    return None


def _first_present(source: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in source and source[key] not in (None, ''):
            return source[key]
    return None


def _nested_report(data: dict[str, Any]) -> dict[str, Any]:
    for key in REPORT_CONTAINER_KEYS:
        value = data.get(key)
        if isinstance(value, dict):
            return value
    return data


def _summary_from_value(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, list):
        parts = [_summary_from_value(item) for item in value[:3]]
        parts = [part for part in parts if part]
        if parts:
            return '; '.join(parts)
    if isinstance(value, dict):
        found = _first_present(
            value,
            (
                'summary',
                'overall_summary',
                'overallSummary',
                'evidence',
                'claim',
                'finding',
                'details',
                'text',
                'content',
                'quote',
                'issue',
                'description',
                'explanation',
                'reason',
                'policy_reason',
            ),
        )
        if isinstance(found, str) and found.strip():
            return found.strip()
        if found not in (None, ''):
            return str(found)
    return None


def _severity(value: Any, status: str | None = None) -> str:
    cleaned = _clean_token(value) if value is not None else ''
    if cleaned in {'low', 'minor'}:
        return 'low'
    if cleaned in {'high', 'critical', 'severe'}:
        return 'high'
    if cleaned in {'medium', 'moderate'}:
        return 'medium'
    if status == 'likely_violation':
        return 'high'
    return 'medium'


def _source(value: Any) -> str:
    cleaned = _clean_token(value) if value is not None else ''
    if cleaned in SOURCE_ALIASES:
        return SOURCE_ALIASES[cleaned]
    underscored = cleaned.replace(' ', '_')
    return SOURCE_ALIASES.get(underscored, 'policy')


def _confidence(value: Any) -> str:
    cleaned = _clean_token(value) if value is not None else ''
    if cleaned in {'low', 'medium', 'high'}:
        return cleaned
    return 'medium'


def _source_result(value: Any) -> dict[str, str] | None:
    if value is None:
        return None
    if isinstance(value, str):
        status = _status_from_value(value)
        return {'status': status, 'summary': ''} if status else None
    if not isinstance(value, dict):
        return None

    status = _status_from_value(
        _first_present(value, ('status', 'result', 'verdict', 'overall_status', 'overallStatus'))
    )
    if not status:
        return None
    summary = (
        _summary_from_value(_first_present(value, ('summary', 'details', 'reason', 'explanation')))
        or ''
    )
    return {'status': status, 'summary': summary}


def _source_results(report: dict[str, Any]) -> dict[str, Any]:
    raw = (
        report.get('source_results')
        or report.get('sourceResults')
        or report.get('surface_results')
        or report.get('surfaceResults')
        or report.get('component_results')
        or report.get('componentResults')
        or {}
    )
    if not isinstance(raw, dict):
        return {}

    creative = _source_result(
        _first_present(raw, ('creative', 'media', 'asset', 'visual_creative', 'visualCreative'))
    )
    ad_copy = _source_result(
        _first_present(raw, ('ad_copy', 'adCopy', 'submitted_ad_copy', 'submittedAdCopy', 'copy', 'caption'))
    )
    results: dict[str, Any] = {}
    if creative:
        results['creative'] = creative
    if ad_copy:
        results['ad_copy'] = ad_copy
    return results


def _optional_str(value: Any) -> str | None:
    if value in (None, ''):
        return None
    return str(value)


def _finding_from_item(item: Any, default_status: str | None = None) -> dict[str, Any] | None:
    if isinstance(item, str):
        text = item.strip()
        if not text:
            return None
        return {
            'severity': _severity(None, default_status),
            'source': 'policy',
            'evidence': text,
            'policy_reason': text,
            'suggested_fix': 'Review the claim against the applicable policy before publishing.',
            'confidence': 'medium',
        }

    if not isinstance(item, dict):
        return None

    item_status = _status_from_value(
        _first_present(item, ('status', 'compliance', 'result', 'verdict'))
    ) or default_status
    evidence = _first_present(
        item,
        (
            'evidence',
            'claim',
            'issue',
            'description',
            'finding',
            'details',
            'text',
            'content',
            'quote',
        ),
    )
    policy_reason = _first_present(
        item,
        (
            'policy_reason',
            'policyReason',
            'reason',
            'rationale',
            'explanation',
            'policy_rule',
            'policyRule',
            'policy',
            'rule',
        ),
    )
    suggested_fix = _first_present(
        item,
        (
            'suggested_fix',
            'suggestedFix',
            'recommendation',
            'recommended_action',
            'recommendedAction',
            'fix',
            'action',
            'remediation',
        ),
    )

    if not any((evidence, policy_reason, suggested_fix)):
        return None

    return {
        'severity': _severity(_first_present(item, ('severity', 'risk', 'risk_level', 'riskLevel')), item_status),
        'source': _source(_first_present(item, ('source', 'channel', 'area', 'field', 'location', 'type'))),
        'timestamp_start': _optional_str(_first_present(item, ('timestamp_start', 'timestampStart', 'start', 'timestamp'))),
        'timestamp_end': _optional_str(_first_present(item, ('timestamp_end', 'timestampEnd', 'end'))),
        'evidence': str(evidence or policy_reason or suggested_fix),
        'policy_reason': str(policy_reason or evidence or 'Potential policy issue needs human review.'),
        'suggested_fix': str(suggested_fix or 'Review the claim against the applicable policy before publishing.'),
        'confidence': _confidence(_first_present(item, ('confidence', 'certainty'))),
    }


def _collect_findings(data: Any, default_status: str | None = None) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [
            finding
            for item in data
            if (finding := _finding_from_item(item, default_status)) is not None
        ]

    if not isinstance(data, dict):
        return []

    findings: list[dict[str, Any]] = []
    for key in FINDING_LIST_KEYS:
        value = data.get(key)
        if isinstance(value, list):
            findings.extend(_collect_findings(value, default_status))

    if not findings:
        finding = _finding_from_item(data, default_status)
        if finding:
            findings.append(finding)
    return findings


def _explicit_status(data: dict[str, Any]) -> str | None:
    report = _nested_report(data)
    status = _status_from_value(report.get('overall_status'))
    if status:
        return status

    for key in STATUS_KEYS:
        status = _status_from_value(data.get(key))
        if status:
            return status

    if report is not data:
        for key in STATUS_KEYS:
            status = _status_from_value(report.get(key))
            if status:
                return status

    return None


def _infer_status(findings: list[dict[str, Any]]) -> str:
    if any(finding.get('severity') == 'high' for finding in findings):
        return 'likely_violation'
    if findings:
        return 'needs_review'
    return 'needs_review'


def _normalize_report(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise TypeError('Compliance report JSON must be an object')

    nested = _nested_report(data)
    report = {**nested}
    findings = _collect_findings(report)
    if not findings and nested is not data:
        findings = _collect_findings(data)

    explicit_status = _explicit_status(data)
    status = explicit_status or _infer_status(findings)
    summary = (
        _summary_from_value(report.get('summary'))
        or _summary_from_value(report.get('overall_summary'))
        or _summary_from_value(data.get('summary'))
        or _summary_from_value(findings)
        or ('No policy issues were identified.' if status == 'pass' else 'Potential policy issue identified; human review is recommended.')
    )

    limitations = report.get('limitations') or report.get('limitations_notes') or []
    if isinstance(limitations, str):
        limitations = [limitations]
    elif not isinstance(limitations, list):
        limitations = []
    if explicit_status is None and not findings and MISSING_VERDICT_LIMITATION not in limitations:
        limitations.append(MISSING_VERDICT_LIMITATION)

    source_results = _source_results(report)
    if not source_results and nested is not data:
        source_results = _source_results(data)

    return {
        **report,
        'overall_status': status,
        'summary': summary,
        'source_results': source_results,
        'findings': findings if findings else report.get('findings', []),
        'safe_rewrite': report.get('safe_rewrite') or report.get('safeRewrite') or {},
        'limitations': limitations,
    }


def parse_report_json(text:str)->ComplianceReport:
    return ComplianceReport.model_validate(_normalize_report(_load_json(text)))


async def review_with_openrouter(evidence:dict, model:str|None=None)->ComplianceReport:
    key=os.getenv('OPENROUTER_API_KEY')
    if not key:
        return ComplianceReport(overall_status='needs_review', summary='OpenRouter API key is not configured; generated placeholder report.', limitations=['Set OPENROUTER_API_KEY to enable LLM compliance review.'])
    payload={'model': model or os.getenv('OPENROUTER_MODEL','deepseek/deepseek-v4-flash'), 'messages':[{'role':'system','content':SYSTEM_PROMPT},{'role':'user','content':build_user_prompt(evidence)}], 'response_format': {'type':'json_object'}, 'temperature': 0}
    async with httpx.AsyncClient(timeout=120) as client:
        r=await client.post('https://openrouter.ai/api/v1/chat/completions', headers={'Authorization':f'Bearer {key}','Content-Type':'application/json'}, json=payload)
        r.raise_for_status(); content=r.json()['choices'][0]['message']['content']
    return parse_report_json(content)
