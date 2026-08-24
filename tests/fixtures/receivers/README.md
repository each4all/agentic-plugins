# Released receiver templates (test fixtures)

Verbatim copies of receiver **templates** as they shipped in
`plugin-runtime-v0.91.2` — the last release before the receivers became
delegating shims. Recovered with:

```
git show plugin-runtime-v0.91.2:plugins/runtime/receivers/<name> > <name>.v0.91.2.template.mjs
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
