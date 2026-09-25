# Released receiver templates (test fixtures)

Verbatim copies of receiver **templates** as they shipped in a past
`plugin-runtime` release, one pair per generation:

- `*.v0.91.2.template.mjs` — `plugin-runtime-v0.91.2`, the last release before
  the receivers became delegating shims.
- `*.v0.97.4.template.mjs` — `plugin-runtime-v0.97.4`, the last release of the
  first delegating-shim generation (`delegating-shim v1`), whose runtime ladder
  still read the Codex marketplace clone. ADR-0061 §Decision 3 replaced that
  ladder.

Recovered with:

```
git show <tag>:plugins/runtime/receivers/<name> > <name>.<version>.template.mjs
```

They exist so the installed-receiver classifier can be tested against bytes that
were genuinely released, rather than against a hand-written approximation that
would only prove the classifier agrees with itself.

They are checked in rather than read from git at test time on purpose: a test
that shells out to `git show <tag>` fails on a shallow clone or a tagless
checkout for an environmental reason, not a defect. The tests bind each fixture
to its entry in `plugins/runtime/data/released-receiver-shapes.json`, so a
fixture that drifted from the release it claims to be fails loudly instead of
silently certifying the wrong shape.

Do not edit these files. They record what a past release contained.
