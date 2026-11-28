/**
 * `1790800000000_approval-email-activation-text.cjs` rewrites two phrases of the access_request_approved email. The
 * phrases are duplicated in database/init.js (the seed for a new database). This pins them together, and checks the
 * migration only replaces the phrases (an administrator-edited body keeps its edits) and is reversible.
 */
const fs = require('fs');
const path = require('path');
const migration = require('../1790800000000_approval-email-activation-text.cjs');
const initSource = fs.readFileSync(path.join(__dirname, '..', '..', 'init.js'), 'utf8');
function sqlOf(fn) {
  const statements = [];
  fn({ sql: (s) => statements.push(s) });
  return statements.join('\n');
}
describe('approval email activation text migration', () => {
  const up = sqlOf(migration.up);
  const down = sqlOf(migration.down);
  it('replaces phrases with replace(), scoped to access_request_approved', () => {
    expect(up).toContain("WHERE template_key = 'access_request_approved'");
    expect(up).toContain('replace(body_template');
    expect(up).not.toMatch(/SET body_template = \$tpl\$/);
  });
  it('the new phrase is what the seed for a new database uses, and the old one is gone from it', () => {
    const newPhrase = up.match(/\$new\$(.*?)\$new\$/s)[1];
    const oldPhrase = up.match(/\$old\$(.*?)\$old\$/s)[1];
    expect(initSource).toContain(newPhrase);
    expect(initSource).not.toContain(oldPhrase);
    expect(oldPhrase).toContain('Apple or Google');
    expect(newPhrase).toContain('24 hours');
  });
  it('down swaps the two phrases back', () => {
    const [, o1, n1] = up.match(/replace\(body_template, \$old\$(.*?)\$old\$, \$new\$(.*?)\$new\$\)/s);
    const [, n2, o2] = down.match(/replace\(body_template, \$new\$(.*?)\$new\$, \$old\$(.*?)\$old\$\)/s);
    expect([n2, o2]).toEqual([n1, o1]);
  });
});
