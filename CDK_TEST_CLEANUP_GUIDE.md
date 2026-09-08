# CDK test cleanup guide (for the other TAK-NZ infra repos)

This is guidance for agents maintaining the sibling CDK repos — **base-infra**,
**auth-infra**, **tak-infra**, **CloudTAK**, and any other `cdk/`-style stack —
on how to prune their CDK test suites down to tests that actually earn their
keep.

It was written after adding a deliberately **lean** CDK suite to
TAKTeamManager (`cdk/test/`), which is the model referenced throughout. The
goal is not "more tests" or "fewer tests" — it is **only tests that can fail
for a real reason**.

---

## The one rule

> A CDK test is worth keeping only if it can fail when something is **wrong**,
> and cannot fail merely because the infrastructure **changed on purpose** or a
> CDK library version bumped.

Everything below is a corollary of that rule.

---

## KEEP these (high signal)

1. **Decision-logic unit tests.**
   Pure functions with interesting boundaries: context/override resolution,
   config validation, the strict-boolean feature-flag helper (a flag is true
   ONLY for the exact string `'true'`), naming/derivation helpers, tag
   builders. These encode rules a refactor can silently break.
   - Model: `cdk/test/unit/context-overrides.test.ts` — pins that `'true'`/`true`
     are true and `'TRUE'`/`'1'`/`' true '`/`'yes'` are **not**. A refactor to
     `Boolean(raw)` fails this immediately.

2. **Synth-smoke tests — the single highest-value CDK test.**
   Synthesize the stack for **each environment** (`dev-test`, `prod`) and **each
   image path** (local `DockerImageAsset` vs prebuilt ECR), and assert only that
   synth does not throw. A stack that no longer synthesizes is the failure that
   actually happens in practice; this catches it in seconds.
   - Model: `cdk/test/unit/stack-synth.test.ts`'s `synthesizes for …` cases.
   - Building `Template.fromStack(stack)` **is** the synth, so these come nearly
     for free alongside the behavioral assertions below.

3. **Behavioral / safety-property template assertions.**
   `Template.fromStack` assertions on properties where the assertion means
   something beyond restating the construct code:
   - **Prod safety shape**: prod DB has `DeletionProtection: true` and the
     expected provisioned instance count; dev is serverless / destroyable.
     (Shipping prod without deletion protection is a real, dangerous
     regression.)
   - **Feature-flag-gated wiring**: a flag actually changes the template — e.g.
     an S3 `EnvironmentFile` is attached **iff** the flag is on, `usePreBuiltImages`
     switches the image source. Assert both the on and off branches, AND that a
     near-miss string (`'TRUE'`) does **not** arm it.
   - **Cross-stack export names**: the `TAK-<Env>-<Component>-*` output/export
     names other stacks import by name — a rename here breaks a consumer stack,
     so the contract is worth pinning.
   - Model: the `database safety shape`, `feature-flag-gated wiring`, and
     `stack outputs` blocks in `stack-synth.test.ts`.

---

## DELETE these (low signal, high maintenance)

