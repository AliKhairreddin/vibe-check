from __future__ import annotations
import asyncio, json, logging, os, re
from typing import Any

import httpx
from pydantic import ValidationError

from .language import first_han_script_field
from .models import ComplianceReport, LLMComplianceResult
from .openrouter_routing import provider_preferences
from .prompts import SYSTEM_PROMPT, build_user_prompt

STATUS_ALIASES = {
    'green': 'green',
    'approved': 'green',
    'clear': 'green',
    'compliant': 'green',
    'ok': 'green',
    'pass': 'green',
    'passed': 'green',
    'safe': 'green',
    'amber': 'yellow',
    'yellow': 'yellow',
    'caution': 'yellow',
    'low risk': 'yellow',
    'low_risk': 'yellow',
    'minor issue': 'yellow',
    'minor_issue': 'yellow',
    'orange': 'yellow',
    'uncertain': 'yellow',
    'manual_review': 'yellow',
    'needs human review': 'yellow',
    'needs_human_review': 'yellow',
    'needs review': 'yellow',
    'needs_review': 'yellow',
    'possible_issue': 'yellow',
    'possible issue': 'yellow',
    'review': 'yellow',
    'fail': 'yellow',
    'failed': 'yellow',
    'non compliant': 'yellow',
    'non-compliant': 'yellow',
    'non_compliant': 'yellow',
    'not compliant': 'yellow',
    'rejected': 'yellow',
    'violation': 'yellow',
    'violates': 'yellow',
    'high_risk': 'yellow',
    'high risk': 'yellow',
    'red': 'red',
    'critical': 'red',
    'critical risk': 'red',
    'critical_risk': 'red',
    'funds withheld': 'red',
    'account paused': 'red',
    'likely violation': 'red',
    'likely_violation': 'red',
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
    'or any findings; the result was set to yellow for human review.'
)
REVIEW_RESPONSE_SCHEMA = {
    'type': 'json_schema',
    'json_schema': {
        'name': 'offer_policy_compliance_result',
        'strict': True,
        'schema': LLMComplianceResult.model_json_schema(),
    },
}
DEFAULT_MAX_REVIEW_ATTEMPTS = 3
MAX_REVIEW_ATTEMPTS_LIMIT = 5
DEFAULT_RETRY_BASE_SECONDS = 1.0
DEFAULT_REQUEST_DEADLINE_SECONDS = 180
SEMANTIC_NORMALIZATION_LIMITATION = (
    'The provider verdict was normalized deterministically from its returned '
    'findings and enforcement-consequence fields.'
)
STRUCTURE_REPAIR_LIMITATION = (
    'The provider response required deterministic schema repair after strict '
    'structured-output validation failed.'
)

logger = logging.getLogger(__name__)


class ComplianceResponseError(ValueError):
    pass


def _english_authored_field_issue(report: ComplianceReport) -> str | None:
    fields: list[tuple[str, Any]] = [
        ('summary', report.summary),
        ('safe_rewrite.ad_copy', report.safe_rewrite.ad_copy),
        ('safe_rewrite.onscreen_text', report.safe_rewrite.onscreen_text),
        ('limitations', report.limitations),
    ]
    for source_name, source_result in (
        ('creative', report.source_results.creative),
        ('ad_copy', report.source_results.ad_copy),
    ):
        if source_result is not None:
            fields.append((f'source_results.{source_name}.summary', source_result.summary))
    for index, finding in enumerate(report.findings):
        fields.extend((
            (f'findings[{index}].policy_reason', finding.policy_reason),
            (f'findings[{index}].suggested_fix', finding.suggested_fix),
        ))
    for index, override in enumerate(report.applied_overrides):
        fields.append((f'applied_overrides[{index}].rationale', override.rationale))
    return first_han_script_field(fields)


def _require_english_authored_fields(report: ComplianceReport) -> ComplianceReport:
    issue = _english_authored_field_issue(report)
    if issue is not None:
        raise ComplianceResponseError(
            'The policy reviewer returned non-English model-authored text in '
            f'{issue}; every narrative field must be written in English.'
        )
    return report


def _request_deadline_seconds() -> int:
    try:
        configured = int(os.getenv(
            'OPENROUTER_REQUEST_TIMEOUT_SECONDS',
            str(DEFAULT_REQUEST_DEADLINE_SECONDS),
        ))
    except ValueError:
        configured = DEFAULT_REQUEST_DEADLINE_SECONDS
    return max(30, min(configured, 10 * 60))


