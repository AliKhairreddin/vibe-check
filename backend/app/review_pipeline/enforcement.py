from __future__ import annotations

import re

from .models import EnforcementConsequence, OfferComplianceResult, OfferProfile


GLOBAL_ENFORCEMENT_RULE_ID = 'refund-rebate-and-enforcement'
GLOBAL_ENFORCEMENT_SEVERE_BASIS = (
    'Only clear government-angle, prohibited celebrity, and cursing violations carry '
    'funds-withheld/account-paused risk.'
)
DOWNGRADE_LIMITATION = (
    'One or more red findings were changed to yellow because the controlling policy '
    'did not explicitly support an approved severe consequence.'
)


def _normalized_policy_text(value: str) -> str:
    return re.sub(r'[^a-z0-9]+', ' ', value.lower()).strip()


def _contains_exact_policy_basis(basis: str, policy_text: str) -> bool:
    normalized_basis = _normalized_policy_text(basis)
    return len(normalized_basis) >= 8 and normalized_basis in _normalized_policy_text(policy_text)


def _basis_supports_consequence(
    basis: str,
    consequence: EnforcementConsequence,
) -> bool:
    text = _normalized_policy_text(basis)
    consequence_phrases: dict[EnforcementConsequence, tuple[str, ...]] = {
        'none': (),
        'payment_withheld_or_forfeited': (
            'funds withheld',
            'withholding of payment',
            'payment withheld',
            'forced no pay',
            'no pay',
            'not payable',
            'non payable',
            'will not be paid',
            'not be paid',
        ),
        'campaign_or_account_paused': (
            'campaign paused',
            'pause campaign',
            'account paused',
            'pause account',
            'account suspension',
            'campaign suspension',
        ),
        'account_blocked_disabled_or_terminated': (
            'account fully blocked',
            'account blocked',
            'blocked account',
            'account disabled',
            'disable account',
            'account terminated',
            'terminate account',
        ),
        'partnership_suspended_or_terminated': (
            'partnership suspended',
            'suspension of partnership',
            'partnership terminated',
            'termination of partnership',
            'suspension or termination of partnership',
        ),
    }
    return any(phrase in text for phrase in consequence_phrases[consequence])


def _finding_has_supported_consequence(
    finding,
    profile: OfferProfile,
) -> bool:
    consequence = finding.enforcement_consequence
    basis = finding.consequence_policy_basis
    if consequence == 'none' or not basis.strip():
        return False
    if not _basis_supports_consequence(basis, consequence):
        return False

    enabled_rules = {
        rule.override_id: rule
        for rule in profile.internal_overrides
        if rule.enabled
    }
    controlling_rule_id = finding.controlling_internal_rule_id
    if controlling_rule_id:
        controlling_rule = enabled_rules.get(controlling_rule_id)
        if controlling_rule is None:
            return False
        if controlling_rule_id == GLOBAL_ENFORCEMENT_RULE_ID:
            finding_reason = _normalized_policy_text(
                f'{finding.policy_reason} {finding.evidence}'
            )
            supported_trigger = any(phrase in finding_reason for phrase in (
                'government angle',
                'government',
                'politician',
                'political figure',
                'celebrity',
                'cursing',
                'profanity',
                'swearing',
            ))
            return bool(
                supported_trigger
                and _contains_exact_policy_basis(
                    GLOBAL_ENFORCEMENT_SEVERE_BASIS,
                    controlling_rule.guidance,
                )
                and _contains_exact_policy_basis(
                    basis,
                    GLOBAL_ENFORCEMENT_SEVERE_BASIS,
                )
            )
        return _contains_exact_policy_basis(basis, controlling_rule.guidance)

    # The saved enforcement-severity rule is global and explicitly supersedes
    # consequence language in the source policy. If it is enabled, official
    # policy alone cannot make a finding red.
    if GLOBAL_ENFORCEMENT_RULE_ID in enabled_rules:
        return False
    return _contains_exact_policy_basis(basis, profile.official_guidelines)


def _status_for_findings(findings) -> str:
    if any(finding.severity == 'high' for finding in findings):
        return 'red'
    if findings:
        return 'yellow'
    return 'green'


def enforce_consequence_based_red(
    report: OfferComplianceResult,
    profile: OfferProfile,
) -> bool:
    """Downgrade unsupported high findings and recompute effective statuses."""
    downgraded = False
    for finding in report.findings:
        if finding.severity != 'high':
            continue
        if _finding_has_supported_consequence(finding, profile):
            continue
        finding.severity = 'medium'
        finding.enforcement_consequence = 'none'
        finding.consequence_policy_basis = ''
        finding.controlling_internal_rule_id = None
        downgraded = True

    if not downgraded:
        return False

    previous_status = report.overall_status
    report.overall_status = _status_for_findings(report.findings)
    if previous_status == 'red' and report.overall_status == 'yellow':
        report.summary = (
            'This review needs a fix or review, but the effective policy does not '
            'support a severe-consequence red result.'
        )

    source_findings = {
        'ad_copy': [finding for finding in report.findings if finding.source == 'ad_copy'],
        'creative': [finding for finding in report.findings if finding.source != 'ad_copy'],
    }
    for source_name, source_result in (
        ('creative', report.source_results.creative),
        ('ad_copy', report.source_results.ad_copy),
    ):
        if source_result is None:
            continue
        previous_source_status = source_result.status
        source_result.status = _status_for_findings(source_findings[source_name])
        if previous_source_status == 'red' and source_result.status == 'yellow':
            source_result.summary = (
                'This source needs a fix or review; no approved severe consequence was confirmed.'
            )

    if DOWNGRADE_LIMITATION not in report.limitations:
        report.limitations.append(DOWNGRADE_LIMITATION)
    return True