1. **Full-template snapshot tests** (`toMatchSnapshot()` on an entire
   synthesized template).
   They break on every intentional change and every `aws-cdk-lib` bump, get
   regenerated without anyone reading the diff, and catch essentially nothing.
   Delete outright. (A *targeted* `hasResourceProperties` assertion on the few
   properties that matter replaces them — see KEEP #3.)

2. **Tautological "config has property X" tests.**
   e.g. `expect(config.stackName).toBe('DevTest')`,
   `expect(config.database.instanceClass).toBe('db.t3.small')`.
   These assert that the config file contains the values the config file
   contains. They pass because someone typed the same literal twice, and they
   fail the moment you legitimately change the config — a pure maintenance tax
   with zero bug-catching value. Delete them. (If a config value has a *rule*
   — "prod CPU must be ≥ dev CPU", "instanceCount ≥ 1" — test the RULE, not the
   literal.)

3. **One-assertion-per-resource restatements.**
   e.g. "the ALB has a target group", "the health check path is `/health`",
   "there are 2 subnets". If the test just re-asserts a string/shape you wrote
   three lines away in the construct, it passes because you typed it twice.
   Keep at most a couple as smoke coverage (or rely on the synth-smoke +
   resource **count** checks); delete the wall of them.

4. **Tests that assert CDK/CloudFormation's own behavior.**
   e.g. asserting a `Ref`/`Fn::GetAtt` shape, that a logical ID has a certain
   hash, that `removalPolicy` produced a `DeletionPolicy` attribute. You're
   testing the framework, not your stack. Delete.

---

## The litmus test before keeping any CDK test

Ask, in order:

1. **Could this fail for a reason other than a real defect?** (a purposeful
   infra change, a library bump, a regenerated snapshot) → if yes, it's a
   maintenance tax; delete or narrow it.
2. **Does it assert something I typed verbatim nearby?** → tautology; delete.
3. **If I introduce the bug it's meant to catch, does it actually go red?** →
   if you can't state the bug, the test isn't guarding anything. (This is the
   "verify the guard bites" discipline: temporarily break it and confirm the
   failure is the *expected assertion*, not a mount/synth error.)

---

## Recommended target shape per repo

Mirror TAKTeamManager's `cdk/`:

- `test/unit/` — decision-logic unit tests + a `stack-synth` file (synth-smoke +
  behavioral/safety assertions).
- `test/__helpers__/` — a `synthTemplate(envType, extraContext)` helper that
  reads the env's `cdk.json` context block, applies overrides, instantiates the
  stack with an **explicit** `env: { account, region }` (needed so
  `stack.availabilityZones` resolves real AZs instead of the agnostic-stack
  dummies), and returns `Template.fromStack(stack)`.
- `jest.config.json` — `@swc/jest` transform, `roots: ["<rootDir>/test"]`,
  `testMatch: ["**/*.test.ts"]`, `collectCoverageFrom: ["lib/**/*.ts",
  "!lib/**/*.d.ts"]`, and `testPathIgnorePatterns` excluding
  `__helpers__`/`__fixtures__`.
- `package.json` scripts — `test`, `test:unit`, `test:coverage`, `test:watch`,
  each prefixed with `unset CDK_DEFAULT_ACCOUNT && unset CDK_DEFAULT_REGION`
  (so a developer's shell env doesn't leak a real account/region into synth).

### Two script bugs to check for while you're in there

Both were present in TAKTeamManager's `cdk/` and are easy to have copied around:

- **Missing `test:coverage` script.** `npm run test:coverage` failing with
  `Missing script` means CI/coverage never actually ran. Add it.
- **`clean` script that errors on a missing dir.** A `clean` like
  `find bin lib test -name '*.js' …` throws `find: 'test': No such file or
  directory` when there is no `test/` dir yet, which aborts a
  `clean && build && test` chain. Make it resilient, e.g.:
  ```
  find bin lib test -type f \( -name '*.js' -o -name '*.d.ts' \) -not -path '*/node_modules/*' -delete 2>/dev/null; rm -rf cdk.out/*
  ```

---

## On coverage thresholds

The sibling repos do **not** set a Jest `coverageThreshold`, and neither does
TAKTeamManager — `test:coverage` reports, it doesn't gate. Don't add an
aspirational line-percentage gate: a lean, well-chosen suite that happens to hit
90%+ (because synth-smoke exercises most of the stack) is good, but a threshold
pushes people toward writing the tautological tests above just to move a number.
Gate on **synth succeeding** and the behavioral assertions passing, not on a
coverage percentage.

---

## Not a mandate

This is guidance, not a spec. If a repo has a genuinely load-bearing test that
doesn't fit a category above, keep it — but be able to name the bug it catches.
When in doubt, prefer deleting a test you can't justify over keeping one "just
in case": an unjustifiable test is a future false alarm someone will silence by
regenerating it, which trains the team to ignore red.