def _max_review_attempts() -> int:
    try:
        configured = int(os.getenv(
            'OPENROUTER_MAX_ATTEMPTS',
            str(DEFAULT_MAX_REVIEW_ATTEMPTS),
        ))
    except ValueError:
        configured = DEFAULT_MAX_REVIEW_ATTEMPTS
    return max(1, min(configured, MAX_REVIEW_ATTEMPTS_LIMIT))


def _retry_delay_seconds(attempt: int) -> float:
    try:
        base = float(os.getenv(
            'OPENROUTER_RETRY_BASE_SECONDS',
            str(DEFAULT_RETRY_BASE_SECONDS),
        ))
    except ValueError:
        base = DEFAULT_RETRY_BASE_SECONDS
    return max(0.0, min(base, 30.0)) * (2 ** max(0, attempt - 1))


def _retryable_http_status(status_code: int) -> bool:
    return status_code in {408, 409, 425, 429} or 500 <= status_code <= 599


async def _wait_before_retry(attempt: int) -> None:
    delay = _retry_delay_seconds(attempt)
    if delay:
        await asyncio.sleep(delay)


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
        return 'green' if value else 'yellow'
    if value is None:
        return None

    cleaned = _clean_token(value)
    if cleaned in STATUS_ALIASES:
        return STATUS_ALIASES[cleaned]
    underscored = cleaned.replace(' ', '_')
    if underscored in STATUS_ALIASES:
        return STATUS_ALIASES[underscored]
    if (
        'critical' in cleaned
        or 'funds withheld' in cleaned
        or 'withheld funds' in cleaned
        or 'account pause' in cleaned
    ):
        return 'red'
    if 'review' in cleaned or 'uncertain' in cleaned or 'possible' in cleaned:
        return 'yellow'
    if (
        'minor' in cleaned
        or 'low risk' in cleaned
        or 'caution' in cleaned
        or 'non compliant' in cleaned
        or 'not compliant' in cleaned
        or 'violation' in cleaned
        or 'fail' in cleaned
        or 'reject' in cleaned
    ):
        return 'yellow'
    if 'compliant' in cleaned or 'pass' in cleaned or 'approved' in cleaned:
        return 'green'
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
    if cleaned in {'critical', 'severe'}:
        return 'high'
    if cleaned in {'medium', 'moderate', 'high'}:
        return 'medium'
    if status == 'red':
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


