#!/usr/bin/env python3
"""Split a Float v2 backup without changing IDs or losing media references."""
import argparse
import base64
import collections
import copy
import hashlib
import json
import re
import zipfile
from pathlib import Path

APP_KEY = 'ai_phone_custom_apps_v1'

def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')

def refs(value):
    found = set()
    if isinstance(value, dict):
        if value.get('__aiPhoneMediaRef') is True:
            found.add(value['ref'])
        for child in value.values():
            found.update(refs(child))
    elif isinstance(value, list):
        for child in value:
            found.update(refs(child))
    elif isinstance(value, str) and value.lstrip().startswith(('[', '{')):
        try:
            found.update(refs(json.loads(value)))
        except (ValueError, RecursionError):
            pass
    return found

def record_count(payload):
    return sum(sum(len(store['records']) for store in source['stores'])
               if source['type'] == 'indexeddb' else len(source['records'])
               for source in payload['sources'])

def restore_urls(value, source):
    if isinstance(value, dict):
        if value.get('__aiPhoneMediaRef') is True:
            assert value['encoding'] == 'dataurl', 'App assets must restore as data URLs'
            data = source.read('media/' + value['ref'] + '.bin')
            return 'data:' + value['mimeType'] + ';base64,' + base64.b64encode(data).decode()
        return {k: restore_urls(v, source) for k, v in value.items()}
    if isinstance(value, list):
        return [restore_urls(v, source) for v in value]
    return value

def write_backup(path, payloads, original, source):
    stats = collections.OrderedDict()
    used_refs = set()
    for payload in payloads.values():
        mid = payload['moduleId']
        stat = stats.setdefault(mid, {'id': mid, 'label': next(m['label'] for m in original['modules'] if m['id'] == mid), 'records': 0, 'bytes': 0})
        stat['records'] += record_count(payload)
        stat['bytes'] += len(encoded(payload))
        used_refs.update(refs(payload))
    manifest = {k: v for k, v in original.items() if k not in ('modules', 'totalBytes', 'totalRecords')}
    manifest['modules'] = list(stats.values())
    manifest['totalRecords'] = sum(m['records'] for m in stats.values())
    manifest['totalBytes'] = sum(m['bytes'] for m in stats.values()) + sum(source.getinfo('media/' + r + '.bin').file_size for r in used_refs)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as output:
        output.writestr('manifest.json', encoded(manifest))
        for name, payload in payloads.items():
            output.writestr(name, encoded(payload))
        for ref in sorted(used_refs):
            name = 'media/' + ref + '.bin'
            output.writestr(name, source.read(name))
    return {'records': manifest['totalRecords'], 'media': len(used_refs), 'bytes': path.stat().st_size}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.backup) as source:
        manifest = json.loads(source.read('manifest.json'))
        assert manifest['format'] == 'ai-phone-backup' and manifest['version'] == 2
        assert not manifest.get('mediaExcluded'), 'Use a full backup including media'
        assert source.testzip() is None
        payloads = {n: json.loads(source.read(n)) for n in source.namelist() if n.startswith('modules/') and n.endswith('.json')}
        for ref in set().union(*(refs(p) for p in payloads.values())):
            data = source.read('media/' + ref + '.bin')
            assert hashlib.sha256(data).hexdigest() == ref, 'Invalid media hash'
        preload, usage, personal, desktop, chat = {}, {}, {}, {}, {}
        app_record = None
        for name, payload in payloads.items():
            target = usage if payload['moduleId'] == 'apps' else personal
            reduced = copy.deepcopy(payload)
            for index, src in enumerate(reduced['sources']):
                if src['type'] not in ('kv', 'localStorage'):
                    continue
                rows = []
                for row in src['records']:
                    if row['key'] == APP_KEY:
                        assert app_record is None
                        app_record = copy.deepcopy(row)
                        preload[name] = {'moduleId': 'apps', 'sources': [{'type': src['type'], 'records': [copy.deepcopy(row)]}]}
                    else:
                        rows.append(row)
                src['records'] = rows
            # Empty IndexedDB stores still carry schema and must survive splitting.
            target[name] = reduced
            if payload['moduleId'] == 'desktop':
                desktop[name] = copy.deepcopy(payload)
            if payload['moduleId'] == 'chat':
                chat[name] = copy.deepcopy(payload)
        assert app_record is not None
        apps = json.loads(app_record['value'])
        assert len({app['id'] for app in apps}) == len(apps)
        all_without_apps = {**personal, **usage}
        groups = {'01-apps-preload.zip': preload, '02-app-usage.zip': usage,
                  '03-personal-data.zip': personal, '04-personal-all-without-app-code.zip': all_without_apps,
                  '05-desktop-theme.zip': desktop, '06-chat-records.zip': chat}
        report = {'source': args.backup.name, 'applications': len(apps), 'packages': {}}
        for filename, group in groups.items():
            report['packages'][filename] = write_backup(args.output / filename, group, manifest, source)
        # Conventional app packages are useful for editing/reinstalling, but the host
        # generates new runtime IDs on ordinary installation. Preload backup preserves IDs.
        package_dir = args.output / 'individual-apps'
        package_dir.mkdir(exist_ok=True)
        report['apps'] = []
        for index, raw in enumerate(apps, 1):
            app = restore_urls(raw, source)
            filename = f'{index:02d}-' + re.sub(r'[^\w\-.]+', '-', app['name']).strip('-') + '.zip'
            path = package_dir / filename
            app_manifest = copy.deepcopy(app['manifest'])
            entry = app_manifest.get('entry') or 'index.html'
            with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as output:
                output.writestr('manifest.json', encoded(app_manifest))
                output.writestr(entry, app['entryHtml'])
                for asset in app.get('assets', {}).values():
                    asset_path = asset['path']
                    assert not asset_path.startswith('/') and '..' not in Path(asset_path).parts
                    if asset_path in ('manifest.json', entry):
                        continue
                    url = asset['dataUrl']
                    assert url.startswith('data:') and ';base64,' in url
                    output.writestr(asset_path, base64.b64decode(url.split(',', 1)[1]))
            report['apps'].append({'name': app['name'], 'id': app['id'], 'file': 'individual-apps/' + filename, 'assets': len(app.get('assets', {}))})
        # Prove partitioning is lossless at the record level, including original strings.
        for name, original in payloads.items():
            parts = [group[name] for group in (preload, usage, personal) if name in group]
            original_rows = sorted(encoded(s) for s in original['sources'] if s['type'] == 'indexeddb')
            restored_rows = sorted(encoded(s) for part in parts for s in part['sources'] if s['type'] == 'indexeddb')
            assert original_rows == restored_rows
            before = sorted(encoded(r) for s in original['sources'] if s['type'] != 'indexeddb' for r in s['records'])
            after = sorted(encoded(r) for part in parts for s in part['sources'] if s['type'] != 'indexeddb' for r in s['records'])
            assert before == after
        report['validation'] = 'ZIP integrity, all media hashes, unique app IDs, and lossless record partition verified'
        (args.output / 'inventory.json').write_bytes(encoded(report))
        print(json.dumps({k: v for k, v in report.items() if k != 'apps'}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
