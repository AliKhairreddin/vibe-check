#!/usr/bin/env python3
"""Reviewed v5 policy partition; dry-run by default, atomic and guarded on apply.

Input is the private audit backup: {clientId: {profile: offers:get result}}.
The content hashes pin the exact production sources audited on 2026-10-14.
No LLM rewrites, guessed Home prices, or edits to historical reviews.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess

SOURCE_HASHES = {
    'lead-economy': '1352ab7cbc5f1eb724dab64e0c9693f1c7d9b6c37f8f2001885237504ca2c8c4',
    'kissterra': '283946b649af299949f933d10aa5b22cf12df2017a89ea3593df95eb867a7ff1',
    'smart-financial': '9b4b02c2ce2b234f9d9bd0d362e7afdd5845a2292cd413d8aaa8625878055a74',
}
FEAR = 'Brief car-crash and house-fire imagery may be used, including as a hook, but blood, visible injury, or a depiction of someone dying is prohibited.'


def replace_once(text, old, new):
    assert text.count(old) == 1, f'Expected one exact source clause: {old}'
    return text.replace(old, new)


def partition(client, source):
    digest = hashlib.sha256(json.dumps([source['official_guidelines'], source['internal_overrides']], sort_keys=True).encode()).hexdigest()
    assert source['version'] == 5 and digest == SOURCE_HASHES[client], f'Unreviewed source for {client}; audit again.'
    original_rules = [{('overrideId' if k == 'override_id' else k): v for k, v in r.items()} for r in source['internal_overrides']]
    rules = {r['overrideId']: copy.deepcopy(r) for r in original_rules}
    shared = source['official_guidelines']
    auto_lines = []
    home_lines = []
    scoped_rules = {'auto-insurance': [], 'home-insurance': []}
    draft_lines = {}

    def move_lines(predicate, count):
        nonlocal shared
        lines = shared.splitlines()
        moved = [line for line in lines if predicate(line)]
        assert len(moved) == count, (client, count, moved)
        shared = '\n'.join(line for line in lines if not predicate(line))
        return moved

    def add_rule(vertical, original, identifier, title, guidance):
        scoped_rules.setdefault(vertical, []).append({**original, 'overrideId': identifier, 'title': title, 'guidance': guidance})

    audience = rules['audience-and-fear-imagery']
    audience['guidance'] = replace_once(audience['guidance'], FEAR, 'Blood, visible injury, or a depiction of someone dying is prohibited.')
    for vertical, scene in [('auto-insurance', 'car-crash'), ('home-insurance', 'house-fire')]:
        add_rule(vertical, audience, vertical + '-fear-imagery', 'Permitted brief accident imagery',
                 f'Brief {scene} imagery may be used, including as a hook, but blood, visible injury, or a depiction of someone dying is prohibited.')

    if client == 'lead-economy':
        auto_lines += move_lines(lambda line: line.startswith(('- NO rates under', '- No free auto insurance', '- NO NEGATIVE SENTIMENT TOWARDS AUTO')), 3)
        shared = replace_once(shared, ', Free Auto Insurance,', ',')
        rate = rules['discounts-and-rate-claims']
        auto_part = 'The auto-rate floor is $31/month. Direct, absolute, and guaranteed rate/savings/qualification claims are allowed, including “you qualify” and “everybody will get car insurance at $31/month.”'
        rate['guidance'] = replace_once(rate['guidance'], ' ' + auto_part, '')
        add_rule('auto-insurance', rate, 'auto-rate-claims', 'Auto rate claims', auto_part)
    elif client == 'kissterra':
        auto_lines += move_lines(lambda line: line.startswith(('| Use daily or weekly price points,', '| **Approved Price Points')), 3)
        shared = replace_once(shared, ', Car Insurance Notice', '')
        shared = replace_once(shared, ', Auto Member', '')
        shared = replace_once(shared, ', Auto Insurance, Renewal Notice.', ', Renewal Notice.')
        auto_lines += ['- Prohibited email From lines include “Car Insurance Notice” and “Auto Member”; prohibited Subject examples include “Auto Insurance, Renewal Notice”.']
        shared = replace_once(shared, ', State Auto Reduction Policy.', '.')
        auto_lines += ['- “State Auto Reduction Policy” is prohibited.']
        government = rules['government-wording']
        government['guidance'] = replace_once(government['guidance'], ', including “Low Cost Auto Insurance Initiative” and “Insurance Guidelines.”', ', including “Insurance Guidelines.”')
        add_rule('auto-insurance', government, 'auto-initiative-wording', 'Auto initiative wording', '“Low Cost Auto Insurance Initiative” is allowed.')
        money = rules['money-brands-and-savings']
        savings = '“Up to $500/year back in your pocket” and “$4,500 in savings over 5 years” are allowed without name/geo personalization.'
        money['guidance'] = replace_once(money['guidance'], ' ' + savings, '')
        add_rule('auto-insurance', money, 'auto-approved-savings', 'Approved Auto savings examples', savings)
        scoped_rules['auto-insurance'].append(rules.pop('rate-claims-and-disclaimer'))
    else:
        categories = move_lines(lambda line: line.startswith('| **') and any(line.startswith('| **' + category + '**') for category in ['Auto', 'Home/Renters', 'Health', 'Life', 'Commercial']), 5)
        by_category = {line.split('**')[1]: line for line in categories}
        auto_lines.append(by_category['Auto'])
        home_lines.append(by_category['Home/Renters'])
        draft_lines = {'renters-insurance': [by_category['Home/Renters']], 'health-insurance': [by_category['Health']],
                       'life-insurance': [by_category['Life']], 'business-insurance': [by_category['Commercial']]}
        shared = replace_once(shared, '## Category-Specific Requirements\n\n| Category | Requirements |\n| --- | --- |', '')
        history = "24. **Consumer History:** Do not state or imply anything about the consumer's driving record or claims history."
        shared = replace_once(shared, history, "24. **Consumer History:** Do not state or imply anything about the consumer's claims history.")
        auto_lines.append("- Do not state or imply anything about the consumer's driving record.")
        auto_lines += move_lines(lambda line: any(token in line for token in [
            'stolen from a car', "your car's year", 'US/[State] drivers', 'New car insurance crisis rules',
            'Save up to 50% on auto', 'Save up to $700', 'switching auto insurance', 'bundle your auto insurance',
            'Depending on your driving record', 'multi-car discounts', 'safe driving discounts',
        ]), 11)
        money = rules['money-brands-and-incentives']
        money['guidance'] = replace_once(money['guidance'], ', and imagery implying stolen personal items are covered by auto insurance are prohibited.', ' are prohibited.')
        add_rule('auto-insurance', money, 'auto-stolen-property', 'Auto personal property claims', 'Imagery implying stolen personal items are covered by auto insurance is prohibited.')
        rate = rules['discounts-and-rate-claims']
        rate['guidance'] = replace_once(rate['guidance'], ' Monthly floors are Auto $39, Home $31, Life $29, and Commercial $25.', '')
        for vertical, category, floor in [('auto-insurance', 'Auto', 39), ('home-insurance', 'Home', 31), ('life-insurance', 'Life', 29), ('business-insurance', 'Commercial', 25)]:
            add_rule(vertical, rate, vertical + '-rate-floor', category + ' monthly rate floor', f'The {category} rate floor is ${floor}/month.')

    if client != 'smart-financial':
        home_lines = ['The saved source does not specify a Home rate floor or a Home-specific price disclaimer. Do not apply Auto pricing approvals or disclaimers to Home insurance.']
    sections = {'auto-insurance': auto_lines, 'home-insurance': home_lines, **draft_lines}
    verticals = []
    for vertical, lines in sections.items():
        title = vertical.replace('-', ' ').title()
        verticals.append({'verticalId': vertical, 'enabled': vertical in {'auto-insurance', 'home-insurance'},
                         'officialGuidelines': '# ' + title + '\n\n' + '\n'.join(lines),
                         'internalOverrides': scoped_rules.get(vertical, [])})
    return {'clientId': client, 'expectedVersion': 5, 'expectedGuidelines': source['official_guidelines'],
            'expectedOverrides': original_rules, 'sharedGuidelines': shared.strip(),
            'sharedOverrides': list(rules.values()), 'verticals': verticals}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup', type=Path)
    parser.add_argument('--plan', type=Path, help='Write the reviewable migration payload (mode 0600).')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    backup = json.loads(args.backup.read_text())
    plan = {'assignments': [partition(client, backup[client]['profile']) for client in SOURCE_HASHES]}
    if args.plan:
        args.plan.write_text(json.dumps(plan, indent=2, ensure_ascii=False))
        args.plan.chmod(0o600)
    for item in plan['assignments']:
        print(f"{item['clientId']}: shared v5 → v6; {len(item['sharedOverrides'])} shared rules")
        for policy in item['verticals']:
            print(f"  {policy['verticalId']}: {'active' if policy['enabled'] else 'draft'}; {len(policy['internalOverrides'])} scoped rules")
    if args.apply:
        result = subprocess.run(['pnpm', 'exec', 'convex', 'run', '--prod', 'verticals:assignLegacy', json.dumps(plan)],
                                env={**os.environ, 'CONVEX_DEPLOYMENT': 'prod:energetic-partridge-813'}, check=True, text=True, capture_output=True)
        print(result.stdout)
    else:
        print('Dry run only. No data changed.')


if __name__ == '__main__':
    main()
