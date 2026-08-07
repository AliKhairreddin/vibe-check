from __future__ import annotations

from pathlib import Path

from .models import OfferOverride, OfferProfileInput


POLICY_DIR = Path(__file__).with_name('guidelines')
CURRENT_POLICY_RATIONALE = (
    'Latest internal enforcement policy from “compliances_guidelines_2026-08-06.pdf,” '
    'which consolidates rules current as of July 29, 2026. It supersedes the original '
    'written source policy wherever the two conflict.'
)


def _rule(override_id: str, title: str, guidance: str) -> dict[str, object]:
    return {
        'override_id': override_id,
        'title': title,
        'guidance': guidance,
        'rationale': CURRENT_POLICY_RATIONALE,
        'enabled': True,
    }


def _common_rules(*, prohibit_agent_terms: bool = False) -> list[dict[str, object]]:
    agent_sentiment_guidance = (
        'Urgency, countdown, scarcity, and time-limited language are prohibited. Commission-based '
        'accusations against agents or carriers and claims that they hide information or discounts '
        'are prohibited. '
    )
    if prohibit_agent_terms:
        agent_sentiment_guidance += (
            'For this offer, the literal words “agent” and “agents” are prohibited in every script, '
            'image, on-screen text, and copy field, even when used positively or neutrally. Replace '
            'convenience claims such as “skip the agent” with wording such as “no forms, no phone '
            'calls.”'
        )
    else:
        agent_sentiment_guidance += (
            'Convenience framing and non-commission complaints are allowed, including “skip the '
            'agent,” paperwork complaints, slow service, or repeated-call complaints.'
        )

    return [
        _rule(
            'current-policy-scope',
            'Current policy scope and precedence',
            'Apply every current internal rule to visuals, video scripts, audio, on-screen text, '
            'primary text, headlines, and descriptions. These rules control wherever they conflict '
            'with the original written source guidelines.',
        ),
        _rule(
            'urgency-and-agent-sentiment',
            'Urgency and agent/carrier sentiment',
            agent_sentiment_guidance,
        ),
        _rule(
            'audience-and-fear-imagery',
            'Audience targeting and fear imagery',
            'Seniors may be targeted. Veterans, race, age, and gender targeting or rate claims are '
            'prohibited. Brief car-crash and house-fire imagery may be used, including as a hook, but '
            'blood, visible injury, or a depiction of someone dying is prohibited.',
        ),
        _rule(
            'refund-rebate-and-enforcement',
            'Refund, rebate, and enforcement severity',
            'The literal words “rebate” and “refund” are prohibited. Clear government-angle, celebrity, '
            'and cursing violations carry funds-withheld/account-paused risk. Other current-rule '
            'violations still reject the creative but do not by themselves withhold funds.',
        ),
    ]