def _internal_override(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    override_id = _first_present(value, ('override_id', 'overrideId', 'id'))
    if not isinstance(override_id, str) or not override_id.strip():
        return None
    disposition = _clean_token(
        _first_present(value, ('disposition', 'treatment', 'status')) or 'uncertain'
    )
    if disposition not in {'accepted', 'partial', 'uncertain'}:
        disposition = 'uncertain'
    return {
        'override_id': override_id.strip(),
        'title': str(_first_present(value, ('title', 'name')) or ''),
        'disposition': disposition,
        'rationale': str(_first_present(value, ('rationale', 'reason', 'explanation')) or ''),
    }


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
            'enforcement_consequence': 'none',
            'consequence_policy_basis': '',
            'controlling_internal_rule_id': None,
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
        'enforcement_consequence': 'none',
        'consequence_policy_basis': '',
        'controlling_internal_rule_id': None,
        'internal_override': _internal_override(
            _first_present(item, ('internal_override', 'internalOverride', 'override'))
        ),
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
        return 'red'
    if findings:
        return 'yellow'
    return 'yellow'


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
        or ('No policy issues were identified.' if status == 'green' else 'Potential policy issue identified; human review is recommended.')
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
    report=ComplianceReport.model_validate(_normalize_report(_load_json(text)))
    return normalize_report_semantics(
        report,
        preserve_unsubstantiated_review=True,
    )


def _status_for_findings(findings:list[Any])->str:
    if any(finding.severity == 'high' for finding in findings):
        return 'red'
    if findings:
        return 'yellow'
    return 'green'


def normalize_report_semantics(
    report:ComplianceReport,
    *,
    preserve_unsubstantiated_review:bool=False,
)->ComplianceReport:
    """Derive verdict relationships in code instead of trusting the model.

    JSON Schema enforces the response shape, but it cannot reliably enforce our
    cross-field policy rules across every provider. The model supplies evidence
    and consequence claims; this function makes severity, overall color, and
    source colors internally consistent before the offer-specific backend guard
    verifies whether any claimed severe consequence is actually supported.
    """
    changed=False
    for finding in report.findings:
        has_complete_consequence=(
            finding.enforcement_consequence != 'none'
            and bool(finding.consequence_policy_basis.strip())
        )
        if has_complete_consequence:
            if finding.severity != 'high':
                finding.severity='high'
                changed=True
            continue
        if finding.severity == 'high':
            finding.severity='medium'
            changed=True
        if (
            finding.enforcement_consequence != 'none'
            or finding.consequence_policy_basis
            or finding.controlling_internal_rule_id is not None
        ):
            finding.enforcement_consequence='none'
            finding.consequence_policy_basis=''
            finding.controlling_internal_rule_id=None
            changed=True

    source_results=(
        report.source_results.creative,
        report.source_results.ad_copy,
    )
    source_requires_review=any(
        result is not None and result.status != 'green'
        for result in source_results
    )
    expected_status=_status_for_findings(report.findings)
    if (
        not report.findings
        and (
            MISSING_VERDICT_LIMITATION in report.limitations
            or (
                preserve_unsubstantiated_review
                and (
                    report.overall_status != 'green'
                    or source_requires_review
                )
            )
        )
    ):
        expected_status='yellow'
    if report.overall_status != expected_status:
        report.overall_status=expected_status
        report.summary={
            'green':'No effective-policy issue was supported by the returned findings.',
            'yellow':'This review needs an edit or human review under the effective policy.',
            'red':'This review identifies a severe-consequence issue under the effective policy.',
        }[expected_status]
        changed=True

    source_findings={
        'ad_copy':[finding for finding in report.findings if finding.source == 'ad_copy'],
        'creative':[finding for finding in report.findings if finding.source != 'ad_copy'],
    }
    for source_name,source_result in (
        ('creative',report.source_results.creative),
        ('ad_copy',report.source_results.ad_copy),
    ):
        if source_result is None:
            continue
        expected_source_status=_status_for_findings(source_findings[source_name])
        if (
            preserve_unsubstantiated_review
            and not report.findings
            and source_result.status != 'green'
        ):
            expected_source_status='yellow'
        if source_result.status == expected_source_status:
            continue
        source_result.status=expected_source_status
        source_result.summary={
            'green':'No effective-policy issue was supported for this source.',
            'yellow':'This source needs an edit or human review.',
            'red':'This source includes a severe-consequence issue.',
        }[expected_source_status]
        changed=True

    if changed and SEMANTIC_NORMALIZATION_LIMITATION not in report.limitations:
        report.limitations.append(SEMANTIC_NORMALIZATION_LIMITATION)
    return report


def parse_strict_report_json(text:str)->ComplianceReport:
    try:
        payload=json.loads(text)
        result=LLMComplianceResult.model_validate(payload)
    except (json.JSONDecodeError, TypeError, ValidationError, ValueError) as exc:
        raise ComplianceResponseError(
            f'The policy reviewer returned an invalid structured result: {exc}'
        ) from exc
    report=ComplianceReport.model_validate(result.model_dump())
    return _require_english_authored_fields(normalize_report_semantics(report))


async def review_with_openrouter(evidence:dict, model:str|None=None)->ComplianceReport:
    key=os.getenv('OPENROUTER_API_KEY')
    if not key:
        raise RuntimeError('OPENROUTER_API_KEY is required for policy review.')

    selected_model=model or os.getenv('OPENROUTER_MODEL','deepseek/deepseek-v4-flash')
    messages=[
        {'role':'system','content':SYSTEM_PROMPT},
        {'role':'user','content':build_user_prompt(evidence)},
    ]
    max_attempts=_max_review_attempts()
    last_error:ComplianceResponseError|None=None
    last_content:str|None=None
    async with httpx.AsyncClient(timeout=120) as client:
        for attempt in range(1, max_attempts + 1):
            payload={
                'model':selected_model,
                'messages':messages,
                'response_format':REVIEW_RESPONSE_SCHEMA,
                'provider':provider_preferences(require_parameters=True),
                'plugins':[{'id':'response-healing'}],
                'temperature':0,
            }
            content:Any=None
            try:
                async with asyncio.timeout(_request_deadline_seconds()):
                    response=await client.post(
                        'https://openrouter.ai/api/v1/chat/completions',
                        headers={
                            'Authorization':f'Bearer {key}',
                            'Content-Type':'application/json',
                        },
                        json=payload,
                    )
                response.raise_for_status()
                content=response.json()['choices'][0]['message']['content']
            except TimeoutError as exc:
                last_error=ComplianceResponseError(
                    f'The policy reviewer timed out on attempt {attempt} of {max_attempts}.'
                )
                logger.warning(
                    'Policy review request timed out. attempt=%s max_attempts=%s model=%s',
                    attempt,
                    max_attempts,
                    selected_model,
                )
                if attempt < max_attempts:
                    await _wait_before_retry(attempt)
                    continue
                break
            except httpx.HTTPStatusError as exc:
                status_code=exc.response.status_code
                if not _retryable_http_status(status_code):
                    raise
                last_error=ComplianceResponseError(
                    'The policy reviewer returned a transient HTTP '
                    f'{status_code} error on attempt {attempt} of {max_attempts}.'
                )
                logger.warning(
                    'Policy review request returned transient HTTP status. '
                    'attempt=%s max_attempts=%s model=%s status=%s',
                    attempt,
                    max_attempts,
                    selected_model,
                    status_code,
                )
                if attempt < max_attempts:
                    await _wait_before_retry(attempt)
                    continue
                break
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_error=ComplianceResponseError(
                    'The policy reviewer had a transient network failure '
                    f'({type(exc).__name__}) on attempt {attempt} of {max_attempts}.'
                )
                logger.warning(
                    'Policy review request had a transient network failure. '
                    'attempt=%s max_attempts=%s model=%s error_type=%s',
                    attempt,
                    max_attempts,
                    selected_model,
                    type(exc).__name__,
                )
                if attempt < max_attempts:
                    await _wait_before_retry(attempt)
                    continue
                break
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                last_error=ComplianceResponseError(
                    'The policy reviewer returned an invalid provider response '
                    f'on attempt {attempt} of {max_attempts}: {type(exc).__name__}.'
                )
                logger.warning(
                    'Policy review provider response could not be read. '
                    'attempt=%s max_attempts=%s model=%s error_type=%s',
                    attempt,
                    max_attempts,
                    selected_model,
                    type(exc).__name__,
                )
                if attempt < max_attempts:
                    await _wait_before_retry(attempt)
                    continue
                break
            if not isinstance(content, str):
                last_error=ComplianceResponseError(
                    'The policy reviewer returned a non-text structured result.'
                )
            else:
                last_content=content
                try:
                    return parse_strict_report_json(content)
                except ComplianceResponseError as exc:
                    last_error=exc
                    logger.warning(
                        'Strict policy result validation failed. attempt=%s model=%s cause=%s',
                        attempt,
                        selected_model,
                        type(exc.__cause__).__name__ if exc.__cause__ else type(exc).__name__,
                    )

            if attempt < max_attempts:
                messages=[
                    *messages,
                    {
                        'role':'assistant',
                        'content':content[:20_000] if isinstance(content, str) else '',
                    },
                    {
                        'role':'user',
                        'content':(
                            'Your previous response did not satisfy the required language, schema, '
                            f'or verdict rules: {last_error}. Return the complete corrected JSON '
                            'object only, with every model-authored narrative field in English. '
                            'Preserve only direct evidence quotes and exact policy excerpts in '
                            'their original language. Green must have zero findings. Yellow must include low '
                            'or medium findings. Red must include a high finding tied to an '
                            'explicitly critical enforcement consequence in the supplied policy, '
                            'including its enforcement_consequence, exact consequence_policy_basis, '
                            'and controlling_internal_rule_id fields.'
                        ),
                    },
                ]
                await _wait_before_retry(attempt)

    if last_content is not None:
        try:
            repaired=parse_report_json(last_content)
            _require_english_authored_fields(repaired)
        except (ComplianceResponseError, json.JSONDecodeError, TypeError, ValidationError, ValueError):
            pass
        else:
            if STRUCTURE_REPAIR_LIMITATION not in repaired.limitations:
                repaired.limitations.append(STRUCTURE_REPAIR_LIMITATION)
            logger.warning(
                'Used deterministic policy result schema repair. model=%s',
                selected_model,
            )
            return repaired

    if last_content is None and last_error is not None:
        raise ComplianceResponseError(
            f'Policy review failed after {max_attempts} automatic attempts. {last_error}'
        ) from last_error
    raise ComplianceResponseError(
        'The policy reviewer did not return a valid English structured verdict with '
        f'supporting findings after {max_attempts} automatic attempts. '
        'No policy color was assigned.'
    ) from last_error
