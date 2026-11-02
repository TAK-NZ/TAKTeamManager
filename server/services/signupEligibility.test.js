const { ORGANISATION_JOIN, buildEligibilityConditions } = require('./signupEligibility');

// The behaviour of this SQL is proven against real Postgres by
// signupEligibility.integration.test.js. These tests cover what can be checked
// without a database: that the placeholders are wired to the right positions
// and that the rules which must never be dropped are present.
describe('buildEligibilityConditions', () => {
  it('binds the code and domain at the requested positions', () => {
    const sql = buildEligibilityConditions({ codeParam: 4, domainParam: 7 });
    expect(sql).toContain('sc.code = $4');
    expect(sql).toContain('oad.domain = $7');
    expect(sql).not.toMatch(/\$[1235689]\b/);
  });

  it('uses the code placeholder in both the own-code and Organisation-code arms', () => {
    const sql = buildEligibilityConditions({ codeParam: 1, domainParam: 2 });
    expect(sql.split('sc.code = $1')).toHaveLength(3);
  });

  it('keeps the joinable, public and private-ancestor rules', () => {
    const sql = buildEligibilityConditions({ codeParam: 1, domainParam: 2 });
    expect(sql).toContain('t.can_join = true');
    expect(sql).toContain("t.visibility = 'public'");
    expect(sql).toContain("anc.visibility = 'private'");
  });

  it('ANDs the domain restriction after the code gate rather than ORing it', () => {
    const sql = buildEligibilityConditions({ codeParam: 1, domainParam: 2 });
    // The code gate is one parenthesised group; the domain restriction is a
    // separate, following AND group -- never an OR arm inside the gate.
    expect(sql).toMatch(/\)\s+AND \(\s+NOT EXISTS \(SELECT 1 FROM org_allowed_domains/);
    expect(sql.indexOf('org_allowed_domains')).toBeGreaterThan(sql.lastIndexOf('sc.code = $1'));
  });

  it('reads the flag through COALESCE so NULL (a Sub_Team or un-migrated row) means false', () => {
    const sql = buildEligibilityConditions({ codeParam: 1, domainParam: 2 });
    const reads = sql.match(/org\.signup_code_covers_sub_teams/g) || [];
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(sql.match(/COALESCE\(org\.signup_code_covers_sub_teams, false\)/g)).toHaveLength(reads.length);
  });

  it.each([
    [{ codeParam: 0.5, domainParam: 2 }],
    [{ codeParam: 1, domainParam: '2' }],
    [{ codeParam: undefined, domainParam: 2 }],
    [{}]
  ])('rejects non-integer parameter positions (%j)', (params) => {
    expect(() => buildEligibilityConditions(params)).toThrow(TypeError);
  });
});

describe('ORGANISATION_JOIN', () => {
  it('exposes the Organisation id, name, prefix and flag as "org"', () => {
    expect(ORGANISATION_JOIN).toContain('signup_code_covers_sub_teams');
    expect(ORGANISATION_JOIN).toMatch(/\) org ON true$/);
  });
});