OFFER_POLICY_SEEDS: dict[str, dict[str, object]] = {
    'acp': {
        'display_name': 'ACP',
        'official_file': 'general_publisher_ad_creative_guidelines.md',
        'is_default': True,
        'overrides': [
            *_common_rules(),
            _rule(
                'traffic-and-channel-rules',
                'Traffic and channel rules',
                'Traffic must be US domestic, age 18+, valid, directly supplied by consumers, and '
                'TCPA/California §17529.5/CAN-SPAM compliant. Prohibit bots, crawlers, incentivized '
                'traffic, co-registration, unapproved creatives or affiliates, inflated clicks, brand '
                'keyword bidding, spam, classifieds, offer bundling, virtual currency, copyrighted '
                'video, chat/DM promotion, substituted search results, popups, and search advertising.',
            ),
            _rule(
                'government-and-public-figures',
                'Government wording and public figures',
                'Prohibit real laws/regulations, government symbols, seals, insignia, department names, '
                'politicians, and government-news personalities. Incidental flags in natural settings '
                'are allowed; staged or political flag imagery is prohibited. “Program” is prohibited; '
                '“Initiative” and “Guidelines” are allowed. Every recognizable public figure, including '
                'niche creators, requires both face and voice/audio to be altered. Related background '
                'branding is prohibited.',
            ),
            _rule(
                'money-and-brand-context',
                'Money imagery and third-party brands',
                'Cash, checks, coins, or money-back imagery are prohibited when positioned as a result '
                'of the insurance offer. A separate, unrelated act of giving money may appear. Carrier '
                'colors or themes without names/logos are allowed. Carrier names require prior written '
                'approval, text-only use, and the exact lead-in “Compare quotes from multiple top '
                'carriers including”; logos remain prohibited.',
            ),
            _rule(
                'savings-discounts-and-pricing',
                'Savings, discounts, and price claims',
                '“Up to $500/yr,” “As low as $19/mo,” “From $19/mo,” and “$4,500 in savings over 5 '
                'years” are allowed. “You’ll get $X back in your pocket” is allowed only within those '
                'approved points and must not be personalized by name or geography. Exact discounts and '
                'named discount categories are allowed up to 80%. The auto-rate floor is $19/month. '
                'Direct and guaranteed rate/savings/qualification language is allowed. Daily or weekly '
                'price framing is prohibited.',
            ),
            _rule(
                'rate-disclaimer-sync',
                'Rate disclaimer timing',
                'Every price or rate mention in any creative or copy field must include “Average '
                'expenditure $89/month” (or equivalent). In video, the disclaimer must be visible at '
                'the exact moment every spoken or shown price occurs; one disclaimer cannot cover '
                'repeated price mentions at other times.',
            ),
            _rule(
                'testimonials-email-sms-domain',
                'Testimonials, messaging channels, and brand name',
                'Real-user first-person testimonials and quote/policy amounts are allowed without '
                'carrier brand names. Paid spokesperson ads require “Actor portrayal.” Email must use '
                'truthful headers/subjects, identify the offer and advertisement, include sender/address, '
                'suppression and opt-out controls, and a public non-proxy domain; prohibited alert, '
                'renewal, refund, law, Re:/Fwd:, and similar terms remain banned. SMS requires approval, '
                'consent, sender, cost disclosure, opt-out, and a bridge link. Do not use “AutoCoverage '
                'Pro” directly in creatives; white-label variants are allowed.',
            ),
        ],
    },
    'kissterra': {
        'display_name': 'Kissterra',
        'official_file': 'kissterra_connect_guidelines.md',
        'is_default': False,
        'overrides': [
            *_common_rules(prohibit_agent_terms=True),
            _rule(
                'government-wording',
                'Government imagery and wording',
                'Prohibit real laws, government symbols/seals, department names, politicians, and '
                'government-news personalities. Incidental flags are allowed; staged political flags '
                'are not. “Program” remains prohibited. “Initiative” and “Guidelines” are allowed, '
                'including “Low Cost Auto Insurance Initiative” and “Insurance Guidelines.”',
            ),
            _rule(
                'public-figure-treatment',
                'Kissterra public-figure treatment',
                'A-list/B-list/C-list actors and news anchors require an altered/different face, but '
                'their original audio may remain. A real unaltered celebrity face is prohibited. '
                'Financial creators are case-by-case: Dave Ramsey counts; Clark Howard, The Money Guy, '
                'and The React Bros may run unaltered because they are not broadly Europe-famous. '
                'PewDiePie and Anthony Hopkins count as celebrities. Donald Trump remains prohibited '
                'as a political figure regardless of alteration.',
            ),
            _rule(
                'money-brands-and-savings',
                'Money, brands, savings, and discounts',
                'Unrelated money-gift scenes are allowed; money imagery tied to a direct offer reward is '
                'not. Carrier names require prior written approval, text-only use, and the exact phrase '
                '“Compare quotes from multiple top carriers including”; logos are prohibited. “Up to '
                '$500/year back in your pocket” and “$4,500 in savings over 5 years” are allowed without '
                'name/geo personalization. Exact discounts and named categories are allowed up to 80%.',
            ),
            _rule(
                'rate-claims-and-disclaimer',
                'Rate claims and synchronized disclaimer',
                'The auto-rate floor is $19/month. Direct, absolute, guaranteed rate/savings/qualification '
                'claims are allowed. Daily/weekly framing is prohibited. Every rate in copy must appear '
                'alongside “Average expenditure $89/month” (or equivalent). In video the disclaimer must '
                'appear at the same moment every rate is spoken or shown.',
            ),
            _rule(
                'testimonials-and-domain',
                'Testimonials and domain/brand usage',
                'First-person testimonials are allowed for real Kissterra users, including quote/policy '
                'amounts but no carrier brand names. Paid spokesperson-style ads require “Actor '
                'portrayal.” Do not use “Kissterra Connect” or “QuoteScan” directly in creatives or '
                'domains; white-label affiliate variants are allowed.',
            ),
            _rule(
                'email-and-sms',
                'Email and SMS requirements',
                'Keep the source email rules for truthful headers/subjects, offer name in From, '
                'Advertisement identification, sender/address, suppression, unsubscribe, and public '
                'non-proxy domains. SMS requires prior approval, consent, sender name, carrier-cost '
                'disclosure, opt-out, and a bridge page rather than a direct Kissterra-domain link.',
            ),
        ],
    },
    'lead-economy': {
        'display_name': 'Lead Economy',
        'official_file': 'coverage_professor_ad_creative_guidelines.md',
        'is_default': False,
        'overrides': [
            *_common_rules(),
            _rule(
                'government-wording-and-flags',
                'Government wording, programs, and flags',
                'Government angles, real laws/regulations, government insignia, department names, '
                'politicians, police/law enforcement, government-news personalities, SNAP/EBT, food '
                'stamps, Social Security, DMV, free insurance, and fake government acts/rules remain '
                'prohibited. Incidental flags in natural settings are allowed; staged/political flags '
                'are not. “Program” and “Initiative” are prohibited; “Insurance Guidelines” is allowed.',
            ),
            _rule(
                'public-figure-alteration',
                'Public-figure alteration',
                'Every recognizable public figure, including niche financial creators, may be used only '
                'when both face and voice/audio are altered together. Changing only one is insufficient. '
                'Background logos tied to the personality are prohibited.',
            ),
            _rule(
                'money-and-brand-context',
                'Money imagery and brand context',
                'Money imagery is prohibited when paired with money-back language or presented as an '
                'insurance-offer reward. A separate unrelated act of giving cash may appear. Carrier '
                'names/logos and offer logos are prohibited; carrier-themed color sets without an '
                'identifier are allowed. Costco, Walmart, and Sam’s Club are prohibited even as '
                'background locations. Unrelated incidental brands such as a storefront may appear.',
            ),
            _rule(
                'discounts-and-rate-claims',
                'Discounts and rate claims',
                '“$X back in your pocket” is prohibited. Discounts require qualified language such as '
                '“up to,” with a ceiling of 60%; named discount categories are allowed. The auto-rate '
                'floor is $31/month. Direct, absolute, and guaranteed rate/savings/qualification claims '
                'are allowed, including “you qualify” and “everybody will get car insurance at $31/month.”',
            ),
            _rule(
                'testimonials-domain-and-standing-rules',
                'Testimonials, domain, and standing restrictions',
                'Testimonials are fully permitted without an additional offer-specific disclaimer. Do '
                'not use CoverageProfessor.com directly; white-label domains are allowed. Toilets and '
                'bodily/human waste, branded sports, and cursing remain prohibited. Generic off-brand '
                'sports are allowed.',
            ),
        ],
    },
    'smart-financial': {
        'display_name': 'Smart Financial',
        'official_file': 'smart_financial_guidelines.md',
        'is_default': False,
        'overrides': [
            *_common_rules(),
            _rule(
                'government-wording',
                'Government wording and flags',
                'Prohibit real laws, symbols, department names, politicians, government-news '
                'personalities, and government buildings. Incidental flags are allowed; staged/political '
                'flags are not. “Program,” “Initiative,” and “Insurance Guidelines” wording are all '
                'prohibited for Smart Financial.',
            ),
            _rule(
                'public-figure-alteration',
                'Public-figure alteration',
                'Every recognizable public figure, including niche creators, requires both face and '
                'voice/audio to be altered together. Changing only one is insufficient.',
            ),
            _rule(
                'money-brands-and-incentives',
                'Money, brands, and incentives',
                'Money imagery used as savings/reward texture is prohibited; a separate unrelated act of '
                'giving money may appear. Carrier names/logos, misspellings intended to evade review, '
                'Smart Financial branding, Costco, Walmart, and Sam’s Club are prohibited. “$X back in '
                'your pocket,” gas/prepaid/EBT cards, and imagery implying stolen personal items are '
                'covered by auto insurance are prohibited.',
            ),
            _rule(
                'discounts-and-rate-claims',
                'Discounts and rate claims',
                'Discounts require qualified language such as “up to,” with a ceiling of 50%; named '
                'discount categories are prohibited. Monthly floors are Auto $39, Home $31, Life $29, '
                'and Commercial $25. Direct, absolute, and guaranteed rate/savings/qualification claims '
                'are allowed. Use monthly or yearly framing, never daily or weekly.',
            ),
            _rule(
                'language-testimonials-and-domain',
                'Language, testimonials, and domain usage',
                'Senior targeting is allowed; veteran/race/age/gender targeting remains prohibited. Ads '
                'must be in English. Testimonials are permitted, but a visible “Rates may vary” '
                'disclaimer must appear somewhere in the video and AI-made ads require a visible AI '
                'disclosure. Do not use Smart Financial, SmartFinancial, MidasRates, or their domains '
                'directly; white-label domains are allowed.',
            ),
        ],
    },
}


def seeded_offer_inputs() -> dict[str, OfferProfileInput]:
    profiles: dict[str, OfferProfileInput] = {}
    for offer_id, seed in OFFER_POLICY_SEEDS.items():
        official_path = POLICY_DIR / str(seed['official_file'])
        profiles[offer_id] = OfferProfileInput(
            display_name=str(seed['display_name']),
            official_guidelines=official_path.read_text(encoding='utf-8').strip(),
            internal_overrides=[
                OfferOverride.model_validate(rule)
                for rule in seed['overrides']  # type: ignore[union-attr]
            ],
            enabled=True,
            is_default=bool(seed['is_default']),
        )
    return profiles
