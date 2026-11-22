// Casebook から写した受け渡しの契約（casebook-copies.json。段K10。CA-073）が、記録のとおりであること。
// 写したファイルは、carte では直さない。直すときは、Casebook で直して、scripts/sync-casebook-contract.mjs で写し直す。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkCopies, readManifest } from './sync-casebook-contract.mjs';

test('写したファイルは、すべて記録（sha256）と同じ', () => {
  const problems = checkCopies();
  assert.deepEqual(problems, [], `記録と違うファイル：\n${problems.map((p) => `${p.path}：${p.reason}`).join('\n')}`);
});

test('写し元の commit と、写し元のパスが記録されている。写し先は、契約の文書・固定のテスト用パケット・core の casebook/ の下だけ', () => {
  const manifest = readManifest();
  assert.equal(manifest.source, 'clinical-casebook');
  assert.match(manifest.commit, /^[0-9a-f]{40}$/);
  for (const f of manifest.files) {
    assert.equal(typeof f.from, 'string', f.path);
    assert.match(f.path, /^(docs\/casebook-contract\/|fixtures\/casebook-handoff\/|packages\/core\/src\/casebook\/(handoff|ids|schema|lint|text)\/)/u, f.path);
  }
});
